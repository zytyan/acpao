package main

import (
	"fmt"
	"os"
	"path/filepath"
)

func checkStateDirectory(path string) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	if absolute == filepath.Dir(absolute) {
		return fmt.Errorf("Gateway state needs a dedicated directory: %s", absolute)
	}
	for _, common := range []func() (string, error){os.Getwd, os.UserHomeDir} {
		value, err := common()
		if err == nil && absolute == filepath.Clean(value) {
			return fmt.Errorf("Gateway state needs a dedicated directory: %s", absolute)
		}
	}
	if absolute == filepath.Clean(os.TempDir()) {
		return fmt.Errorf("Gateway state needs a dedicated directory: %s", absolute)
	}
	return nil
}
