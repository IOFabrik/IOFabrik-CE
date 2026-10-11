package services

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// Exercise the real start path with the two messages emitted by gh. The
// subprocess remains alive, just as it does while waiting for browser sign-in.
func TestGitHubDeviceFlowSupportedCodeMessages(t *testing.T) {
	for _, message := range []string{
		"! First copy your one-time code: ABCD-1234",
		"! One-time code (ABCD-1234) copied to clipboard",
	} {
		t.Run(message, func(t *testing.T) {
			installFakeGh(t, "#!/bin/sh\nprintf '%s\\n' '"+message+"' >&2\nexec sleep 60\n")
			service := NewGitHubService()
			t.Cleanup(func() { service.AuthLoginCancel() })
			result := make(chan GitHubDeviceFlowResult, 1)
			go func() { result <- service.AuthLoginStart() }()
			select {
			case got := <-result:
				if !got.Success || got.UserCode != "ABCD-1234" {
					t.Fatal("supported device-code message was rejected")
				}
			case <-time.After(time.Second):
				service.AuthLoginCancel()
				<-result
				t.Fatal("supported device-code message left Connect waiting")
			}
		})
	}
}

func deviceFlowAttempt(service *GitHubService) *githubAuthAttempt {
	service.authMu.Lock()
	defer service.authMu.Unlock()
	return service.authAttempt
}

func awaitDeviceFlowResult(t *testing.T, results <-chan GitHubDeviceFlowResult) GitHubDeviceFlowResult {
	t.Helper()
	select {
	case result := <-results:
		return result
	case <-time.After(3 * time.Second):
		t.Fatal("device-flow request did not finish")
		return GitHubDeviceFlowResult{}
	}
}

func waitForDeviceFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("device-flow subprocess did not reach the test barrier")
}

