//go:build !linux && !windows

package main

func matchesManagerCommand(_ int, _ string) bool { return true }
