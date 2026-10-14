package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/updater"
)

func TestAppUpdaterReleaseVerification(t *testing.T) {
	for _, test := range []struct {
		name             string
		currentVersion   string
		skipVersion      string
		wantNoUpdate     bool
		checksumAsset    bool
		checksumBody     string
		corrupt          bool
		wantCheckError   bool
		wantInstallError bool
	}{
		{name: "valid release", checksumAsset: true},
		{name: "already current", currentVersion: "0.0.2", wantNoUpdate: true},
		{name: "no downgrade", currentVersion: "0.0.3", wantNoUpdate: true},
		{name: "skipped for this session", checksumAsset: true, skipVersion: "0.0.2", wantNoUpdate: true},
		{name: "missing SHA256SUMS", wantCheckError: true},
		{name: "missing executable entry", checksumAsset: true, checksumBody: "invalid  other.exe\n", wantCheckError: true},
		{name: "malformed digest", checksumAsset: true, checksumBody: "invalid  iofabrik-windows-amd64.exe\n", wantCheckError: true},
		{name: "corrupt download", checksumAsset: true, corrupt: true, wantInstallError: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			body := "expected application bytes"
			digest := sha256.Sum256([]byte(body))
			manifest := fmt.Sprintf("%x  iofabrik-windows-amd64.exe\n", digest)
			if test.checksumBody != "" {
				manifest = test.checksumBody
			}
			downloads := 0
			originalTransport := http.DefaultTransport
			t.Cleanup(func() { http.DefaultTransport = originalTransport })
			http.DefaultTransport = updateTestTransport(func(req *http.Request) (*http.Response, error) {
				var response string
				switch req.URL.String() {
				case "https://api.github.com/repos/IOFabrik/IOFabrik-CE/releases/latest":
					// An installer with both platform/arch words comes first to exercise
					// Wails' installer exclusion, not only filename platform matching.
					assets := []map[string]any{
						{"name": "iofabrik-windows-amd64-installer.exe", "browser_download_url": "https://test.invalid/installer"},
						{"name": "iofabrik-windows-amd64.exe", "browser_download_url": "https://test.invalid/app"},
					}
					if test.checksumAsset {
						assets = append(assets, map[string]any{"name": "SHA256SUMS", "browser_download_url": "https://test.invalid/checksums"})
					}
					encoded, err := json.Marshal(map[string]any{"tag_name": "v0.0.2", "assets": assets})
					if err != nil {
						return nil, err
					}
					response = string(encoded)
				case "https://test.invalid/checksums":
					response = manifest
				case "https://test.invalid/app":
					downloads++
					response = body
					if test.corrupt {
						response = "corrupted application bytes"
					}
				default:
					return nil, fmt.Errorf("unexpected request (stable endpoint and executable required): %s", req.URL)
				}
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(response)), Request: req}, nil
			})
			version := test.currentVersion
			if version == "" {
				version = "0.0.1"
			}
			config, err := newAppUpdaterConfig(version)
			if err != nil {
				t.Fatal(err)
			}
			if config.CheckInterval != 0 {
				t.Fatal("Wails periodic UI checks must remain disabled")
			}
			if _, ok := config.Window.(*updater.BuiltinWindow); !ok {
				t.Fatal("expected built-in updater window")
			}
			config.Platform = "windows"
			config.Arch = "amd64"
			client := updater.New(updateTestHost{})
			if err := client.Init(config); err != nil {
				t.Fatal(err)
			}
			if test.skipVersion != "" {
				client.SkipVersion(test.skipVersion)
			}
			release, err := client.Check(context.Background())
			if test.wantNoUpdate {
				if err != nil || release != nil || downloads != 0 {
					t.Fatalf("expected no update: release=%v err=%v downloads=%d", release, err, downloads)
				}
				if test.skipVersion != "" {
					fresh := updater.New(updateTestHost{})
					if err := fresh.Init(config); err != nil {
						t.Fatal(err)
					}
					release, err := fresh.Check(context.Background())
					if err != nil || release == nil {
						t.Fatalf("skip persisted into a new updater session: %v", err)
					}
				}
				return
			}
			if test.wantCheckError {
				if err == nil || release != nil {
					t.Fatalf("check = %v, %v; want rejected release", release, err)
				}
				if downloads != 0 {
					t.Fatal("download occurred before checksum validation")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if release == nil || release.Version != "0.0.2" || release.Artifact.Filename != "iofabrik-windows-amd64.exe" {
				t.Fatalf("unexpected release: %+v", release)
			}
			err = client.DownloadAndInstall(context.Background())
			if test.wantInstallError {
				if err == nil || client.DownloadedPath() != "" || client.State() != updater.StateError {
					t.Fatalf("corrupt download was not rejected: %v", err)
				}
				if err := client.Restart(context.Background()); !errors.Is(err, updater.ErrNotReady) {
					t.Fatalf("restart = %v, want ErrNotReady", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			path := client.DownloadedPath()
			if path == "" {
				t.Fatal("verified download has no staged path")
			}
			t.Cleanup(func() {
				_ = os.Remove(path)
				_ = os.Remove(filepath.Dir(path))
			})
			actual, err := os.ReadFile(path)
			if err != nil || string(actual) != body {
				t.Fatalf("staged bytes = %q, error = %v", actual, err)
			}
			if client.State() != updater.StateReady {
				t.Fatalf("state = %v, want ready", client.State())
			}
		})
	}
}

type updateTestTransport func(*http.Request) (*http.Response, error)

func (f updateTestTransport) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

type updateTestHost struct{}

func (updateTestHost) Emit(string, ...any) bool         { return true }
func (updateTestHost) OnEvent(string, func(any)) func() { return func() {} }
func (updateTestHost) OpenWindow(updater.WindowOptions) updater.WindowHandle {
	panic("silent check must not open a window")
}
func (updateTestHost) Quit() { panic("test must not quit the application") }
