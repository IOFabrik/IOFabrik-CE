# Adding a New Service

> Step-by-step guide for adding a new Go backend service.

## Prerequisites

- Go development environment set up
- Understanding of [Backend Architecture](../backend/Backend%20Architecture.md) and [Services Index](../backend/Services%20Index.md)
- Wails CLI installed (`wails3`)

## Steps

### 1. Create the Service File

Create `services/myservice.go`:

```go
package services

// MyService handles <description>.
type MyService struct {
    runner *CommandRunner
    app    *application.App // Only if you need to emit events
}

// NewMyService creates a new MyService instance.
func NewMyService() *MyService {
    return &MyService{
        runner: NewCommandRunner(),
    }
}

// SetApp wires the Wails app for event emission.
// Only implement this if your service needs to emit events.
func (s *MyService) SetApp(app *application.App) {
    s.app = app
}

// DoSomething performs <operation>.
// Exported methods become TypeScript bindings automatically.
func (s *MyService) DoSomething(repoPath string, param string) OperationResult {
    result := s.runner.RunGit(repoPath, "some-command", param)
    if !result.Success {
        return failedOp(result.Error)
    }
    return successOp("Operation completed")
}
```

### 2. Register in main.go

Add to the `Services` slice:

```go
app := application.New(application.Options{
    Services: []application.Service{
        // ... existing services
        application.NewService(services.NewMyService()),
    },
})
```

If the service emits events, add `SetApp()` call after app creation:

```go
myService := services.NewMyService()
// ... in Services: application.NewService(myService),
// After app := application.New(...)
myService.SetApp(app)
```

### 3. Register Events (if applicable)

If your service emits events, register them in `main.go`:

```go
application.RegisterEvent[services.MyEventPayload]("my-event-name")
```

### 4. Generate Bindings

```bash
task common:generate:bindings
```

Or just run `task dev` — bindings auto-regenerate in dev mode.

### 5. Use in Frontend

Import the generated binding:

```tsx
import { DoSomething } from '../../bindings/iofabrik/services/myservice';
import type { OperationResult } from '../../bindings/iofabrik/services/models';

const result = await DoSomething(repoPath, "param");
if (result.success) {
    toast.success(result.message);
} else {
    toast.error(result.error);
}
```

### 6. Write Tests

Create `services/myservice_test.go`:

```go
package services

import "testing"

func TestDoSomething(t *testing.T) {
    repo := createTestRepo(t)
    defer cleanupTestRepo(t, repo)
    
    service := NewMyService()
    result := service.DoSomething(repo, "test-param")
    
    if !result.Success {
        t.Errorf("Expected success, got error: %s", result.Error)
    }
}
```

## Checklist

- [ ] Service struct with constructor (`NewMyService()`)
- [ ] `CommandRunner` usage (if running CLI commands)
- [ ] `OperationResult` return for mutations
- [ ] Registered in `main.go` `Services` slice
- [ ] `SetApp()` wired (if emitting events)
- [ ] Events registered (if applicable)
- [ ] Bindings generated
- [ ] Tests written
- [ ] Documentation page created in `docs/technical/backend/services/`

---

**Related:** [Backend Architecture](../backend/Backend%20Architecture.md) | [Services Index](../backend/Services%20Index.md) | [Testing Guide](Testing%20Guide.md)
