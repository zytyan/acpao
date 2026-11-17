package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

func clientFor(ctx context.Context, c config) (*http.Client, func(), error) {
	if c.SSHJump == "" {
		return &http.Client{Timeout: 45 * time.Second}, func() {}, nil
	}
	dial, stop, err := startSSHTunnel(ctx, c)
	if err != nil {
		return nil, nil, err
	}
	return &http.Client{Transport: &http.Transport{DialContext: dial}, Timeout: 45 * time.Second}, stop, nil
}
func httpJSON(ctx context.Context, client *http.Client, base, token, method, path string, body any) (json.RawMessage, error) {
	var input io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		input = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimSuffix(base, "/")+path, input)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	response, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 4*1024*1024))
	if err != nil {
		return nil, err
	}
	if response.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d: %s", response.StatusCode, string(data))
	}
	return data, nil
}
func (g *gateway) sessionToken(session string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	client, stop, err := clientFor(ctx, g.config)
	if err != nil {
		return "", err
	}
	defer stop()
	raw, err := httpJSON(ctx, client, g.config.Center, g.config.Token, "POST", "/api/gateway/session-token", map[string]string{"session": session})
	if err != nil {
		return "", err
	}
	var value struct {
		Token string `json:"token"`
	}
	if err = json.Unmarshal(raw, &value); err != nil {
		return "", err
	}
	if len(value.Token) < 16 {
		return "", errors.New("center returned invalid session token")
	}
	return value.Token, nil
}
func runMCPBridge() error {
	base := os.Getenv("ACPAO_CENTER")
	token := os.Getenv("ACPAO_TOKEN")
	if base == "" || token == "" {
		return errors.New("MCP bridge requires center and session token")
	}
	c := config{Center: base, SSHJump: os.Getenv("ACPAO_SSH_JUMP"), SSHTarget: os.Getenv("ACPAO_SSH_TARGET")}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client, stop, err := clientFor(ctx, c)
	if err != nil {
		return err
	}
	defer stop()
	var writeMu sync.Mutex
	write := func(value any) {
		data, err := json.Marshal(value)
		if err != nil {
			return
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		_, _ = os.Stdout.Write(append(data, '\n'))
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := append([]byte(nil), scanner.Bytes()...)
		go func() {
			var msg struct {
				ID     json.RawMessage `json:"id"`
				Method string          `json:"method"`
				Params json.RawMessage `json:"params"`
			}
			if json.Unmarshal(line, &msg) != nil || len(msg.ID) == 0 {
				return
			}
			var result any
			var problem error
			switch msg.Method {
			case "initialize":
				var params struct {
					ProtocolVersion string `json:"protocolVersion"`
				}
				_ = json.Unmarshal(msg.Params, &params)
				if params.ProtocolVersion == "" {
					params.ProtocolVersion = "2025-03-26"
				}
				result = map[string]any{"protocolVersion": params.ProtocolVersion, "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]string{"name": "acpao", "version": "0.1"}}
			case "tools/list":
				var raw json.RawMessage
				raw, problem = httpJSON(ctx, client, base, token, "GET", "/api/tool-schema", nil)
				result = raw
			case "tools/call":
				var params struct {
					Name      string         `json:"name"`
					Arguments map[string]any `json:"arguments"`
				}
				if json.Unmarshal(msg.Params, &params) != nil || params.Name == "" {
					problem = errors.New("invalid tool call")
					break
				}
				var raw json.RawMessage
				raw, problem = httpJSON(ctx, client, base, token, "POST", "/api/tools/"+url.PathEscape(params.Name), params.Arguments)
				if problem == nil {
					result = map[string]any{"content": []any{map[string]string{"type": "text", "text": string(raw)}}}
				} else {
					result = map[string]any{"isError": true, "content": []any{map[string]string{"type": "text", "text": problem.Error()}}}
					problem = nil
				}
			default:
				problem = fmt.Errorf("method not found: %s", msg.Method)
			}
			if problem != nil {
				write(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "error": map[string]any{"code": -32603, "message": problem.Error()}})
			} else {
				write(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": result})
			}
		}()
	}
	return scanner.Err()
}
