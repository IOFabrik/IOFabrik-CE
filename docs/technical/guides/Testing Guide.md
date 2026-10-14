# Testing Guide

> Backend and frontend testing patterns.

## Backend Testing (Go)

### Running Tests

```bash
# All tests
go test ./services/... -v

# With coverage
go test ./services/... -coverprofile=coverage.out && go tool cover -html=coverage.out

# Specific service
go test ./services/ -run TestGitService -v

# Short mode (skip slow tests)
go test ./services/... -short
```

### Test Organization

Test files live alongside the code they test:
```
services/
├── git_service.go
├── git_service_test.go       # Tests for GitService
├── settings_service.go
├── settings_service_test.go  # Tests for SettingsService
├── runner.go
├── runner_test.go            # Tests for CommandRunner
└── ...
```

### Test Helpers

```go
// Create a temporary git repo for testing
func createTestRepo(t *testing.T) string {
    t.Helper()
    dir := t.TempDir()
    // Runs git init, creates initial commit
    return dir
}

// Cleanup (usually deferred)
func cleanupTestRepo(t *testing.T, path string) {
    t.Helper()
    os.RemoveAll(path)
}
```

Usage:
```go
func TestMyMethod(t *testing.T) {
    repo := createTestRepo(t)
    defer cleanupTestRepo(t, repo)
    
    service := NewGitService()
    result := service.MyMethod(repo)
    
    if !result.Success {
        t.Errorf("expected success, got: %s", result.Error)
    }
}
```

### Test Categories

| Category | Pattern | Example |
|----------|---------|---------|
| Unit tests | Test individual methods | CommandRunner parsing |
| Integration tests | Require real git repo | GitService commit workflow |
| CLI-dependent | Skip if CLI missing | `t.Skip("git not found")` |
| Table-driven | Multiple inputs/outputs | Status parsing, branch listing |

### Table-Driven Test Example

```go
func TestParseStatus(t *testing.T) {
    tests := []struct {
        name     string
        input    string
        expected []FileStatus
    }{
        {"empty", "", nil},
        {"modified file", " M file.txt", []FileStatus{{Path: "file.txt", Status: "modified"}}},
        {"added file", "?? new.txt", []FileStatus{{Path: "new.txt", Status: "untracked"}}},
    }
    
    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            result := parseStatus(tt.input)
            // assertions...
        })
    }
}
```

### Skip Pattern for Missing Tools

```go
func TestGitHubAuth(t *testing.T) {
    if _, err := exec.LookPath("gh"); err != nil {
        t.Skip("gh CLI not installed, skipping")
    }
    // test body...
}
```

### Current Test Coverage

39+ tests across services:
- `GitService` — Status, commit, branch, merge, stash
- `SettingsService` — Load/save settings, identity
- `FileSystemService` — File reading, directory listing
- `CommandRunner` — Execution, timeout, parsing
- `LFSService` — Pattern tracking, presets

## Frontend Testing (Vitest)

### Running Tests

```bash
cd frontend && npm test
```

### Configuration

Tests configured in `frontend/vitest.config.ts`:
- Test framework: Vitest
- Environment: jsdom
- Setup file: `src/shared/test/setup.ts`

### Test Files

```
frontend/src/
├── domain/
│   ├── analytics/analytics.test.ts
│   ├── auth/context/AuthContext.test.tsx
│   └── repo/context/RepoContext.analytics.test.tsx
├── features/
│   └── auth/components/LoginView.test.tsx
└── viewers/
    ├── registry/viewer-registry.test.ts
    └── components/shared/ViewerRenderer.test.tsx
```

### Frontend Test Patterns

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

describe('MyComponent', () => {
    it('renders correctly', () => {
        render(<MyComponent />);
        expect(screen.getByText('Expected Text')).toBeInTheDocument();
    });
    
    it('handles click', async () => {
        const onClick = vi.fn();
        render(<MyComponent onClick={onClick} />);
        await userEvent.click(screen.getByRole('button'));
        expect(onClick).toHaveBeenCalled();
    });
});
```

### Mocking Wails Bindings

```tsx
vi.mock('../../bindings/iofabrik/services/gitservice', () => ({
    GetStatus: vi.fn().mockResolvedValue([]),
    CommitAll: vi.fn().mockResolvedValue({ success: true }),
}));
```

## Writing Good Tests

1. **Test behavior, not implementation** — What does the user/caller see?
2. **One assertion per concept** — Test names describe expected behavior
3. **Use test helpers** — `createTestRepo()` for consistent setup
4. **Test error cases** — What happens when things fail?
5. **Skip gracefully** — Use `t.Skip()` when dependencies are missing

---

**Related:** [Adding a New Service](Adding%20a%20New%20Service.md) | [Build and Release](Build%20and%20Release.md)
