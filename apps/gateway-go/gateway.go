package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type config struct {
	Center            string        `json:"center"`
	CenterCertificate string        `json:"centerCertificate,omitempty"`
	Token             string        `json:"token"`
	Host              string        `json:"host"`
	Root              string        `json:"root"`
	Agents            []agentConfig `json:"agents"`
	InsecureLocal     bool          `json:"insecureLocal"`
	SSHJump           string        `json:"sshJump,omitempty"`
	SSHTarget         string        `json:"sshTarget,omitempty"`
}
type gateway struct {
	upgradeMu  sync.Mutex
	configPath string
	managed    bool
	config     config
	store      *store
	mu         sync.Mutex
	socket     *websocket.Conn
	writeMu    sync.Mutex
	agentMu    sync.Mutex
	processes  map[string]*acpProcess
	executing  map[string]chan struct{}
	ready      bool
	cursor     int64
	inFlight   int64
	flushWake  chan struct{}
	stopped    bool
	draining   bool
}

var bearerSecret = regexp.MustCompile(`(?i)Bearer\s+\S+`)
var secretName = regexp.MustCompile(`(?i)(TOKEN|SECRET|PASSWORD|API_KEY|AUTH)`)

func (g *gateway) diagnostic(level, code, message, session, agent string) {
	message = strings.ReplaceAll(message, g.config.Token, "[已隐藏]")
	for _, item := range os.Environ() {
		parts := strings.SplitN(item, "=", 2)
		if len(parts) == 2 && secretName.MatchString(parts[0]) && len(parts[1]) >= 6 {
			message = strings.ReplaceAll(message, parts[1], "[已隐藏]")
		}
	}
	for _, configured := range g.config.Agents {
		for key, value := range configured.Env {
			if secretName.MatchString(key) && len(value) >= 6 {
				message = strings.ReplaceAll(message, value, "[已隐藏]")
			}
		}
	}
	message = bearerSecret.ReplaceAllString(message, "Bearer [已隐藏]")
	if len(message) > 8192 {
		message = message[:8192]
	}
	g.emit(session, "diagnostic", map[string]string{"level": level, "source": "gateway", "code": code, "message": message, "session": session, "agent": agent})
}

