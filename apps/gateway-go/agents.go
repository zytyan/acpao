package main

import (
	"encoding/json"
	"os"
	"regexp"
	"slices"
	"strings"
)

var agentIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

func redactAgentEnv(message string, env map[string]string) string {
	for name, value := range env {
		if !secretName.MatchString(name) {
			continue
		}
		for _, secret := range []string{value, os.ExpandEnv(value)} {
			if len(secret) >= 6 {
				message = strings.ReplaceAll(message, secret, "[已隐藏]")
			}
		}
	}
	return message
}

func (g *gateway) agents() []agentConfig {
	agents := append([]agentConfig{}, g.config.Agents...)
	entries, _ := g.store.all("managed-agent")
	for _, value := range entries {
		var item agentConfig
		if json.Unmarshal(value, &item) != nil {
			continue
		}
		index := slices.IndexFunc(agents, func(agent agentConfig) bool { return agent.ID == item.ID })
		if index < 0 {
			agents = append(agents, item)
		} else {
			agents[index] = item
		}
	}
	return agents
}

func (g *gateway) publicAgents() []agentConfig {
	agents := g.agents()
	for i := range agents {
		agents[i].Env = map[string]string{}
		agents[i].Args = []string{}
	}
	return agents
}

func (g *gateway) agentCommand(action string, payload json.RawMessage) (any, *wireError) {
	var input struct {
		Agent agentConfig `json:"agent"`
		Key   string      `json:"key"`
	}
	if json.Unmarshal(payload, &input) != nil {
		return fail("INVALID_COMMAND", "Agent 配置有误")
	}
	agents := g.agents()
	if action == "agent.get" {
		for _, agent := range agents {
			if agent.ID == input.Key {
				if agent.Args == nil {
					agent.Args = []string{}
				}
				if agent.Env == nil {
					agent.Env = map[string]string{}
				}
				return agent, nil
			}
		}
		return fail("AGENT_NOT_FOUND", "Agent 配置不存在")
	}
	if action != "agent.configure" {
		return fail("UNSUPPORTED", "网关不支持该 Agent 操作")
	}
	agent := input.Agent
	if !agentIDPattern.MatchString(agent.ID) || len(agent.Name) == 0 || agent.Command == "" {
		return fail("INVALID_COMMAND", "Agent 配置有误")
	}
	if !g.agentMu.TryLock() {
		return fail("AGENT_PROBE_BUSY", "正在测试另一项 Agent 配置，请稍后重试")
	}
	defer g.agentMu.Unlock()
	agents = g.agents()
	updated := slices.ContainsFunc(agents, func(item agentConfig) bool { return item.ID == agent.ID })
	if !updated && len(agents) >= 30 {
		return fail("AGENT_LIMIT", "每台主机最多配置 30 个 Agent")
	}
	test := session{ID: newID("probe"), Host: g.config.Host, Cwd: g.config.Root, Agent: agent.ID}
	if err := g.launchAgent(&test, agent, false, true); err != nil {
		message := redactAgentEnv(err.Error(), agent.Env)
		g.diagnostic("error", "AGENT_PROBE_FAILED", message, "", agent.ID)
		return map[string]any{"ok": false, "probe": map[string]string{"stage": "launch", "message": message}}, nil
	}
	if err := g.store.put("managed-agent", agent.ID, agent); err != nil {
		return fail("AGENT_SAVE_FAILED", "网关无法保存 Agent 配置")
	}
	g.emit("", "agents", g.publicAgents())
	return map[string]any{"ok": true, "updated": updated, "probe": map[string]string{"stage": "session", "message": "远程 ACP 会话已创建"}}, nil
}
