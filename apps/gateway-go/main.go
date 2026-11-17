package main

import (
	"bytes"
	"context"
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
	foreground := flag.Bool("foreground", false, "run worker in foreground (Docker)")
	daemon := flag.Bool("daemon", false, "run manager which restarts the worker")
	worker := flag.Bool("worker", false, "internal manager child")
	importIdentity := flag.String("import-identity", "", "import device identity")
	exportIdentity := flag.String("export-identity", "", "export device identity")
	flag.Parse()
	path := configPath(*file)
	if *pair {
		return pairDevice(path)
	}
	if *importIdentity != "" {
		return transferIdentity(path, *importIdentity, false)
	}
	if *exportIdentity != "" {
		return transferIdentity(path, *exportIdentity, true)
	}
	if *daemon && !(*foreground || *worker) {
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
	slog.Info("gateway started", "host", c.Host, "mode", func() string {
		if *worker {
			return "worker"
		}
		return "foreground"
	}())
	return g.run(ctx)
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
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	data, _ := json.MarshalIndent(c, "", "  ")
	if err = os.WriteFile(path, data, 0600); err != nil {
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
		return os.WriteFile(identityFile, value, 0600)
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
	return os.Rename(temp, configFile)
}
func supervise(path string) error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	for ctx.Err() == nil {
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
