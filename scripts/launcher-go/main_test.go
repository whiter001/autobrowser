package main

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func writeFixture(t *testing.T, name string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(name), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, []byte("fixture"), 0755); err != nil {
		t.Fatal(err)
	}
}

func TestResolveDistLayouts(t *testing.T) {
	for _, layout := range []struct{ executable, dist string }{
		{"autobrowser.exe", "node_modules/@whiter001/autobrowser/dist/autobrowser.js"},
		{"bin/autobrowser", "lib/node_modules/@whiter001/autobrowser/dist/autobrowser.js"},
		{"node_modules/.bin/autobrowser", "node_modules/@whiter001/autobrowser/dist/autobrowser.js"},
		{"package/launchers/autobrowser", "package/dist/autobrowser.js"},
	} {
		t.Run(layout.executable, func(t *testing.T) {
			root := t.TempDir()
			want := filepath.Join(root, filepath.FromSlash(layout.dist))
			writeFixture(t, want)
			got, err := resolveDist(filepath.Join(root, filepath.FromSlash(layout.executable)), "")
			if err != nil || got != want {
				t.Fatalf("got %q, %v; want %q", got, err, want)
			}
		})
	}
}

func TestDistOverride(t *testing.T) {
	root := t.TempDir()
	exe := filepath.Join(root, "autobrowser")
	writeFixture(t, distCandidates(exe)[0])
	override := filepath.Join(root, "custom entry.js")
	writeFixture(t, override)
	got, err := resolveDist(exe, override)
	if err != nil || got != override {
		t.Fatalf("override not preferred: %q, %v", got, err)
	}
	for _, missing := range []string{filepath.Join(root, "missing.js"), root} {
		if _, err := resolveDist(exe, missing); err == nil || !strings.Contains(err.Error(), "AUTOBROWSER_DIST_ENTRY") {
			t.Fatalf("invalid override must not fall back: %v", err)
		}
	}
	if _, err := resolveDist(filepath.Join(root, "elsewhere", "autobrowser"), ""); err == nil {
		t.Fatal("missing dist accepted")
	}
}

// fakeBunName 返回当前平台可被 LookPath 找到的 Bun 文件名。
func fakeBunName() string {
	if runtime.GOOS == "windows" {
		return "bun.exe"
	}
	return "bun"
}

func TestBunOverrideAndPath(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	got, err := resolveBun(executable)
	if err != nil || got != executable {
		t.Fatalf("Bun override ignored: %q, %v", got, err)
	}
	binDir := t.TempDir()
	fakeBun := filepath.Join(binDir, fakeBunName())
	writeFixture(t, fakeBun)
	t.Setenv("PATH", binDir)
	got, err = resolveBun("")
	if err != nil || got != fakeBun {
		t.Fatalf("Bun PATH lookup failed: %q, %v", got, err)
	}
	t.Setenv("PATH", t.TempDir())
	for _, override := range []string{"", filepath.Join(t.TempDir(), "missing-bun")} {
		if _, err := resolveBun(override); err == nil || !strings.Contains(err.Error(), "AUTOBROWSER_BUN_PATH") {
			t.Fatalf("expected helpful missing Bun error: %v", err)
		}
	}
}

func TestBunArgs(t *testing.T) {
	args := []string{"eval", `return "a&b|c^d<e>%PATH%"`, "", "two words", "line\nline"}
	got := bunArgs("/path with spaces/dist.js", args)
	want := append([]string{"/path with spaces/dist.js"}, args...)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("arguments changed: %#v", got)
	}
	got[1] = "changed"
	if args[0] != "eval" {
		t.Fatal("argument construction mutated input")
	}
}

func TestResolveOverridePrefersEnvironment(t *testing.T) {
	if got := resolveOverride("env", "embedded"); got != "env" {
		t.Fatalf("environment override ignored: %q", got)
	}
	if got := resolveOverride("", "embedded"); got != "embedded" {
		t.Fatalf("embedded default ignored: %q", got)
	}
	if got := resolveOverride("", ""); got != "" {
		t.Fatalf("expected empty override: %q", got)
	}
}

func TestEmbeddedDefaults(t *testing.T) {
	oldBun, oldDist := defaultBunPath, defaultDistEntry
	defer func() { defaultBunPath, defaultDistEntry = oldBun, oldDist }()

	root := t.TempDir()
	fakeBun := filepath.Join(root, fakeBunName())
	writeFixture(t, fakeBun)
	distFile := filepath.Join(root, "dist", "autobrowser.js")
	writeFixture(t, distFile)
	defaultBunPath = fakeBun
	defaultDistEntry = distFile

	bun, err := resolveBun(resolveOverride("", defaultBunPath))
	if err != nil || bun != fakeBun {
		t.Fatalf("embedded Bun default ignored: %q, %v", bun, err)
	}
	dist, err := resolveDist(filepath.Join(root, "autobrowser"), resolveOverride("", defaultDistEntry))
	if err != nil || dist != distFile {
		t.Fatalf("embedded dist default ignored: %q, %v", dist, err)
	}
}

func TestEmbeddedDefaultsDoNotFallBackSilently(t *testing.T) {
	oldBun, oldDist := defaultBunPath, defaultDistEntry
	defer func() { defaultBunPath, defaultDistEntry = oldBun, oldDist }()

	root := t.TempDir()
	defaultBunPath = filepath.Join(root, "missing-bun")
	defaultDistEntry = filepath.Join(root, "missing-dist.js")
	if _, err := resolveBun(resolveOverride("", defaultBunPath)); err == nil {
		t.Fatal("missing embedded Bun accepted")
	}
	if _, err := resolveDist(filepath.Join(root, "autobrowser"), resolveOverride("", defaultDistEntry)); err == nil {
		t.Fatal("missing embedded dist accepted")
	}
}
