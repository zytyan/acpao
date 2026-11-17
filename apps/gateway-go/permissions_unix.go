//go:build !windows

package main

import "os"

func secureStateDirectory(path string) error {
	if err := checkStateDirectory(path); err != nil {
		return err
	}
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	return os.Chmod(path, 0700)
}

func secureStateFile(path string) error { return os.Chmod(path, 0600) }
