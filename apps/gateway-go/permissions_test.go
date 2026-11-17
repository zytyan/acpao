package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStateDirectoryMustBeDedicated(t *testing.T) {
	for _, path := range []string{string(filepath.Separator), os.TempDir()} {
		if err := checkStateDirectory(path); err == nil {
			t.Errorf("shared directory %q was accepted", path)
		}
	}
	if err := checkStateDirectory(filepath.Join(t.TempDir(), ".gateway")); err != nil {
		t.Fatal(err)
	}
}
