//go:build windows

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWindowsBatchAgent(t *testing.T) {
	for _, extension := range []string{"bat", "cmd"} {
		t.Run(extension, func(t *testing.T) {
			folder := t.TempDir()
			file := filepath.Join(folder, "agent wrapper."+extension)
			data := []byte("@if not \"%~1\"==\"argument with spaces\" exit /b 87\r\n@echo acp-wrapper-ok\r\n")
			if err := os.WriteFile(file, data, 0600); err != nil {
				t.Fatal(err)
			}
			cmd, err := newAgentCommand(filepath.ToSlash(file), []string{"argument with spaces"})
			if err != nil {
				t.Fatal(err)
			}
			cmd.Dir = folder
			output, err := cmd.CombinedOutput()
			if err != nil || string(output) != "acp-wrapper-ok\r\n" {
				t.Fatalf("unexpected wrapper result: %q (%v)", output, err)
			}
		})
	}
}
