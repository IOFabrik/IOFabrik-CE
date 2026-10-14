# AppUpdateService

> Coordinates update checks and the Wails update window for production Windows x64 builds.

## Responsibility

`services/app_update_service.go` is the frontend-facing coordinator around
Wails' application updater. `main.go` creates and registers the service after
the Wails application exists, then initializes the GitHub provider in
`app_update.go` when updates are supported.

The service is enabled only when all three conditions are true:

- the binary was built with the `production` build tag;
- the operating system is Windows; and
- the architecture is AMD64.

Development builds and other operating system or architecture combinations keep
the service registered so generated bindings remain stable, but update methods
perform no work.

## Exported methods

| Method | Result | Behavior |
|---|---|---|
| `GetCurrentVersion()` | `string` | Returns the build version after trimming whitespace and one leading `v`. |
| `CheckForUpdates()` | `error` | Opens Wails' update flow on supported builds. It returns without action when updates are disabled. |

The General Settings view calls these methods to display the current version and
run a manual check. A mutex serializes manual checks with background checks so
only one updater operation can run at a time.

## Lifecycle

The service subscribes to Wails' `ApplicationStarted` event. After startup it
runs one silent provider check and schedules another check every six hours. A
background check opens the updater window only after it finds a newer stable
release. Provider failures are logged and do not interrupt startup.

`ServiceShutdown()` stops the timer, cancels in-flight work through the service
context, and removes the lifecycle subscription. Wails treats this as a service
lifecycle method and does not expose it to the frontend.

## Release and installation integration

The provider targets stable releases in `IOFabrik/IOFabrik-CE` and
requires the selected executable to have a SHA-256 digest in `SHA256SUMS`.
`SyncWindowsInstallRegistryVersion()` updates the NSIS per-user uninstall entry
after an in-place update so Windows Installed Apps displays the running version.
A missing uninstall entry is treated as a valid portable or development setup.

The asset names, signing requirements, registry path, and end-to-end test steps
are documented in [Auto-Updater](../../infrastructure/Auto-Updater.md).

## Tests

```bash
go test . ./services/...
```

The Go suites cover provider verification, version normalization, availability,
serialization, scheduling, shutdown, and registry synchronization. The Windows
verification bundle adds native updater and release-verifier checks; see the
Auto-Updater guide for its PowerShell command.

**Related:** [Services Index](../Services%20Index.md) | [Auto-Updater](../../infrastructure/Auto-Updater.md) | [Build and Release](../../guides/Build%20and%20Release.md)
