package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

func newID(prefix string) string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return prefix + "_" + hex.EncodeToString(b)
}

type agentConfig struct {
	ID      string            `json:"id"`
	Name    string            `json:"name"`
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env"`
}
type session struct {
	ID           string `json:"id"`
	Host         string `json:"host"`
	Agent        string `json:"agent"`
	Cwd          string `json:"cwd"`
	Title        string `json:"title"`
	Status       string `json:"status"`
	ACPID        string `json:"acpId,omitempty"`
	ProcessID    int    `json:"processId,omitempty"`
	Capabilities struct {
		Load     bool `json:"load"`
		Steering bool `json:"steering"`
	} `json:"capabilities"`
	Parent     string `json:"parent,omitempty"`
	CreatedAt  int64  `json:"createdAt"`
	UpdatedAt  int64  `json:"updatedAt"`
	Error      string `json:"error,omitempty"`
	StopReason string `json:"stopReason,omitempty"`
}
type queuedCommand struct {
	ID        string `json:"id"`
	Session   string `json:"session"`
	Text      string `json:"text"`
	Status    string `json:"status"`
	CreatedAt int64  `json:"createdAt"`
}
type rpcReply struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}
type acpProcess struct {
	cmd         *exec.Cmd
	stdin       io.WriteCloser
	stdout      io.ReadCloser
	stderr      io.ReadCloser
	mu          sync.Mutex
	pending     map[string]chan rpcReply
	next        int
	closed      bool
	session     *session
	gateway     *gateway
	active      string
	queue       []queuedCommand
	cancelled   bool
	permissions map[string]chan string
}

