//go:build windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

func newAgentCommand(command string, args []string) (*exec.Cmd, error) {
	path, err := exec.LookPath(command)
	if err != nil {
		return nil, err
	}
	extension := strings.ToLower(filepath.Ext(path))
	if extension != ".cmd" && extension != ".bat" {
		cmd := exec.Command(path, args...)
		hideWorkerWindow(cmd)
		return cmd, nil
	}
	parts := append([]string{filepath.FromSlash(path)}, args...)
	for i, part := range parts {
		if strings.ContainsAny(part, "\"%&|<>^!") || strings.ContainsFunc(part, func(r rune) bool { return r < 32 }) {
			return nil, errors.New("Windows 批处理启动器无法安全传递该参数，请改用实际的 .exe 或用 node.exe 启动适配器脚本")
		}
		parts[i] = "\"" + part + "\""
	}
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	shell := filepath.Join(root, "System32", "cmd.exe")
	cmd := exec.Command(shell)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow: true,
		CmdLine:    syscall.EscapeArg(shell) + ` /d /v:off /s /c "` + strings.Join(parts, " ") + `"`,
	}
	return cmd, nil
}
