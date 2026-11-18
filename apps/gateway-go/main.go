package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func main() {
	if err := start(); err != nil {
		slog.Error("gateway stopped", "error", err)
		os.Exit(1)
	}
}
func start() error {
	if len(os.Args) > 1 && os.Args[1] == "--mcp-bridge" {
		return runMCPBridge()
	}
	file := flag.String("config", os.Getenv("ACPAO_GATEWAY_CONFIG"), "Gateway configuration path")
	pair := flag.Bool("pair", false, "pair device with center")
	provision := flag.Bool("provision", false, "initialize a new device config from standard input over SSH")
	foreground := flag.Bool("foreground", false, "run worker in foreground (Docker)")
	daemon := flag.Bool("daemon", false, "detach a manager which restarts the worker")
	manager := flag.Bool("manager", false, "run manager in foreground")
	stopManagerFlag := flag.Bool("stop", false, "stop the detached manager")
	worker := flag.Bool("worker", false, "internal manager child")
	version := flag.Bool("version", false, "print Gateway protocol version")
	upgrade := flag.String("upgrade", "", "stage a new Gateway executable for the manager")
	importIdentity := flag.String("import-identity", "", "import device identity")
	exportIdentity := flag.String("export-identity", "", "export device identity")
	flag.Parse()
	path, pathErr := filepath.Abs(configPath(*file))
	if pathErr != nil {
		return pathErr
	}
	if *version {
		fmt.Println("acpao-gateway 0.2")
		return nil
	}
	if *upgrade != "" {
		return stageUpgrade(path, *upgrade)
	}
	if *stopManagerFlag {
		return stopManager(path)
	}
	if *pair {
		return pairDevice(path)
	}
	if *provision {
		return provisionDevice(path)
	}
	if *importIdentity != "" {
		return transferIdentity(path, *importIdentity, false)
	}
	if *exportIdentity != "" {
		return transferIdentity(path, *exportIdentity, true)
	}
	if *daemon && !(*foreground || *worker || *manager) {
		return spawnManager(path)
	}
	if *manager {
		return supervise(path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var c config
	if err = json.Unmarshal(data, &c); err != nil {
		return err
	}
	if err = validateConfig(c); err != nil {
		return err
	}
	c.Root, err = filepath.Abs(c.Root)
	if err != nil {
		return err
	}
	s, err := openStore(filepath.Join(filepath.Dir(path), "gateway-go.sqlite"))
	if err != nil {
		return err
	}
	defer s.db.Close()
	g := newGateway(c, s)
	g.recoverSessions()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	defer g.stop()
	if *worker {
		go g.watchUpgrade(ctx, stop, path)
	}
	slog.Info("gateway started", "host", c.Host, "mode", func() string {
		if *worker {
			return "worker"
		}
		return "foreground"
	}())
	return g.run(ctx)
}
func provisionDevice(path string) error {
	var c config
	if err := json.NewDecoder(io.LimitReader(os.Stdin, 256*1024)).Decode(&c); err != nil {
		return errors.New("invalid Gateway provisioning data")
	}
	if c.Root == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		c.Root = home
	}
	if !filepath.IsAbs(c.Root) {
		return errors.New("Gateway work root must be an absolute path")
	}
	info, err := os.Stat(c.Root)
	if err != nil || !info.IsDir() {
		return errors.New("Gateway work root is not an accessible directory")
	}
	if err := validateConfig(c); err != nil {
		return err
	}
	c.Agents = []agentConfig{}
	for _, candidate := range []agentConfig{
		{ID: "codex", Name: "Codex ACP", Command: "codex-acp"},
		{ID: "opencode", Name: "OpenCode", Command: "opencode", Args: []string{"acp"}},
	} {
		if executable, err := exec.LookPath(candidate.Command); err == nil {
			candidate.Command = executable
			c.Agents = append(c.Agents, candidate)
		}
	}
	if err := secureStateDirectory(filepath.Dir(path)); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	err = json.NewEncoder(file).Encode(c)
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = secureStateFile(path)
	}
	if err != nil {
		_ = os.Remove(path)
	}
	return err
}