func newGateway(c config, s *store) *gateway {
	return &gateway{config: c, store: s, processes: make(map[string]*acpProcess), executing: make(map[string]chan struct{}), flushWake: make(chan struct{}, 1)}
}
func (g *gateway) emit(session, kind string, data any) {
	if err := g.store.event(session, kind, data); err != nil {
		slog.Error("journal write failed", "error", err)
		return
	}
	g.scheduleFlush()
}
func (g *gateway) updateSession(s *session, status, problem string) {
	g.mu.Lock()
	var current session
	if g.store.get("session", s.ID, &current) == nil && current.Status == "closed" && status != "closed" {
		g.mu.Unlock()
		return
	}
	s.Status = status
	s.Error = problem
	s.UpdatedAt = time.Now().UnixMilli()
	copy := *s
	g.mu.Unlock()
	if err := g.store.put("session", s.ID, copy); err != nil {
		slog.Error("session persistence failed", "error", err)
	}
	g.emit(s.ID, "session", copy)
}
func (g *gateway) write(v any) error {
	g.mu.Lock()
	ws := g.socket
	g.mu.Unlock()
	if ws == nil {
		return errors.New("offline")
	}
	return g.writeSocket(ws, v)
}
func (g *gateway) writeSocket(ws *websocket.Conn, value any) error {
	g.writeMu.Lock()
	defer g.writeMu.Unlock()
	_ = ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return ws.WriteJSON(value)
}
func (g *gateway) scheduleFlush() {
	select {
	case g.flushWake <- struct{}{}:
	default:
	}
}
func (g *gateway) flush() {
	g.mu.Lock()
	ws, cursor := g.socket, g.cursor
	ready := g.ready && g.inFlight == 0
	g.mu.Unlock()
	if !ready || ws == nil {
		return
	}
	events, err := g.store.events(cursor, 30)
	if err != nil || len(events) == 0 {
		return
	}
	g.mu.Lock()
	if ws != g.socket || !g.ready || cursor != g.cursor {
		g.mu.Unlock()
		g.scheduleFlush()
		return
	}
	g.inFlight = events[len(events)-1].Seq
	g.mu.Unlock()
	if err = g.writeSocket(ws, map[string]any{"type": "events", "events": events}); err != nil {
		slog.Warn("event sync failed", "error", err)
		_ = ws.Close()
	}
}
func (g *gateway) run(ctx context.Context) error {
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-g.flushWake:
				g.flush()
			}
		}
	}()
	go func() {
		<-ctx.Done()
		g.mu.Lock()
		socket := g.socket
		g.mu.Unlock()
		if socket != nil {
			_ = socket.Close()
		}
	}()
	backoff := 250 * time.Millisecond
	for ctx.Err() == nil {
		g.mu.Lock()
		draining := g.draining
		g.mu.Unlock()
		if draining {
			<-ctx.Done()
			return nil
		}
		err := g.connect(ctx)
		if err != nil {
			slog.Warn("center disconnected", "error", err)
			g.diagnostic("warning", "CENTER_DISCONNECTED", err.Error(), "", "")
		}
		g.mu.Lock()
		if g.ready {
			backoff = 250 * time.Millisecond
		}
		g.ready = false
		g.inFlight = 0
		g.socket = nil
		g.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(backoff):
		}
		if backoff < 8*time.Second {
			backoff *= 2
		}
	}
	return nil
}
func (g *gateway) connect(ctx context.Context) error {
	u, err := url.Parse(g.config.Center)
	if err != nil {
		return err
	}
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else if u.Scheme == "http" && g.config.InsecureLocal && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1") {
		u.Scheme = "ws"
	} else {
		return errors.New("remote center requires HTTPS")
	}
	u.Path = "/gateway"
	u.RawQuery = ""
	tlsConfig, err := cTLS(g.config)
	if err != nil {
		return err
	}
	dialer := websocket.Dialer{HandshakeTimeout: 15 * time.Second, TLSClientConfig: tlsConfig}
	cleanup := func() {}
	if g.config.SSHJump != "" {
		dial, stop, err := startSSHTunnel(ctx, g.config)
		if err != nil {
			return err
		}
		dialer.NetDialContext = dial
		cleanup = stop
	}
	defer cleanup()
	headers := http.Header{"Authorization": []string{"Bearer " + g.config.Token}}
	ws, response, err := dialer.DialContext(ctx, u.String(), headers)
	if err != nil {
		if response != nil {
			return fmt.Errorf("websocket handshake: %s", response.Status)
		}
		return err
	}
	defer ws.Close()
	g.mu.Lock()
	g.socket = ws
	g.mu.Unlock()

	if err = g.write(map[string]any{"type": "hello", "agents": g.publicAgents(), "cwd": g.config.Root, "platform": runtime.GOOS, "arch": runtime.GOARCH, "version": gatewayVersion, "managed": g.managed, "manageAgents": true}); err != nil {
		return err
	}
	ws.SetReadLimit(4 * 1024 * 1024)
	_ = ws.SetReadDeadline(time.Now().Add(45 * time.Second))
	ws.SetPongHandler(func(string) error { return ws.SetReadDeadline(time.Now().Add(45 * time.Second)) })
	for ctx.Err() == nil {
		var msg struct {
			Type    string          `json:"type"`
			Cursor  int64           `json:"cursor"`
			ID      string          `json:"id"`
			Action  string          `json:"action"`
			Payload json.RawMessage `json:"payload"`
		}
		if err = ws.ReadJSON(&msg); err != nil {
			return err
		}
		switch msg.Type {
		case "sync", "ack":
			if msg.Cursor < g.store.savedFloor() {
				_ = g.write(map[string]any{"type": "sync_gap", "floor": g.store.savedFloor()})
				return errors.New("center cursor precedes retained gateway journal")
			}
			g.mu.Lock()
			g.cursor = msg.Cursor
			if msg.Type == "sync" || g.inFlight <= msg.Cursor {
				g.inFlight = 0
			}
			g.ready = true
			g.mu.Unlock()
			if msg.Type == "ack" {
				_ = g.store.ack(msg.Cursor)
			}
			g.scheduleFlush()
		case "command":
			if strings.HasPrefix(msg.Action, "agent.") {
				go func(id, action string, payload json.RawMessage) {
					result, problem := g.agentCommand(action, payload)
					response, _ := json.Marshal(result)
					g.result(receipt{ID: id, Status: "done", Result: response, Error: problem})
				}(msg.ID, msg.Action, msg.Payload)
			} else {
				go g.command(msg.ID, msg.Action, msg.Payload)
			}
		default:
			return fmt.Errorf("unknown center message %q", msg.Type)
		}
	}
	return nil
}
func (g *gateway) command(id, action string, payload json.RawMessage) {
	g.mu.Lock()
	draining := g.draining
	g.mu.Unlock()
	if draining {
		return
	}
	finger := fingerprint(action, payload)
	g.store.mu.Lock()
	old, err := g.store.receipt(id)
	if err != nil {
		g.store.mu.Unlock()
		return
	}
	if old != nil {
		if old.Fingerprint != finger {
			g.store.mu.Unlock()
			g.result(receipt{ID: id, Fingerprint: finger, Status: "done", Error: &wireError{Code: "IDEMPOTENCY_CONFLICT", Message: "Command ID conflict"}})
			return
		}
		running := g.executing[id]
		g.store.mu.Unlock()
		if running != nil {
			<-running
			old, _ = g.store.receipt(id)
		}
		if old != nil {
			g.result(*old)
		}
		return
	}
	r := receipt{ID: id, Fingerprint: finger, Status: "executing"}
	if err = g.store.saveReceipt(r); err != nil {
		g.store.mu.Unlock()
		return
	}
	done := make(chan struct{})
	g.executing[id] = done
	g.store.mu.Unlock()
	result, problem := g.execute(id, action, payload)
	r.Status = "done"
	if problem != nil {
		r.Error = problem
	} else {
		r.Result, _ = json.Marshal(result)
	}
	_ = g.store.saveReceipt(r)
	g.result(r)
	g.store.mu.Lock()
	delete(g.executing, id)
	close(done)
	g.store.mu.Unlock()
}
func (g *gateway) watchUpgrade(ctx context.Context, cancel context.CancelFunc, path string) {
	self, _ := os.Executable()
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			target, err := activeBinary(path)
			if err != nil || target == self {
				continue
			}
			g.mu.Lock()
			g.draining = true
			g.mu.Unlock()
			for ctx.Err() == nil {
				g.store.mu.Lock()
				busy := len(g.executing) > 0
				g.store.mu.Unlock()
				g.mu.Lock()
				for _, process := range g.processes {
					process.mu.Lock()
					if process.active != "" {
						busy = true
					}
					process.mu.Unlock()
				}
				g.mu.Unlock()
				if !busy {
					cancel()
					return
				}
				select {
				case <-ctx.Done():
					return
				case <-time.After(250 * time.Millisecond):
				}
			}
		}
	}
}
func (g *gateway) result(r receipt) {
	_ = g.write(map[string]any{"type": "result", "id": r.ID, "status": r.Status, "result": r.Result, "error": r.Error})
}
func fail(code, msg string) (any, *wireError) { return nil, &wireError{Code: code, Message: msg} }
func (g *gateway) execute(id, action string, raw json.RawMessage) (any, *wireError) {
	if action == "gateway.upgrade" {
		if !g.upgradeMu.TryLock() {
			return fail("GATEWAY_UPGRADE_BUSY", "Gateway 正在暂存更新")
		}
		defer g.upgradeMu.Unlock()
		if !g.managed {
			return fail("GATEWAY_NO_MANAGER", "请通过部署脚本或容器编排器升级此 Gateway")
		}
		if err := g.downloadUpgrade(); err != nil {
			return fail("GATEWAY_UPGRADE_FAILED", err.Error())
		}
		return map[string]string{"status": "staged"}, nil
	}
	var payload struct {
		Session  json.RawMessage `json:"session"`
		Agent    agentConfig     `json:"agent"`
		Text     string          `json:"text"`
		Mode     string          `json:"mode"`
		Isolate  bool            `json:"isolate"`
		Approval string          `json:"approval"`
		Option   string          `json:"option"`
		Command  string          `json:"command"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return fail("INVALID_COMMAND", "Invalid command payload")
	}
	if action == "approve" {
		g.mu.Lock()
		processes := make([]*acpProcess, 0, len(g.processes))
		for _, process := range g.processes {
			processes = append(processes, process)
		}
		g.mu.Unlock()
		for _, process := range processes {
			if process.decide(payload.Approval, payload.Option) == nil {
				return map[string]string{"status": "resolved"}, nil
			}
		}
		return fail("APPROVAL_EXPIRED", "Approval is no longer pending")
	}
	if action == "create" {
		var s session
		if err := json.Unmarshal(payload.Session, &s); err != nil || s.ID == "" || s.Host != g.config.Host {
			return fail("HOST_FORBIDDEN", "Invalid target host or Session")
		}
		var agent *agentConfig
		for _, item := range g.agents() {
			if item.ID == payload.Agent.ID {
				agent = &item
				break
			}
		}
		if agent == nil {
			return fail("AGENT_NOT_FOUND", "Agent is not configured on this host")
		}
		if payload.Isolate {
			return fail("WORKTREE_UNSUPPORTED", "Go Gateway does not yet allocate Git worktrees")
		}
		_ = g.store.put("session", s.ID, s)
		_ = g.store.put("session-agent", s.ID, agent)
		g.emit(s.ID, "session", s)
		if err := g.launch(&s, *agent, false); err != nil {
			g.diagnostic("error", "ACP_CONNECT_FAILED", err.Error(), s.ID, agent.ID)
			g.updateSession(&s, "error", err.Error())
			return fail("ACP_CONNECT_FAILED", err.Error())
		}
		return s, nil
	}
	var key string
	if err := json.Unmarshal(payload.Session, &key); err != nil || key == "" {
		return fail("INVALID_SESSION", "Session ID required")
	}
	var s session
	if err := g.store.get("session", key, &s); err != nil || s.Host != g.config.Host {
		return fail("SESSION_NOT_FOUND", "Session not found")
	}
	g.mu.Lock()
	process := g.processes[key]
	g.mu.Unlock()
	switch action {
	case "promote":
		if process == nil {
			return fail("SESSION_UNAVAILABLE", "ACP process is not connected")
		}
		return process.promote(payload.Command)
	case "send":
		if process == nil {
			return fail("SESSION_UNAVAILABLE", "ACP process is not connected")
		}
		if strings.TrimSpace(payload.Text) == "" {
			return fail("INVALID_COMMAND", "Message is empty")
		}
		mode := payload.Mode
		if mode == "" {
			mode = "auto"
		}
		process.mu.Lock()
		active := process.active != ""
		process.mu.Unlock()
		if mode == "immediate" && active {
			return fail("SESSION_BUSY", "Session is already running")
		}
		if mode == "steer" && (!s.Capabilities.Steering || !active) {
			return fail("STEERING_UNSUPPORTED", "Agent cannot be steered now")
		}
		command := queuedCommand{ID: id, Session: key, Text: payload.Text, Status: "queued", CreatedAt: time.Now().UnixMilli()}
		_ = g.store.put("command", id, command)
		g.emit(key, "queued", map[string]any{"command": id, "text": payload.Text})
		if s.Title == "新的工作" {
			s.Title = payload.Text
			if len(s.Title) > 60 {
				s.Title = s.Title[:60]
			}
			g.updateSession(&s, s.Status, s.Error)
		}
		if active && s.Capabilities.Steering && (mode == "auto" || mode == "steer") {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			var response struct {
				Outcome string `json:"outcome"`
			}
			err := process.request(ctx, "_session/steering", map[string]any{"sessionId": s.ACPID, "prompt": []any{map[string]string{"type": "text", "text": payload.Text}}, "_meta": map[string]any{"steering": map[string]string{"idleBehavior": "promptRequired"}}}, &response)
			if err == nil && response.Outcome == "injected" {
				command.Status = "completed"
				_ = g.store.put("command", id, command)
				g.emit(key, "steered", map[string]string{"command": id})
				return map[string]any{"session": key, "command": id, "delivery": "steering", "status": s.Status}, nil
			}
			if mode == "steer" {
				command.Status = "failed"
				_ = g.store.put("command", id, command)
				g.emit(key, "queue.cancelled", map[string]string{"command": id, "status": "failed"})
				return fail("STEERING_NOT_APPLIED", "Agent did not accept steering")
			}
		}
		process.startPrompt(command)
		delivery := "immediate"
		if active {
			delivery = "queued"
		}
		return map[string]any{"session": key, "command": id, "delivery": delivery, "status": s.Status}, nil
	case "cancel":
		if process == nil {
			return map[string]string{"status": s.Status}, nil
		}
		process.cancelQueue()
		process.mu.Lock()
		active := process.active
		process.mu.Unlock()
		_ = process.notify("session/cancel", map[string]string{"sessionId": s.ACPID})
		g.updateSession(&s, "cancelling", "")
		time.AfterFunc(3*time.Second, func() {
			process.mu.Lock()
			same := active != "" && process.active == active
			process.mu.Unlock()
			if same {
				process.stop()
			}
		})
		return map[string]string{"status": "cancelling"}, nil
	case "close":
		if process != nil {
			process.cancelQueue()
			process.stop()
		}
		g.updateSession(&s, "closed", "")
		return map[string]string{"status": "closed"}, nil
	case "resume":
		if process != nil {
			return fail("SESSION_ACTIVE", "Agent process is already connected")
		}
		if !s.Capabilities.Load || s.ACPID == "" {
			return fail("RESTORE_UNSUPPORTED", "Agent did not advertise session/load")
		}
		var agent agentConfig
		if err := g.store.get("session-agent", key, &agent); err != nil {
			return fail("AGENT_NOT_FOUND", "Saved Agent configuration not found")
		}
		if err := g.launch(&s, agent, true); err != nil {
			return fail("RESTORE_FAILED", err.Error())
		}
		return s, nil
	default:
		return fail("UNKNOWN_ACTION", "Unsupported Gateway action")
	}
}
func (g *gateway) recoverSessions() {
	raw, _ := g.store.all("command")
	for _, item := range raw {
		var command queuedCommand
		if json.Unmarshal(item, &command) == nil && (command.Status == "running" || command.Status == "queued") {
			command.Status = "interrupted"
			_ = g.store.put("command", command.ID, command)
			g.emit(command.Session, "queue.cancelled", map[string]string{"command": command.ID, "status": "interrupted"})
		}
	}
	raw, _ = g.store.all("session")
	for _, item := range raw {
		var s session
		if json.Unmarshal(item, &s) != nil || s.Status == "closed" {
			continue
		}
		g.updateSession(&s, "interrupted", "Gateway restarted; active Prompt was not replayed.")
		if s.Capabilities.Load && s.ACPID != "" {
			var agent agentConfig
			if g.store.get("session-agent", s.ID, &agent) == nil {
				go func() {
					if err := g.launch(&s, agent, true); err != nil {
						slog.Warn("session recovery failed", "session", s.ID, "error", err)
					}
				}()
			}
		}
	}
}
func (g *gateway) stop() {
	g.mu.Lock()
	g.stopped = true
	ws := g.socket
	processes := make([]*acpProcess, 0, len(g.processes))
	for _, p := range g.processes {
		processes = append(processes, p)
	}
	g.mu.Unlock()
	if ws != nil {
		_ = ws.Close()
	}
	for _, p := range processes {
		p.stop()
	}
}
func validateConfig(c config) error {
	if c.Host == "" || len(c.Token) < 16 || c.Root == "" {
		return errors.New("Gateway config requires host, token and root")
	}
	u, err := url.Parse(c.Center)
	if err != nil {
		return err
	}
	if u.Scheme == "https" {
		_, err := cTLS(c)
		return err
	}
	if u.Scheme == "http" && c.InsecureLocal && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost") {
		return nil
	}
	return errors.New("Gateway requires HTTPS except explicitly enabled loopback")
}
func cTLS(c config) (*tls.Config, error) {
	if c.CenterCertificate == "" {
		return nil, nil
	}
	center, err := url.Parse(c.Center)
	if err != nil || center.Scheme != "https" || center.Hostname() != "127.0.0.1" {
		return nil, errors.New("provisioned TLS certificate requires an HTTPS loopback center")
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM([]byte(c.CenterCertificate)) {
		return nil, errors.New("invalid center TLS certificate")
	}
	return &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}, nil
}
func configPath(path string) string {
	if path != "" {
		return path
	}
	return filepath.Join(".gateway", "config.json")
}
func startSSHTunnel(ctx context.Context, c config) (func(context.Context, string, string) (net.Conn, error), func(), error) {
	if c.SSHTarget == "" {
		return nil, nil, errors.New("sshTarget is required with sshJump")
	}
	u, err := url.Parse(c.Center)
	if err != nil {
		return nil, nil, err
	}
	remotePort := u.Port()
	if remotePort == "" {
		if u.Scheme == "https" {
			remotePort = "443"
		} else {
			remotePort = "80"
		}
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, nil, err
	}
	local := listener.Addr().String()
	_ = listener.Close()
	_, localPort, _ := net.SplitHostPort(local)
	cmd := exec.CommandContext(ctx, "ssh", "-J", c.SSHJump, "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-L", "127.0.0.1:"+localPort+":"+u.Hostname()+":"+remotePort, "-N", c.SSHTarget)
	hideWorkerWindow(cmd)
	if err = cmd.Start(); err != nil {
		return nil, nil, err
	}
	stop := func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		connection, e := net.DialTimeout("tcp", local, 250*time.Millisecond)
		if e == nil {
			_ = connection.Close()
			dial := func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "tcp", local)
			}
			return dial, stop, nil
		}
		select {
		case <-ctx.Done():
			stop()
			return nil, nil, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	stop()
	return nil, nil, errors.New("SSH jump tunnel could not be established")
}
