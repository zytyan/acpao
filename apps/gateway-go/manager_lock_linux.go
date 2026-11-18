package main

import (
	"bytes"
	"fmt"
	"os"
)

func matchesManagerCommand(pid int, path string) bool {
	cmd, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	return err == nil && bytes.Contains(cmd, []byte("\x00--manager\x00--config\x00"+path+"\x00"))
}
