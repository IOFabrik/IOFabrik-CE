# Build and Release

> Build and package a local IOFabrik desktop application.

## Prerequisites

Use Go 1.26 or newer, Node.js 20 or newer, npm, Git, Task, and the Wails CLI
version pinned in `go.mod`. Native builds also require the platform tooling
described by [Wails](https://v3.wails.io/getting-started/installation/).

The frontend installs `ladder-visualizer` from the immutable Git commit pinned
in `frontend/package.json` and `frontend/package-lock.json`. npm builds that
library during installation, so a sibling checkout is not required. See
[Development Setup](../../onboarding/Development%20Setup.md) for the standard
install and optional local-library override.

## Local configuration

Copy `frontend/.env.example` to `frontend/.env.local` only if you need optional
account or analytics integrations. Use your own project values. Missing account
configuration disables account sign-in; never put server secrets in `VITE_*`
variables because these are embedded in the desktop frontend.

## Build and package

Run from the repository root:

```bash
task dev                 # Start the development application
task build               # Build for the current platform
task package             # Package for the current platform
```

Build outputs belong in `bin/`; they must not be committed. Required files under
`build/` are source-controlled templates and assets, not disposable build output.

Platform tasks are defined in `build/darwin/Taskfile.yml`,
`build/windows/Taskfile.yml`, and `build/linux/Taskfile.yml`. Cross-compilation
requires the appropriate toolchain and, for configured Docker tasks, Docker.

## Bindings and metadata

After an exported Go service interface changes:

```bash
task common:generate:bindings
```

Never hand-edit generated bindings. Application identity and version come from
`build/config.yml`. Refresh generated packaging metadata when that configuration
changes with `task common:update:build-assets`, then review the resulting diff.

## Signing

Distribution may require platform signing and notarization. Use your own signing
identity and private credential storage. Keep signing material, certificates
containing private keys, and passwords out of Git. The existing signing scripts
and platform tasks describe their configuration inputs.

Windows x64 updates use the Wails GitHub provider and a `SHA256SUMS` release asset.
The application executable and NSIS installer must both have valid, timestamped
Authenticode signatures before checksums are generated.
See [Auto-Updater](../infrastructure/Auto-Updater.md) for the updater's technical contract. Maintainer release
operations are managed outside the public source repository.

## Verify the build

```bash
go build ./...
go test . ./services/...
python3 scripts/check-publication.py
cd frontend
npm run ci:guards
npm test
npm run build
```

Before distributing a package, also smoke-test installation and startup on the
target operating system. A frontend build alone does not validate installation.

## Windows x64 release preparation

Use the native Windows build tasks for updater-enabled releases. The Docker
Windows build is outside this updater scope and does not supply its production
tag or embedded version.

Build the executable and NSIS installer with the same stable version. Set
`APP_VERSION` explicitly for a release build; `build/config.yml` is its fallback.
The native Windows task uses the value for the embedded Go version, generated
Windows executable metadata, and NSIS metadata.

From PowerShell on the native Windows x64 build machine:

```powershell
$env:APP_VERSION = '1.2.3'
task windows:build ARCH=amd64
```

Sign `bin/iofabrik.exe`, copy that signed file to
`bin/iofabrik-windows-amd64.exe`, and build the NSIS installer from the
signed executable with `build/windows/nsis/project.nsi` and the same version.
Then sign `bin/iofabrik-amd64-installer.exe`. Do not invoke a build task or
modify either artifact after this point because that would invalidate its
signature.

From Git Bash on Windows, with Windows PowerShell available:

```bash
scripts/create-release.sh --version 1.2.3 --notes @release-notes.md
scripts/create-release.sh --version 1.2.3 --validate-only
# Once the release tag exists on GitHub and the artifacts are ready to publish:
scripts/create-release.sh --version 1.2.3 --validate-only --upload --notes @release-notes.md
```

The output is `release/1.2.3/` with the two executables and `SHA256SUMS`.
Preparation refuses existing output to avoid overwriting reviewed artifacts.
Validation rejects missing files, unexpected names, invalid signatures, missing
timestamps, and checksum mismatches. Development self-signed bypass settings do
not apply. Release publication targets `IOFabrik/IOFabrik-CE`.


The native Windows build generates `bin/windows-info-<arch>.json` from the
source metadata template using `APP_VERSION`. This keeps the executable's
Windows file version aligned with the Go version and NSIS metadata without
editing generated source templates. For example, `APP_VERSION=0.0.2` produces
numeric file version `0.0.2.0` and product version `0.0.2`.

Run `node --test scripts/generate-windows-version-info.test.mjs` to check this
metadata generation, including development versions and invalid inputs.

**Related:** [Development Setup](../../onboarding/Development%20Setup.md) | [Architecture Overview](../architecture/Architecture%20Overview.md) | [Auto-Updater](../infrastructure/Auto-Updater.md) | [Testing Guide](Testing%20Guide.md)

## Offline Windows tools and storage

Windows NSIS installers include regular MinGit, GitHub CLI, and Git LFS, with
support files and licenses. WebView2 is **not** included or downloaded: the target
machine must already have the WebView2 Runtime (normally supplied by Windows 11).
The standalone application executable is an update/development artifact, not a
complete offline installation package.

Prepare the tools on the build machine before invoking NSIS directly:

```powershell
go run ./scripts/prepare-windows-tools --arch amd64
# Rebuild using only previously verified archives, with no tool downloads:
go run ./scripts/prepare-windows-tools --arch amd64 --offline
```

Use `arm64` for native Windows ARM64 packages. Versions, upstream release URLs,
and SHA-256 hashes are pinned in `scripts/prepare-windows-tools/manifest.json`.
Update that manifest when updating tools. Preparation verifies archive hashes,
executable architecture, Git's shell, and required executable paths; it retains
complete tool distributions rather than copying only executables. Build archives
are cached under `build/deps/.cache`; none are committed.

`task windows:package ARCH=amd64` prepares these tools automatically.
`OFFLINE=true` restricts tool preparation to cached archives. This does not make
Go/npm dependency installation offline; those build dependencies must also be
available. `scripts/build-all.sh --skip-deps` likewise requires verified cached
Windows archives. The compatibility `download-cli-deps.sh --platform windows-amd64`
command uses the same manifest.

When building NSIS directly from an already signed executable, pass
`-DIOFABRIK_TOOLS_DIR="<absolute repository path>/build/deps/windows-amd64"` alongside
the existing binary and version arguments. NSIS rejects missing tool payloads.
A package includes one architecture; use the matching tools and application.
The application never downloads missing tools; users repair an incomplete
installation by rerunning the full installer.

The default Windows footprint is `%LOCALAPPDATA%\IOFabrik`:

- `app`: application and uninstaller (the installer still permits a custom path).
- `tools\bin\git`, `tools\bin\gh`, `tools\bin\lfs`: installer-managed tools.
- `config`: app settings and `repositories` settings.
- `logs`, `cache`, `integration`: diagnostics and working data.
- `webview2`: browser profile data, not the WebView2 runtime itself.
- `migrations`: completed migration records.

Startup migrates earlier roaming settings, repository settings, logs, browser
profile, and legacy tools when appropriate. Existing destination files win;
conflicting historical files are retained. The v2 marker runs even if v1 already
completed. New settings no longer roam between Windows machines. macOS and Linux
retain their existing OS-specific config/cache locations. Shared Git identity,
GitHub CLI authentication/configuration, OS keychain entries, and project folders
remain in their existing locations; IOFabrik does not take ownership of them.

Reinstalling replaces the managed tool bundle. Moving from the former default app
folder removes only its known app executables/uninstaller and then the empty
folder; custom installation folders are not recursively removed. Uninstall removes
application files and bundled tools. Settings, logs, cache, integration state, and
browser data are retained unless the user selects **Remove user data**.

Before distribution, use a clean Windows VM with networking disabled: install,
launch, create a local project, save a change, and verify Git LFS initialization.
Repeat with prior-version settings and with the optional data-removal uninstall
choice. NSIS compilation and cross-compilation alone do not replace this test.
