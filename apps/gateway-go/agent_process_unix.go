//go:build !windows

package main

import "os/exec"

func newAgentCommand(command string, args []string) (*exec.Cmd, error) {
	return exec.Command(command, args...), nil
}