func (p *acpProcess) send(value any) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return errors.New("ACP connection closed")
	}
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	_, err = p.stdin.Write(b)
	return err
}
func (p *acpProcess) request(ctx context.Context, method string, params any, out any) error {
	p.mu.Lock()
	p.next++
	number := p.next
	key := fmt.Sprint(number)
	wait := make(chan rpcReply, 1)
	p.pending[key] = wait
	p.mu.Unlock()
	defer func() { p.mu.Lock(); delete(p.pending, key); p.mu.Unlock() }()
	if err := p.send(map[string]any{"jsonrpc": "2.0", "id": number, "method": method, "params": params}); err != nil {
		return err
	}
	select {
	case response := <-wait:
		if response.Error != nil {
			return fmt.Errorf("ACP %s: %s", method, response.Error.Message)
		}
		if out != nil {
			return json.Unmarshal(response.Result, out)
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (p *acpProcess) notify(method string, params any) error {
	return p.send(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}
func (p *acpProcess) listen() {
	scanner := bufio.NewScanner(p.stdout)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		var msg struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if json.Unmarshal(scanner.Bytes(), &msg) != nil {
			continue
		}
		if msg.Method == "session/update" {
			var params struct {
				SessionID string          `json:"sessionId"`
				Update    json.RawMessage `json:"update"`
			}
			if json.Unmarshal(msg.Params, &params) == nil && params.SessionID == p.session.ACPID {
				p.gateway.emit(p.session.ID, "acp.update", map[string]any{"run": p.currentRun(), "update": params.Update})
			}
			continue
		}
		if msg.Method == "session/request_permission" {
			go p.permission(msg.ID, msg.Params)
			continue
		}
		if msg.Method != "" {
			_ = p.send(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "error": map[string]any{"code": -32601, "message": "Method not supported"}})
			continue
		}
		if len(msg.ID) > 0 {
			key := strings.Trim(string(msg.ID), "\"")
			p.mu.Lock()
			wait := p.pending[key]
			p.mu.Unlock()
			if wait != nil {
				var r rpcReply
				_ = json.Unmarshal(scanner.Bytes(), &r)
				select {
				case wait <- r:
				default:
				}
			}
		}
	}
	p.mu.Lock()
	p.closed = true
	for _, ch := range p.pending {
		select {
		case ch <- rpcReply{Error: &struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		}{Message: "ACP process exited"}}:
		default:
		}
	}
	p.mu.Unlock()
}
func (p *acpProcess) currentRun() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.active == "" {
		return "history"
	}
	return p.active
}
func (p *acpProcess) permission(id json.RawMessage, raw json.RawMessage) {
	var params map[string]any
	if json.Unmarshal(raw, &params) != nil {
		return
	}
	key := newID("approval")
	ch := make(chan string, 1)
	p.mu.Lock()
	p.permissions[key] = ch
	p.mu.Unlock()
	defer func() { p.mu.Lock(); delete(p.permissions, key); p.mu.Unlock() }()
	approval := map[string]any{"id": key, "session": p.session.ID, "request": params, "status": "pending", "createdAt": time.Now().UnixMilli()}
	p.gateway.emit(p.session.ID, "approval", approval)
	var outcome any = map[string]any{"outcome": "cancelled"}
	select {
	case option := <-ch:
		if option != "" {
			outcome = map[string]any{"outcome": "selected", "optionId": option}
		}
	case <-time.After(5 * time.Minute):
	}
	approval["status"] = "cancelled"
	if v, ok := outcome.(map[string]any); ok && v["outcome"] == "selected" {
		approval["status"] = "approved"
	}
	p.gateway.emit(p.session.ID, "approval", approval)
	_ = p.send(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{"outcome": outcome}})
}
func (p *acpProcess) decide(approval, option string) error {
	p.mu.Lock()
	ch := p.permissions[approval]
	p.mu.Unlock()
	if ch == nil {
		return errors.New("approval expired")
	}
	select {
	case ch <- option:
		return nil
	default:
		return errors.New("approval already resolved")
	}
}
func (p *acpProcess) startPrompt(command queuedCommand) {
	p.mu.Lock()
	if p.active != "" {
		p.queue = append(p.queue, command)
		p.mu.Unlock()
		return
	}
	p.active = command.ID
	p.cancelled = false
	p.mu.Unlock()
	go p.runPrompt(command)
}
func (p *acpProcess) runPrompt(command queuedCommand) {
	p.gateway.updateSession(p.session, "running", "")
	command.Status = "running"
	_ = p.gateway.store.put("command", command.ID, command)
	p.gateway.emit(p.session.ID, "turn.start", map[string]string{"command": command.ID})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	var result struct {
		StopReason string `json:"stopReason"`
	}
	err := p.request(ctx, "session/prompt", map[string]any{"sessionId": p.session.ACPID, "prompt": []any{map[string]string{"type": "text", "text": command.Text}}}, &result)
	if err != nil {
		command.Status = "failed"
		p.gateway.updateSession(p.session, "interrupted", "ACP Prompt 中断；未自动重放。")
	}
	if err == nil {
		command.Status = "completed"
		if result.StopReason == "cancelled" {
			command.Status = "cancelled"
		}
		p.gateway.updateSession(p.session, "completed", "")
		p.gateway.emit(p.session.ID, "turn.end", map[string]any{"command": command.ID, "stopReason": result.StopReason})
	}
	_ = p.gateway.store.put("command", command.ID, command)
	p.mu.Lock()
	p.active = ""
	var next *queuedCommand
	if !p.closed && len(p.queue) > 0 {
		next = &p.queue[0]
		p.queue = p.queue[1:]
	}
	if p.closed {
		for _, queued := range p.queue {
			queued.Status = "interrupted"
			_ = p.gateway.store.put("command", queued.ID, queued)
			p.gateway.emit(p.session.ID, "queue.cancelled", map[string]string{"command": queued.ID, "status": "interrupted"})
		}
		p.queue = nil
	}
	p.mu.Unlock()
	if next != nil {
		p.startPrompt(*next)
	}
}
func (p *acpProcess) cancelQueue() {
	p.mu.Lock()
	queue := p.queue
	p.queue = nil
	p.mu.Unlock()
	for _, command := range queue {
		command.Status = "cancelled"
		_ = p.gateway.store.put("command", command.ID, command)
		p.gateway.emit(p.session.ID, "queue.cancelled", map[string]string{"command": command.ID, "status": "cancelled"})
	}
}
func (p *acpProcess) promote(commandID string) (any, *wireError) {
	p.mu.Lock()
	index := -1
	for i, command := range p.queue {
		if command.ID == commandID {
			index = i
			break
		}
	}
	if index < 0 {
		p.mu.Unlock()
		return fail("COMMAND_NOT_QUEUED", "Message is no longer queued")
	}
	if p.active == "" || !p.session.Capabilities.Steering {
		p.mu.Unlock()
		return fail("STEERING_UNSUPPORTED", "No running turn can accept steering")
	}
	command := p.queue[index]
	p.queue = append(p.queue[:index], p.queue[index+1:]...)
	p.mu.Unlock()
	command.Status = "steering"
	_ = p.gateway.store.put("command", command.ID, command)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var response struct {
		Outcome string `json:"outcome"`
	}
	err := p.request(ctx, "_session/steering", map[string]any{"sessionId": p.session.ACPID, "prompt": []any{map[string]string{"type": "text", "text": command.Text}}, "_meta": map[string]any{"steering": map[string]string{"idleBehavior": "promptRequired"}}}, &response)
	if err == nil && response.Outcome == "injected" {
		command.Status = "completed"
		_ = p.gateway.store.put("command", command.ID, command)
		p.gateway.emit(p.session.ID, "steered", map[string]string{"command": command.ID})
		return map[string]any{"session": p.session.ID, "command": command.ID, "delivery": "steering", "status": p.session.Status}, nil
	}
	command.Status = "queued"
	_ = p.gateway.store.put("command", command.ID, command)
	p.mu.Lock()
	if index > len(p.queue) {
		index = len(p.queue)
	}
	p.queue = append(p.queue, queuedCommand{})
	copy(p.queue[index+1:], p.queue[index:])
	p.queue[index] = command
	idle := p.active == ""
	var next *queuedCommand
	if idle && len(p.queue) > 0 {
		first := p.queue[0]
		next = &first
		p.queue = p.queue[1:]
	}
	p.mu.Unlock()
	if next != nil {
		p.startPrompt(*next)
	}
	return map[string]any{"session": p.session.ID, "command": command.ID, "delivery": "queued", "status": p.session.Status, "reason": "notInjected"}, nil
}
func (p *acpProcess) stop() {
	p.mu.Lock()
	p.closed = true
	for _, ch := range p.permissions {
		select {
		case ch <- "":
		default:
		}
	}
	p.mu.Unlock()
	_ = p.stdin.Close()
	if p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
}
func (g *gateway) launch(s *session, config agentConfig, restore bool) error {
	if !filepath.IsAbs(s.Cwd) {
		return errors.New("working directory must be absolute")
	}
	root, err := filepath.EvalSymlinks(g.config.Root)
	if err != nil {
		return err
	}
	cwd, err := filepath.EvalSymlinks(s.Cwd)
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(root, cwd)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return errors.New("working directory outside allowed root")
	}
	s.Cwd = cwd
	token, err := g.sessionToken(s.ID)
	if err != nil {
		return err
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(config.Command, config.Args...)
	cmd.Dir = cwd
	cmd.Env = []string{}
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if name != "ACPAO_ADMIN_TOKEN" && name != "ACPAO_PAIR_CODE" && name != "ACPAO_TOKEN" {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	for key, value := range config.Env {
		cmd.Env = append(cmd.Env, key+"="+os.ExpandEnv(value))
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err = cmd.Start(); err != nil {
		return err
	}
	p := &acpProcess{cmd: cmd, stdin: stdin, stdout: stdout, stderr: stderr, session: s, gateway: g, pending: make(map[string]chan rpcReply), permissions: make(map[string]chan string)}
	g.mu.Lock()
	g.processes[s.ID] = p
	g.mu.Unlock()
	go p.listen()
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			g.diagnostic("warning", "AGENT_STDERR", scanner.Text(), s.ID, config.ID)
		}
	}()
	go func() {
		err := cmd.Wait()
		p.mu.Lock()
		wasClosed := p.closed
		p.closed = true
		p.mu.Unlock()
		g.mu.Lock()
		if g.processes[s.ID] == p {
			delete(g.processes, s.ID)
		}
		g.mu.Unlock()
		if !wasClosed {
			g.updateSession(s, "interrupted", "Agent 进程退出；执行中的指令未重放。")
		}
		g.diagnostic("warning", "ACP_EXIT", fmt.Sprint(err), s.ID, config.ID)
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var init struct {
		ProtocolVersion   int `json:"protocolVersion"`
		AgentCapabilities struct {
			LoadSession bool `json:"loadSession"`
		} `json:"agentCapabilities"`
		Meta map[string]json.RawMessage `json:"_meta"`
	}
	if err = p.request(ctx, "initialize", map[string]any{"protocolVersion": 1, "clientCapabilities": map[string]any{"fs": map[string]bool{"readTextFile": false, "writeTextFile": false}, "terminal": false}, "clientInfo": map[string]string{"name": "acpao-go-gateway", "version": "0.1"}}, &init); err != nil {
		p.stop()
		return err
	}
	if init.ProtocolVersion != 1 {
		p.stop()
		return errors.New("ACP protocol version mismatch")
	}
	s.Capabilities.Load = init.AgentCapabilities.LoadSession
	var steer struct {
		Supported bool `json:"supported"`
	}
	_ = json.Unmarshal(init.Meta["steering"], &steer)
	s.Capabilities.Steering = steer.Supported
	s.ProcessID = cmd.Process.Pid
	bridge := map[string]any{"name": "acpao", "command": self, "args": []string{"--mcp-bridge"}, "env": []map[string]string{{"name": "ACPAO_CENTER", "value": g.config.Center}, {"name": "ACPAO_CENTER_CERTIFICATE", "value": g.config.CenterCertificate}, {"name": "ACPAO_TOKEN", "value": token}, {"name": "ACPAO_SSH_JUMP", "value": g.config.SSHJump}, {"name": "ACPAO_SSH_TARGET", "value": g.config.SSHTarget}}}
	params := map[string]any{"cwd": s.Cwd, "mcpServers": []any{bridge}}
	if restore {
		if !s.Capabilities.Load {
			p.stop()
			return errors.New("session/load unsupported")
		}
		params["sessionId"] = s.ACPID
		err = p.request(ctx, "session/load", params, nil)
	} else {
		var response struct {
			SessionID string `json:"sessionId"`
		}
		err = p.request(ctx, "session/new", params, &response)
		s.ACPID = response.SessionID
	}
	if err != nil {
		p.stop()
		return err
	}
	g.updateSession(s, "idle", "")
	return nil
}
