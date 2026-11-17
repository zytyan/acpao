//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"os/user"
)

func restrictStatePath(path, permission string) error {
	current, err := user.Current()
	if err != nil {
		return err
	}
	if current.Uid == "" {
		return fmt.Errorf("current Windows user SID unavailable")
	}
	cmd := exec.Command("icacls", path, "/inheritance:r", "/grant:r", "*"+current.Uid+":"+permission)
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("restrict Gateway state permissions: %w: %s", err, output)
	}
	return nil
}

func secureStateDirectory(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	return restrictStatePath(path, "(OI)(CI)F")
}

func secureStateFile(path string) error { return restrictStatePath(path, "F") }
