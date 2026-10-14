package services

import (
	"context"
	"io"
	"os"
	"testing"
	"time"
)

func TestNewCommandRunner(t *testing.T) {
	runner := NewCommandRunner()
	if runner == nil {
		t.Fatal("Expected runner to be non-nil")
	}
	if runner.Timeout != 30*time.Second {
		t.Errorf("Expected default timeout of 30s, got %v", runner.Timeout)
	}
}

func TestRun_SimpleCommand(t *testing.T) {
	runner := NewCommandRunner()

	result := runner.Run(".", "echo", "hello")

	if !result.Success {
		t.Errorf("Expected success, got error: %s", result.Error)
	}
	if result.ExitCode != 0 {
		t.Errorf("Expected exit code 0, got %d", result.ExitCode)
	}
	if result.Stdout != "hello\n" {
		t.Errorf("Expected stdout 'hello\\n', got '%s'", result.Stdout)
	}
}

func TestRun_CommandNotFound(t *testing.T) {
	runner := NewCommandRunner()

	result := runner.Run(".", "nonexistent-command-that-does-not-exist")

	if result.Success {
		t.Error("Expected failure for non-existent command")
	}
	if result.ExitCode == 0 {
		t.Error("Expected non-zero exit code")
	}
}

func TestRun_CommandWithStderr(t *testing.T) {
	runner := NewCommandRunner()

	result := runner.Run(".", "sh", "-c", "echo error >&2 && exit 1")

	if result.Success {
		t.Error("Expected failure")
	}
	if result.ExitCode != 1 {
		t.Errorf("Expected exit code 1, got %d", result.ExitCode)
	}
	if result.Stderr != "error\n" {
		t.Errorf("Expected stderr 'error\\n', got '%s'", result.Stderr)
	}
}

func TestRunWithContext_Timeout(t *testing.T) {
	runner := NewCommandRunner()

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	result := runner.RunWithContext(ctx, ".", "sleep", "5")

	if result.Success {
		t.Error("Expected command to fail due to timeout")
	}
}

// Run the test binary itself so timeout/cancellation coverage is portable.
func TestCommandRunnerContextHelper(t *testing.T) {
	if os.Getenv("IOFABRIK_RUNNER_CONTEXT_HELPER") == "1" {
		time.Sleep(time.Minute)
	}
}

func TestCommandRunnerPreservesContextFailure(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("IOFABRIK_RUNNER_CONTEXT_HELPER", "1")
	runner := NewCommandRunner()
	for _, variant := range []struct {
		name string
		run  func(context.Context) CommandResult
	}{
		{"capture", func(ctx context.Context) CommandResult {
			return runner.RunWithContext(ctx, "", executable, "-test.run=^TestCommandRunnerContextHelper$")
		}},
		{"stdin", func(ctx context.Context) CommandResult {
			return runner.RunWithContextAndStdin(ctx, "", "", executable, "-test.run=^TestCommandRunnerContextHelper$")
		}},
		{"stream", func(ctx context.Context) CommandResult {
			return runner.runWithStderr(ctx, io.Discard, executable, "-test.run=^TestCommandRunnerContextHelper$")
		}},
	} {
		t.Run(variant.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			result := variant.run(ctx)
			if result.Success || result.Error != context.DeadlineExceeded.Error() {
				t.Fatalf("expected deadline cause after killing the child process, got %#v", result)
			}

			cancelled, cancelNow := context.WithCancel(context.Background())
			cancelNow()
			result = variant.run(cancelled)
			if result.Success || result.Error != context.Canceled.Error() {
				t.Fatalf("expected cancellation to remain distinct from timeout, got %#v", result)
			}
		})
	}
}

func TestRunGit_Version(t *testing.T) {
	runner := NewCommandRunner()

	result := runner.RunGit(".", "--version")

	if !result.Success {
		t.Skipf("Git not available: %s", result.Error)
	}
	if result.Stdout == "" {
		t.Error("Expected git version output")
	}
}

func TestMustRunGit_Success(t *testing.T) {
	runner := NewCommandRunner()

	output, err := runner.MustRunGit(".", "--version")

	if err != nil {
		t.Skipf("Git not available: %v", err)
	}
	if output == "" {
		t.Error("Expected non-empty output")
	}
}

func TestMustRunGit_Failure(t *testing.T) {
	runner := NewCommandRunner()

	_, err := runner.MustRunGit(".", "invalid-subcommand")

	if err == nil {
		t.Error("Expected error for invalid git command")
	}
}

func TestRun_WorkingDirectory(t *testing.T) {
	runner := NewCommandRunner()

	result := runner.Run("/tmp", "pwd")

	if !result.Success {
		t.Errorf("Expected success, got error: %s", result.Error)
	}
	// On macOS /tmp is a symlink to /private/tmp
	if result.Stdout != "/tmp\n" && result.Stdout != "/private/tmp\n" {
		t.Errorf("Expected working directory /tmp, got '%s'", result.Stdout)
	}
}

func TestRun_CommandWithArgs(t *testing.T) {
	runner := NewCommandRunner()

	result := runner.Run(".", "echo", "-n", "no-newline")

	if !result.Success {
		t.Errorf("Expected success, got error: %s", result.Error)
	}
	if result.Stdout != "no-newline" {
		t.Errorf("Expected 'no-newline', got '%s'", result.Stdout)
	}
}