func TestGitHubDeviceFlowCoalescesStartsAndPreservesSettings(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("IOFABRIK_DEVICE_FLOW_TEST_DIR", dir)
	config := filepath.Join(dir, "config.yml")
	settings := "clipboard: true\ngit_protocol: https\n"
	if err := os.WriteFile(config, []byte(settings), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GH_CONFIG_DIR", dir)
	installFakeGh(t, `#!/usr/bin/python3
import os, sys, time
d = os.environ['IOFABRIK_DEVICE_FLOW_TEST_DIR']
with open(d + '/launches', 'a') as f:
    f.write(' '.join(sys.argv[1:]) + '\n')
while not os.path.exists(d + '/release'):
    time.sleep(0.005)
print('! First copy your one-time code: ABCD-1234', file=sys.stderr, flush=True)
time.sleep(60)
`)
	service := NewGitHubService()
	t.Cleanup(func() { service.AuthLoginCancel() })
	results := make(chan GitHubDeviceFlowResult, 2)
	go func() { results <- service.AuthLoginStart() }()
	waitForDeviceFile(t, filepath.Join(dir, "launches"))
	first := deviceFlowAttempt(service)
	go func() { results <- service.AuthLoginStart() }()
	if err := os.WriteFile(filepath.Join(dir, "release"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if !awaitDeviceFlowResult(t, results).Success {
			t.Fatal("overlapping Connect request failed")
		}
	}
	if deviceFlowAttempt(service) != first {
		t.Fatal("overlapping start replaced the current process")
	}
	launches, err := os.ReadFile(filepath.Join(dir, "launches"))
	if err != nil || strings.Count(string(launches), "\n") != 1 || !strings.Contains(string(launches), "--clipboard=false") {
		t.Fatal("expected one CLI invocation with clipboard disabled")
	}
	stored, err := os.ReadFile(config)
	if err != nil || string(stored) != settings {
		t.Fatal("saved CLI settings changed")
	}
}

func TestGitHubDeviceFlowCancelDuringStartupReapsProcess(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("IOFABRIK_DEVICE_FLOW_TEST_DIR", dir)
	installFakeGh(t, `#!/usr/bin/python3
import os, time
with open(os.environ['IOFABRIK_DEVICE_FLOW_TEST_DIR'] + '/pid', 'w') as f:
    f.write(str(os.getpid()))
time.sleep(60)
`)
	service := NewGitHubService()
	results := make(chan GitHubDeviceFlowResult, 1)
	t.Cleanup(func() { service.AuthLoginCancel() })
	go func() { results <- service.AuthLoginStart() }()
	waitForDeviceFile(t, filepath.Join(dir, "pid"))
	attempt := deviceFlowAttempt(service)
	service.AuthLoginCancel()
	got := awaitDeviceFlowResult(t, results)
	if got.Success || !got.Cancelled || got.Error != "" {
		t.Fatal("intentional cancellation surfaced as an authentication failure")
	}
	select {
	case <-attempt.done:
	default:
		t.Fatal("cancel returned before the command was reaped")
	}
	if runtime.GOOS == "linux" {
		pid, err := os.ReadFile(filepath.Join(dir, "pid"))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(filepath.Join("/proc", string(pid))); !os.IsNotExist(err) {
			t.Fatal("cancelled subprocess still exists")
		}
	}
}

func TestGitHubDeviceFlowOldCleanupPreservesNewAttempt(t *testing.T) {
	installFakeGh(t, "#!/bin/sh\nprintf '%s\\n' '! One-time code (ABCD-1234) copied to clipboard' >&2\nexec sleep 60\n")
	service := NewGitHubService()
	if !service.AuthLoginStart().Success {
		t.Fatal("could not start initial attempt")
	}
	old := deviceFlowAttempt(service)
	t.Cleanup(func() { old.cancel(); <-old.done })
	// Force the reported ordering: a newer attempt is registered before the
	// cancelled older process finishes draining and runs its cleanup.
	service.authMu.Lock()
	service.authAttempt = nil
	service.authMu.Unlock()
	if !service.AuthLoginStart().Success {
		t.Fatal("could not start replacement attempt")
	}
	newer := deviceFlowAttempt(service)
	t.Cleanup(func() { service.AuthLoginCancel() })
	old.cancel()
	select {
	case <-old.done:
	case <-time.After(3 * time.Second):
		t.Fatal("old process was not reaped")
	}
	service.cancelAuthAttempt(old) // A stale completion must also be harmless.
	if deviceFlowAttempt(service) != newer || newer.ctx.Err() != nil {
		t.Fatal("old cleanup cleared or cancelled the newer attempt")
	}
}

func TestGitHubDeviceFlowShutdownReapsActiveProcess(t *testing.T) {
	installFakeGh(t, "#!/bin/sh\nprintf '%s\\n' '! First copy your one-time code: ABCD-1234' >&2\nexec sleep 60\n")
	service := NewGitHubService()
	t.Cleanup(func() { service.AuthLoginCancel() })
	if !service.AuthLoginStart().Success {
		t.Fatal("could not start sign-in")
	}
	attempt := deviceFlowAttempt(service)
	if err := service.ServiceShutdown(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-attempt.done:
	default:
		t.Fatal("shutdown returned before reaping the sign-in process")
	}
	if deviceFlowAttempt(service) != nil {
		t.Fatal("shutdown left an active attempt")
	}
}

func TestGitHubDeviceFlowFailureOutcomesAndRedaction(t *testing.T) {
	logger := GetDebugLogger()
	wasEnabled := logger.IsEnabled()
	logger.SetEnabled(true)
	t.Cleanup(func() { logger.SetEnabled(wasEnabled) })
	for _, test := range []struct {
		name, script, outcome, recovery string
	}{
		{"timeout", "#!/bin/sh\nexec sleep 60\n", "code_timeout", "Check your internet connection"},
		{"early exit", "#!/bin/sh\nprintf '%s\\n' 'failure ghp_fakeSecret ABCD-1234' >&2\nexit 7\n", "process_exit", "sign-in stopped"},
		{"unsupported output", "#!/bin/sh\nprintf '%s\\n' '! One-time code: unsupported' >&2\nexec sleep 60\n", "unrecognized_output", "code could not be read"},
		{"EOF without code", "#!/bin/sh\nprintf '%s\\n' 'unknown output' >&2\n", "unrecognized_output", "code could not be read"},
		{"missing executable", "#!/missing/device-flow-test-interpreter\n", "start_failed", "Check that GitHub CLI is installed"},
		{"reader error", "#!/usr/bin/python3\nimport sys\nsys.stderr.write('x' * 70000)\n", "read_error", "code could not be read"},
	} {
		t.Run(test.name, func(t *testing.T) {
			logger.Clear()
			installFakeGh(t, test.script)
			service := NewGitHubService()
			got := service.authLoginStart(150 * time.Millisecond)
			if got.Success || got.Cancelled || !strings.Contains(got.Error, test.recovery) {
				t.Fatal("failure did not return the expected recovery guidance")
			}
			// Wait for post-command diagnostics/cleanup before inspecting them.
			if attempt := deviceFlowAttempt(service); attempt != nil {
				<-attempt.done
			}
			entries := logger.GetEntries(LogFilter{})
			found := false
			for _, entry := range entries {
				if entry.Source == "GitHubService.AuthLoginStart" {
					found = true
					if entry.Message != "Device flow: "+test.outcome {
						t.Fatalf("wrong diagnostic outcome: %s", entry.Message)
					}
					if strings.Contains(entry.Details.Stderr, "ghp_fakeSecret") || strings.Contains(entry.Details.Stderr, "ABCD-1234") {
						t.Fatal("sensitive authentication output reached diagnostics")
					}
				}
			}
			if !found {
				t.Fatal("missing diagnostic outcome")
			}
		})
	}
}
