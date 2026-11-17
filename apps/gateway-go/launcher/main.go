package main

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

// A small supervisor for the UI executable. The Windows release is built as a
// GUI subsystem application, so the web workspace does not leave a console open.
func main() {
	self, err := os.Executable()
	if err != nil {
		os.Exit(1)
	}
	directory := filepath.Dir(self)
	name := "acpao-linux-x64"
	if runtime.GOARCH == "arm64" {
		name = "acpao-linux-arm64"
	}
	if runtime.GOOS == "windows" {
		name = "acpao-windows-x64.exe"
	}
	binary := filepath.Join(directory, name)
	failures := 0
	for {
		command := exec.Command(binary, os.Args[1:]...)
		command.Dir = directory
		command.Env = append(os.Environ(), "ACPAO_SUPERVISED=1", "ACPAO_GUI_LAUNCH=1")
		command.Stdout = io.Discard // launch URL is a credential; never persist it.
		command.Stderr = io.Discard
		hideWindow(command)
		started := time.Now()
		err = command.Run()
		if err == nil {
			return
		}
		var exited *exec.ExitError
		if errors.As(err, &exited) && exited.ExitCode() == 75 {
			failures = 0
			continue
		}
		if time.Since(started) > time.Minute {
			failures = 0
		}
		failures++
		if failures >= 5 {
			os.Exit(1)
		}
		time.Sleep(2 * time.Second)
	}
}
