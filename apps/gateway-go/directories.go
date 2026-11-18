package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

func (g *gateway) directory(path string) (string, error) {
	if !filepath.IsAbs(path) {
		return "", errors.New("工作目录必须是绝对路径")
	}
	root, err := filepath.EvalSymlinks(g.config.Root)
	if err != nil {
		return "", errors.New("主机工作根目录不可用")
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		return "", errors.New("工作目录不存在或不可访问")
	}
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", errors.New("目录超出主机允许的工作根目录")
	}
	if info, err := os.Stat(path); err != nil || !info.IsDir() {
		return "", errors.New("工作目录不是可访问的文件夹")
	}
	return path, nil
}

func (g *gateway) listDirectories(raw json.RawMessage) (any, *wireError) {
	var input struct {
		Cwd    string `json:"cwd"`
		Offset int    `json:"offset"`
	}
	if err := json.Unmarshal(raw, &input); err != nil || input.Offset < 0 || input.Offset > 1000000 {
		return fail("INVALID_DIRECTORY", "目录查询参数无效")
	}
	if input.Cwd == "" {
		input.Cwd = g.config.Root
	}
	path, err := g.directory(input.Cwd)
	if err != nil {
		return fail("INVALID_DIRECTORY", err.Error())
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return fail("DIRECTORY_UNREADABLE", "无法读取此目录")
	}
	children := make([]map[string]string, 0, 100)
	var next *int
	seen := 0
	for _, entry := range entries {
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		seen++
		if seen <= input.Offset {
			continue
		}
		if len(children) == 100 {
			offset := seen - 1
			next = &offset
			break
		}
		children = append(children, map[string]string{"name": entry.Name(), "path": filepath.Join(path, entry.Name())})
	}
	return map[string]any{"path": path, "entries": children, "next": next}, nil
}
