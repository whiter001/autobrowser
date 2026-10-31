package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
)

// 链接时由 go build -ldflags "-X main.defaultBunPath=..." 注入的默认值；
// 为空表示沿用 PATH 与相对启动器的布局探测。
var (
	defaultBunPath   string
	defaultDistEntry string
)

// resolveOverride 优先使用显式环境变量，其次使用编译期注入的默认值。
func resolveOverride(envValue, embedded string) string {
	if envValue != "" {
		return envValue
	}
	return embedded
}

func resolveBun(override string) (string, error) {
	name := "bun"
	if runtime.GOOS == "windows" {
		name = "bun.exe"
	}
	if override != "" {
		name = override
	}
	bun, err := exec.LookPath(name)
	if err != nil {
		return "", fmt.Errorf("cannot find Bun (%s): install Bun and add it to PATH, or set AUTOBROWSER_BUN_PATH: %w", name, err)
	}
	return bun, nil
}

func distCandidates(executable string) []string {
	dir := filepath.Dir(executable)
	packagePath := filepath.Join("node_modules", "@whiter001", "autobrowser", "dist", "autobrowser.js")
	return []string{
		filepath.Join(dir, packagePath),
		filepath.Join(dir, "..", "lib", packagePath),
		filepath.Join(dir, "..", "@whiter001", "autobrowser", "dist", "autobrowser.js"),
		filepath.Join(dir, "..", "dist", "autobrowser.js"),
	}
}

func resolveDist(executable, override string) (string, error) {
	candidates := distCandidates(executable)
	if override != "" {
		candidates = []string{override}
	}
	for _, candidate := range candidates {
		info, err := os.Stat(candidate)
		if err == nil && info.Mode().IsRegular() {
			return filepath.Abs(candidate)
		}
	}
	return "", fmt.Errorf("cannot find dist/autobrowser.js (checked %v); reinstall @whiter001/autobrowser or set AUTOBROWSER_DIST_ENTRY", candidates)
}

func bunArgs(distEntry string, args []string) []string {
	return append([]string{distEntry}, args...)
}

func run() int {
	bun, err := resolveBun(resolveOverride(os.Getenv("AUTOBROWSER_BUN_PATH"), defaultBunPath))
	if err != nil {
		fmt.Fprintln(os.Stderr, "[autobrowser]", err)
		return 1
	}
	executable, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, "[autobrowser] cannot locate launcher:", err)
		return 1
	}
	dist, err := resolveDist(executable, resolveOverride(os.Getenv("AUTOBROWSER_DIST_ENTRY"), defaultDistEntry))
	if err != nil {
		fmt.Fprintln(os.Stderr, "[autobrowser]", err)
		return 1
	}
	cmd := exec.Command(bun, bunArgs(dist, os.Args[1:])...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr

	// POSIX 也转发单独发给启动器的信号；同组终端信号可能重复送达，不创建额外后台进程组。
	// Windows 不支持 Process.Signal，控制台 Ctrl-C 由系统广播给 Bun，启动器等待它退出。
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "[autobrowser] cannot start Bun:", err)
		return 1
	}
	done := make(chan struct{})
	defer close(done)
	go func() {
		for {
			select {
			case sig := <-signals:
				if runtime.GOOS != "windows" {
					_ = cmd.Process.Signal(sig)
				}
			case <-done:
				return
			}
		}
	}()
	if err := cmd.Wait(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() {
				return 128 + int(status.Signal())
			}
			return exitErr.ExitCode()
		}
		fmt.Fprintln(os.Stderr, "[autobrowser] Bun failed:", err)
		return 1
	}
	return 0
}

func main() { os.Exit(run()) }
