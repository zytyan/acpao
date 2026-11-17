//go:build windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

func hideWorkerWindow(cmd *exec.Cmd)          { cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }
func detachManager(cmd *exec.Cmd)             { cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }
func signalManager(process *os.Process) error { return process.Kill() }
