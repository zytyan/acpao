package main

import (
	"context"
	"encoding/json"
	"time"
)

type modelChoice struct {
	Value string `json:"value"`
	Name  string `json:"name"`
}

type sessionModel struct {
	ID      string        `json:"id"`
	Current string        `json:"current"`
	Choices []modelChoice `json:"choices"`
}

type modelConfig struct {
	Options []struct {
		ID       string `json:"id"`
		Category string `json:"category"`
		Type     string `json:"type"`
		Current  string `json:"currentValue"`
		Choices  []struct {
			modelChoice
			Options []modelChoice `json:"options"`
		} `json:"options"`
	} `json:"configOptions"`
}

func (c modelConfig) model() *sessionModel {
	var fallback *sessionModel
	for _, option := range c.Options {
		if option.Type != "select" || option.ID == "" || len(option.ID) > 512 || len(option.Current) > 512 ||
			(option.Category != "model" && !(option.ID == "model" && option.Category == "")) {
			continue
		}
		model := sessionModel{ID: option.ID, Current: option.Current}
		add := func(choice modelChoice) {
			if len(model.Choices) < 500 && choice.Value != "" && len(choice.Value) <= 512 && len(choice.Name) <= 512 {
				model.Choices = append(model.Choices, choice)
			}
		}
		for _, choice := range option.Choices {
			if choice.Options == nil {
				add(choice.modelChoice)
			}
			for _, child := range choice.Options {
				add(child)
			}
		}
		if len(model.Choices) == 0 {
			continue
		}
		if option.Category == "model" {
			return &model
		}
		fallback = &model
	}
	return fallback
}

// Called with p.mu held so configuration replies and updates publish in order.
func (p *acpProcess) publishModel(config modelConfig) {
	p.model = config.model()
	p.modelRevision++
	p.gateway.emit(p.session.ID, "session.model", p.model)
}

func (p *acpProcess) modelUpdate(raw json.RawMessage) {
	var config modelConfig
	if json.Unmarshal(raw, &config) == nil {
		p.publishModel(config)
	}
}

func (p *acpProcess) setModel(value string) (any, *wireError) {
	p.submitMu.Lock()
	p.mu.Lock()
	p.submitMu.Unlock()
	if p.closed || !p.ready {
		p.mu.Unlock()
		return fail("SESSION_UNAVAILABLE", "会话当前未连接")
	}
	if p.active != "" || len(p.queue) != 0 || p.settingModel {
		p.mu.Unlock()
		return fail("SESSION_BUSY", "请等待当前执行和排队消息完成后再切换模型")
	}
	model := p.model
	if model == nil {
		p.mu.Unlock()
		return fail("MODEL_UNSUPPORTED", "此 Agent 未提供模型选择")
	}
	found := false
	for _, choice := range model.Choices {
		if choice.Value == value {
			found = true
			break
		}
	}
	if !found {
		p.mu.Unlock()
		return fail("MODEL_NOT_FOUND", "此模型不在 Agent 提供的列表中")
	}
	if model.Current == value {
		p.mu.Unlock()
		return model, nil
	}
	revision := p.modelRevision
	p.settingModel = true
	p.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var result modelConfig
	err := p.request(ctx, "session/set_config_option", map[string]string{
		"sessionId": p.session.ACPID, "configId": model.ID, "value": value,
	}, &result)
	p.mu.Lock()
	if err == nil && !p.closed && revision == p.modelRevision {
		p.publishModel(result)
	}
	current, closed := p.model, p.closed
	p.settingModel = false
	p.startNextLocked()
	p.mu.Unlock()
	if closed || err != nil || current == nil || current.Current != value {
		return fail("MODEL_SWITCH_FAILED", "Agent 未确认模型切换，请查看当前模型后重试")
	}
	return current, nil
}
