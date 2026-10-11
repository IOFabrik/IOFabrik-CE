# Auto-Updater

> How IOFabrik discovers, verifies, installs, releases, and tests application updates.

IOFabrik uses Wails v3's built-in updater in production Windows x64 builds.
`services/app_update_service.go` exposes `GetCurrentVersion()` and
`CheckForUpdates()`. Development builds, macOS, Linux, and Windows ARM64 do not
perform self-updates. Updater-enabled releases use the native Windows build
tasks; the Docker Windows build is outside this support scope.

## Checking and installing

`main.go` uses `app_update.go` to configure the GitHub provider for `IOFabrik/IOFabrik-CE`,
with `Prerelease: false`, `ChecksumAsset: "SHA256SUMS"`, and the built-in window.
The current version comes from `main.Version`, with surrounding whitespace and
one leading `v` removed.

The application-started hook performs a silent `Check()`. A six-hour timer
schedules subsequent checks. A mutex serializes manual and background operations.
Background checks with no release or a provider error do not open a window;
errors are logged. A discovered release triggers `CheckAndInstall()`, which
opens Wails' window, downloads, verifies, and stages the executable. The user
chooses **Restart & Apply** to replace the running version.

General Settings has a current version and **Check for updates** button on
production Windows x64 builds. Wails' skip-version choice lasts only for the
current session. No update preference is persisted in `AppSettings`.

Wails' `Config.CheckInterval` remains unset because its periodic check opens a
window even when the application is current. Shutdown cancels the coordinator
context, stops the timer, and removes the lifecycle subscription.

## Release assets

Stable releases use a `vX.Y.Z` tag and these exact assets:

- `iofabrik-windows-amd64.exe`: signed executable for in-place updates.
- `iofabrik-amd64-installer.exe`: signed NSIS installer for first installation.
- `SHA256SUMS`: SHA-256 hashes of exactly those two files, with their unversioned names.

Wails excludes installer assets when selecting the executable. Our provider wrapper
requires a SHA-256 digest from `SHA256SUMS`: Wails beta.16 otherwise treats a missing
checksum asset as optional. Wails verifies downloaded bytes before staging an update.
Authenticode is validated during release preparation; checksum verification is
the application's update verification mechanism. No Ed25519 manifest or
`update.json` feed is used.

Run `scripts/create-release.sh` in Git Bash on Windows. It stages the required
files, calls `verify-release.ps1` to verify timestamped Authenticode signatures
before hashing, and validates the staged checksums. `--validate-only` checks
existing output without rewriting it; `--upload` creates a GitHub release only
after validation. See [Build and Release](../guides/Build%20and%20Release.md).

## Windows installation metadata

NSIS installs per user under `%LOCALAPPDATA%\IOFabrik\app`. It removes
any legacy `cz-updater.exe` on installation. The application updates
`DisplayVersion` in the per-user uninstall entry at startup after an update;
a missing entry is a no-op. Generated NSIS metadata uses
`Software\Microsoft\Windows\CurrentVersion\Uninstall\IOFabrikIOFabrik`.
Wails derives that final key component by joining the configured company name
and product name. Both values are `IOFabrik`, so the repeated name is the
expected generated key. Version synchronization also checks the legacy
`ControlZebraControlZebra` key for copies updated in place. Only the entry whose
`DisplayIcon` matches the running executable receives the new version. Running the new
installer retires previous shortcuts and registered installs at the known
ControlZebra default locations; custom install locations remain intact.

The previous branding passed a Windows x64 0.0.1 to 0.0.2 update test.
The IOFabrik installer and upgrade still require a native Windows smoke test.

## Verification

```bash
go build ./...
go test . ./services/...
python3 scripts/test-create-release.py
node --test scripts/generate-windows-version-info.test.mjs
```

On Windows, run `powershell -NoProfile -File scripts/test-verify-release.ps1`
for verifier regression tests. These simulate signature results; they do not
replace verification of real signed release artifacts.

The extracted Windows verification bundle can run all native updater checks in
one command:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\test-updater-windows.ps1
```

Keep `updater.test.exe`, `services.test.exe`, `test-verify-release.ps1`, and
`verify-release.ps1` beside the runner. Use 64-bit Windows PowerShell.

For end-to-end validation on Windows x64: install N with NSIS, publish N+1,
check for updates, and choose Restart & Apply. Verify Settings and Installed Apps
show N+1, shortcuts still launch, and uninstall works. A corrupted download must
fail before replacement and leave N runnable. Confirm prereleases are not offered
to stable clients and no legacy sidecar remains. Use an isolated release source
for corruption/prerelease experiments; do not modify the public stable release.

## Troubleshooting

- A missing **Check for updates** button means the binary is a development build
  or is not running on Windows x64.
- A stable client ignores draft and prerelease releases and versions that are not
  newer than its embedded version.
- A verification-information error means the selected executable has no valid
  SHA-256 entry in `SHA256SUMS`; the current installation remains runnable.
- A missing uninstall registry entry does not block updates. It usually means the
  executable was run without the NSIS installer or came from an older install
  path. Run the current installer to restore the supported Installed Apps entry.

**Related:** [AppUpdateService](../backend/services/AppUpdateService.md) | [Build and Release](../guides/Build%20and%20Release.md) | [Installation](../../onboarding/Installation.md)
