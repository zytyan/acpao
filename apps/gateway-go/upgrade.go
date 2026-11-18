package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func (g *gateway) downloadUpgrade() error {
	ctx, cancel := context.WithTimeout(context.Background(), 95*time.Second)
	defer cancel()
	client, stop, err := clientFor(ctx, g.config)
	if err != nil {
		return err
	}
	defer stop()
	client.Timeout = 90 * time.Second
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	req, err := http.NewRequestWithContext(ctx, "GET", strings.TrimRight(g.config.Center, "/")+"/api/gateway/update", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+g.config.Token)
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("中心未提供 Gateway 升级文件（HTTP %d）", res.StatusCode)
	}
	name := "gateway-incoming-*"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	file, err := os.CreateTemp(filepath.Dir(g.configPath), name)
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	const limit = 64 << 20
	size, err := io.Copy(file, io.LimitReader(res.Body, limit+1))
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if size == 0 || size > limit {
		return errors.New("Gateway 文件大小无效")
	}
	return stageUpgrade(g.configPath, file.Name())
}