func pairDevice(path string) error {
	if _, err := os.Stat(path); err == nil {
		return errors.New("device config already exists")
	}
	center := os.Getenv("ACPAO_CENTER")
	code := os.Getenv("ACPAO_PAIR_CODE")
	if center == "" || code == "" {
		return errors.New("ACPAO_CENTER and ACPAO_PAIR_CODE are required")
	}
	c := config{Center: center, Root: os.Getenv("ACPAO_ROOT"), InsecureLocal: os.Getenv("ACPAO_INSECURE_LOCAL") == "1", SSHJump: os.Getenv("ACPAO_SSH_JUMP"), SSHTarget: os.Getenv("ACPAO_SSH_TARGET")}
	if c.Root == "" {
		c.Root = "."
	}
	root, err := filepath.Abs(c.Root)
	if err != nil {
		return err
	}
	c.Root = root
	c.Token = strings.Repeat("x", 16)
	c.Host = "pending"
	if err = validateConfig(c); err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]string{"code": code})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimSuffix(center, "/")+"/api/gateway/pair", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	client := http.DefaultClient
	if c.SSHJump != "" {
		dial, stop, err := startSSHTunnel(ctx, c)
		if err != nil {
			return err
		}
		defer stop()
		client = &http.Client{Transport: &http.Transport{DialContext: dial}, Timeout: 15 * time.Second}
	}
	response, err := client.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return fmt.Errorf("pairing rejected: HTTP %d", response.StatusCode)
	}
	var identity struct {
		Host  string `json:"host"`
		Token string `json:"token"`
	}
	if err = json.NewDecoder(io.LimitReader(response.Body, 1024*1024)).Decode(&identity); err != nil {
		return err
	}
	c.Host = identity.Host
	c.Token = identity.Token
	if agentsFile := os.Getenv("ACPAO_AGENTS"); agentsFile != "" {
		data, err := os.ReadFile(agentsFile)
		if err != nil {
			return err
		}
		if err = json.Unmarshal(data, &c.Agents); err != nil {
			return err
		}
	}
	if err = secureStateDirectory(filepath.Dir(path)); err != nil {
		return err
	}
	data, _ := json.MarshalIndent(c, "", "  ")
	if err = os.WriteFile(path, data, 0600); err != nil {
		return err
	}
	if err = secureStateFile(path); err != nil {
		return err
	}
	fmt.Println("Gateway paired. Configure agents in", path)
	return nil
}
func transferIdentity(configFile, identityFile string, export bool) error {
	data, err := os.ReadFile(configFile)
	if err != nil {
		return err
	}
	var c config
	if err = json.Unmarshal(data, &c); err != nil {
		return err
	}
	if export {
		value, _ := json.MarshalIndent(map[string]string{"host": c.Host, "token": c.Token}, "", "  ")
		if err = os.WriteFile(identityFile, value, 0600); err != nil {
			return err
		}
		return secureStateFile(identityFile)
	}
	data, err = os.ReadFile(identityFile)
	if err != nil {
		return err
	}
	var identity struct {
		Host  string `json:"host"`
		Token string `json:"token"`
	}
	if err = json.Unmarshal(data, &identity); err != nil {
		return err
	}
	if identity.Host != c.Host || len(identity.Token) < 16 {
		return errors.New("identity does not match this host")
	}
	c.Token = identity.Token
	data, _ = json.MarshalIndent(c, "", "  ")
	temp := configFile + ".new"
	if err = os.WriteFile(temp, data, 0600); err != nil {
		return err
	}
	if err = secureStateFile(temp); err != nil {
		return err
	}
	return os.Rename(temp, configFile)
}
func supervise(path string) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	pidFile := filepath.Join(filepath.Dir(path), "manager.pid")
	if err := os.WriteFile(pidFile, []byte(fmt.Sprint(os.Getpid())), 0600); err != nil {
		return err
	}
	defer os.Remove(pidFile)
	for ctx.Err() == nil {
		self, err := activeBinary(path)
		if err != nil {
			return err
		}
		cmd := exec.CommandContext(ctx, self, "--worker", "--config", path)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		hideWorkerWindow(cmd)
		err = cmd.Run()
		if ctx.Err() != nil {
			return nil
		}
		slog.Warn("gateway worker exited; restarting", "error", err)
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(2 * time.Second):
		}
	}
	return nil
}
func spawnManager(path string) error {
	if _, err := os.Stat(path); err != nil {
		return err
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(self, "--manager", "--config", path)
	detachManager(cmd)
	if err = cmd.Start(); err != nil {
		return err
	}
	fmt.Println("Gateway manager started, PID", cmd.Process.Pid)
	return cmd.Process.Release()
}
func stopManager(path string) error {
	pidFile := filepath.Join(filepath.Dir(path), "manager.pid")
	data, err := os.ReadFile(pidFile)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		return err
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	if err = signalManager(process); errors.Is(err, os.ErrProcessDone) || errors.Is(err, syscall.ESRCH) {
		return os.Remove(pidFile)
	}
	return err
}

func activeFile(path string) string { return filepath.Join(filepath.Dir(path), "active-binary") }
func activeBinary(path string) (string, error) {
	data, err := os.ReadFile(activeFile(path))
	if errors.Is(err, os.ErrNotExist) {
		return os.Executable()
	}
	if err != nil {
		return "", err
	}
	target := strings.TrimSpace(string(data))
	if target == "" {
		return "", errors.New("empty active-binary file")
	}
	return target, nil
}
func stageUpgrade(path, candidate string) error {
	source, err := os.ReadFile(candidate)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(source)
	suffix := ""
	if strings.HasSuffix(strings.ToLower(candidate), ".exe") {
		suffix = ".exe"
	}
	directory := filepath.Join(filepath.Dir(path), "versions")
	if err = os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	target := filepath.Join(directory, "gateway-"+hex.EncodeToString(sum[:12])+suffix)
	if err = os.WriteFile(target, source, 0700); err != nil {
		return err
	}
	if err = os.Chmod(target, 0700); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	check := exec.CommandContext(ctx, target, "--version")
	hideWorkerWindow(check)
	if err = check.Run(); err != nil {
		return fmt.Errorf("candidate cannot start: %w", err)
	}
	temp := activeFile(path) + ".new"
	if err = os.WriteFile(temp, []byte(target+"\n"), 0600); err != nil {
		return err
	}
	if err = os.Rename(temp, activeFile(path)); err != nil {
		return err
	}
	fmt.Println("Upgrade staged; manager will restart the worker after active Prompts finish.")
	return nil
}
