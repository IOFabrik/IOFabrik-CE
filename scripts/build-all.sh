#!/usr/bin/env bash
#
# build-all.sh — Build IOFabrik for macOS & Windows (ARM64 + AMD64)
#
# This script orchestrates a full multi-platform release build:
#   1. Downloads optional macOS CLI deps for app-bundle embedding
#   2. Builds the Wails v3 app binary for each target
#   3. Packages installers (macOS .app, Windows NSIS)
#
# Prerequisites:
#   - Go 1.24+ (with GOPATH configured)
#   - Node.js 18+ and npm
#   - Wails v3 CLI: go install github.com/wailsapp/wails/v3/cmd/wails3@latest
#   - Task runner: https://taskfile.dev
#   - Docker (for cross-compiling Windows from macOS, or macOS from Linux)
#   - NSIS (for Windows installer): brew install makensis
#   - Xcode Command Line Tools (for macOS codesigning)
#
# Usage:
#   ./scripts/build-all.sh [options]
#
# Options:
#   --version, -v <semver>   Set app version (default: 0.0.0-dev)
#   --platforms <list>        Comma-separated: darwin-arm64,darwin-amd64,windows-amd64,windows-arm64
#   --skip-deps               Use cached Windows tool archives; skip optional macOS downloads
#   --skip-build              Skip building (just package)
#   --skip-package            Skip packaging (just build binaries)
#   --universal               Build macOS universal binary (arm64 + amd64)
#   --sign                    Sign release artifacts (requires certs)
#   --clean                   Clean build artifacts before starting
#   --help, -h                Show this help
#
# Examples:
#   # Build everything for all platforms
#   ./scripts/build-all.sh --version 0.2.0 --platforms darwin-arm64,darwin-amd64,windows-amd64,windows-arm64
#
#   # Quick: build just macOS for current arch
#   ./scripts/build-all.sh --version 0.2.0 --platforms darwin-arm64
#
#   # macOS universal + Windows amd64
#   ./scripts/build-all.sh --version 0.2.0 --universal --platforms windows-amd64
#
set -euo pipefail

# ─── Configuration ─────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

APP_NAME="iofabrik"
BIN_DIR="bin"
DEPS_DIR="build/deps"

# ─── Color output ──────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${BLUE}ℹ${NC}  $*"; }
ok()    { echo -e "${GREEN}✓${NC}  $*"; }
warn()  { echo -e "${YELLOW}⚠${NC}  $*"; }
err()   { echo -e "${RED}✗${NC}  $*" >&2; }
die()   { err "$@"; exit 1; }

step() {
    STEP_NUM=$((STEP_NUM + 1))
    echo ""
    echo -e "${BOLD}[$STEP_NUM/$TOTAL_STEPS] $*${NC}"
    echo "────────────────────────────────────────"
}

STEP_NUM=0
TOTAL_STEPS=5

# ─── Argument Parsing ──────────────────────────────────────────────────────────

VERSION="0.0.0-dev"
PLATFORMS=()
SKIP_DEPS=false
SKIP_BUILD=false
SKIP_PACKAGE=false
UNIVERSAL=false
DO_SIGN=false
CLEAN=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --version|-v)     VERSION="$2"; shift 2 ;;
        --platforms)      IFS=',' read -ra PLATFORMS <<< "$2"; shift 2 ;;
        --skip-deps)      SKIP_DEPS=true; shift ;;
        --skip-build)     SKIP_BUILD=true; shift ;;
        --skip-package)   SKIP_PACKAGE=true; shift ;;
        --universal)      UNIVERSAL=true; shift ;;
        --sign)           DO_SIGN=true; shift ;;
        --clean)          CLEAN=true; shift ;;
        --help|-h)
            sed -n '2,/^set -euo/{ /^set -euo/d; s/^# \{0,1\}//p; }' "$0"
            exit 0 ;;
        *) die "Unknown option: $1 (use --help)" ;;
    esac
done

# Default: all platforms
if [[ ${#PLATFORMS[@]} -eq 0 ]]; then
    PLATFORMS=(darwin-arm64 darwin-amd64 windows-amd64 windows-arm64)
fi

# ─── Prerequisite checks ──────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║  IOFabrik Multi-Platform Build  v${VERSION}          ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Platforms: ${BOLD}${PLATFORMS[*]}${NC}"
echo -e "  Universal: ${BOLD}${UNIVERSAL}${NC}"
echo -e "  Sign: ${BOLD}${DO_SIGN}${NC}"
echo ""

check_tool() {
    local tool="$1"
    local install_hint="${2:-}"
    if ! command -v "$tool" &>/dev/null; then
        die "Required tool '${tool}' not found.${install_hint:+ Install: ${install_hint}}"
    fi
    ok "$tool found: $(command -v "$tool")"
}

info "Checking prerequisites..."
check_tool "go" "https://go.dev/dl/"
check_tool "node" "https://nodejs.org"
check_tool "npm"
check_tool "wails3" "go install github.com/wailsapp/wails/v3/cmd/wails3@latest"
check_tool "task" "https://taskfile.dev/installation/"

# Check if we need Docker (cross-compiling Windows from macOS or vice versa)
NEED_DOCKER=false
HOST_OS=$(uname -s | tr '[:upper:]' '[:lower:]')
for plat in "${PLATFORMS[@]}"; do
    os_part="${plat%-*}"
    if [[ "$os_part" != "$HOST_OS" ]]; then
        # Cross-compiling: might need Docker (for CGO builds) or native Go cross-compile
        if [[ "$os_part" == "darwin" && "$HOST_OS" != "darwin" ]]; then
            NEED_DOCKER=true
        fi
    fi
done

if $NEED_DOCKER; then
    check_tool "docker" "https://docs.docker.com/get-docker/"
fi

# Check NSIS for Windows packaging
HAS_WINDOWS=false
for plat in "${PLATFORMS[@]}"; do
    if [[ "${plat%-*}" == "windows" ]]; then
        HAS_WINDOWS=true
        break
    fi
done
if $HAS_WINDOWS && ! $SKIP_PACKAGE; then
    if command -v makensis &>/dev/null; then
        ok "makensis found (NSIS installer)"
    else
        warn "makensis not found — Windows NSIS installers will be skipped."
        warn "Install: brew install makensis (macOS) or apt install nsis (Linux)"
    fi
fi

echo ""

# ─── Clean ─────────────────────────────────────────────────────────────────────

if $CLEAN; then
    info "Cleaning previous build artifacts..."
    rm -rf "$BIN_DIR"
    rm -rf "${DEPS_DIR}/darwin-"* "${DEPS_DIR}/windows-"*
    rm -rf frontend/dist
    ok "Cleaned"
fi

mkdir -p "$BIN_DIR"

# ─── Step 1: Download optional macOS CLI dependencies ─────────────────────────

TOTAL_STEPS=4
if ! $SKIP_DEPS; then
    TOTAL_STEPS=5
    step "Downloading optional macOS CLI dependencies (git, gh)"

    dep_args=()
    for plat in "${PLATFORMS[@]}"; do
        # Windows tools are verified and staged during installer packaging.
        if [[ "${plat%-*}" == "darwin" ]]; then
            dep_args+=(--platform "$plat")
        fi
    done

    if [[ ${#dep_args[@]} -gt 0 ]]; then
        bash "${SCRIPT_DIR}/download-cli-deps.sh" "${dep_args[@]}"
    else
        info "No macOS targets selected; skipping CLI dependency download"
    fi
fi

# ─── Step 2: Build frontend (shared across all targets) ────────────────────────

if ! $SKIP_BUILD; then
    step "Building frontend"

    task common:build:frontend DEV=false
    ok "Frontend built → frontend/dist/"
fi

# ─── Step 3: Build binaries for each platform ──────────────────────────────────

if ! $SKIP_BUILD; then
    step "Compiling Go binaries"

    # Classify platforms
    DARWIN_ARCHS=()
    WINDOWS_ARCHS=()

    for plat in "${PLATFORMS[@]}"; do
        os_part="${plat%-*}"
        arch_part="${plat#*-}"
        case "$os_part" in
            darwin)  DARWIN_ARCHS+=("$arch_part") ;;
            windows) WINDOWS_ARCHS+=("$arch_part") ;;
            *)       warn "Unsupported platform: $plat (skipping)" ;;
        esac
    done

    # ── macOS builds ──

    if $UNIVERSAL && [[ ${#DARWIN_ARCHS[@]} -gt 0 ]]; then
        info "Building macOS universal binary (arm64 + amd64)..."
        APP_VERSION="$VERSION" task darwin:build:universal
        ok "macOS universal binary → ${BIN_DIR}/${APP_NAME}"
    else
        for arch in ${DARWIN_ARCHS[@]+"${DARWIN_ARCHS[@]}"}; do
            info "Building macOS ${arch}..."

            output="${BIN_DIR}/${APP_NAME}-darwin-${arch}"
            APP_VERSION="$VERSION" task darwin:build ARCH="$arch" OUTPUT="$output"

            ok "macOS ${arch} → ${output}"
        done
    fi

    # ── Windows builds (cross-compile from macOS using Go without CGO) ──

    for arch in ${WINDOWS_ARCHS[@]+"${WINDOWS_ARCHS[@]}"}; do
        info "Building Windows ${arch}..."

        APP_VERSION="$VERSION" task windows:build ARCH="$arch"

        ok "Windows ${arch} → ${BIN_DIR}/${APP_NAME}.exe"

        # Rename to include platform suffix
        mv "${BIN_DIR}/${APP_NAME}.exe" "${BIN_DIR}/${APP_NAME}-windows-${arch}.exe"
        ok "Renamed → ${BIN_DIR}/${APP_NAME}-windows-${arch}.exe"

    done
fi

# ─── Step 4: Package installers ────────────────────────────────────────────────

if ! $SKIP_PACKAGE; then
    step "Packaging installers"

    # ── macOS .app bundles ──

    if $UNIVERSAL && [[ ${#DARWIN_ARCHS[@]} -gt 0 ]]; then
        info "Packaging macOS universal .app bundle..."

        APP_DIR="${BIN_DIR}/${APP_NAME}.app"
        rm -rf "$APP_DIR"
        mkdir -p "${APP_DIR}/Contents/MacOS"
        mkdir -p "${APP_DIR}/Contents/Resources"

        # Copy main binary
        cp "${BIN_DIR}/${APP_NAME}" "${APP_DIR}/Contents/MacOS/${APP_NAME}"

        # Copy icon and Info.plist
        cp build/darwin/icons.icns "${APP_DIR}/Contents/Resources/"
        cp build/darwin/Info.plist "${APP_DIR}/Contents/"

        # Bundle git & gh CLI deps (use arm64 deps for universal — both are typically universal/fat)
        for dep_arch in arm64 amd64; do
            dep_dir="${DEPS_DIR}/darwin-${dep_arch}"
            if [[ -d "${dep_dir}/git" ]]; then
                info "Bundling git from darwin-${dep_arch}..."
                cp -R "${dep_dir}/git" "${APP_DIR}/Contents/Resources/git"
                break
            fi
        done

        for dep_arch in arm64 amd64; do
            dep_dir="${DEPS_DIR}/darwin-${dep_arch}"
            if [[ -d "${dep_dir}/gh" ]]; then
                info "Bundling gh from darwin-${dep_arch}..."
                mkdir -p "${APP_DIR}/Contents/Resources/gh/bin"
                cp "${dep_dir}/gh/bin/gh" "${APP_DIR}/Contents/Resources/gh/bin/gh"
                chmod +x "${APP_DIR}/Contents/Resources/gh/bin/gh"
                break
            fi
        done

        # Ad-hoc codesign
        if command -v codesign &>/dev/null; then
            codesign --force --deep --sign - "$APP_DIR"
        fi

        ok "macOS .app bundle → ${APP_DIR}"

    else
        for arch in ${DARWIN_ARCHS[@]+"${DARWIN_ARCHS[@]}"}; do
            info "Packaging macOS ${arch} .app bundle..."

            src_bin="${BIN_DIR}/${APP_NAME}-darwin-${arch}"
            APP_DIR="${BIN_DIR}/${APP_NAME}-darwin-${arch}.app"
            rm -rf "$APP_DIR"
            mkdir -p "${APP_DIR}/Contents/MacOS"
            mkdir -p "${APP_DIR}/Contents/Resources"

            # Copy binary
            cp "$src_bin" "${APP_DIR}/Contents/MacOS/${APP_NAME}"

            # Copy icon and Info.plist
            cp build/darwin/icons.icns "${APP_DIR}/Contents/Resources/"
            cp build/darwin/Info.plist "${APP_DIR}/Contents/"

            # Bundle git
            dep_dir="${DEPS_DIR}/darwin-${arch}"
            if [[ -d "${dep_dir}/git" ]]; then
                info "Bundling git..."
                cp -R "${dep_dir}/git" "${APP_DIR}/Contents/Resources/git"
            else
                warn "No bundled git for darwin-${arch} — app will use system git"
            fi

            # Bundle gh
            if [[ -d "${dep_dir}/gh" ]]; then
                info "Bundling gh..."
                mkdir -p "${APP_DIR}/Contents/Resources/gh/bin"
                cp "${dep_dir}/gh/bin/gh" "${APP_DIR}/Contents/Resources/gh/bin/gh"
                chmod +x "${APP_DIR}/Contents/Resources/gh/bin/gh"
            else
                warn "No bundled gh for darwin-${arch} — app will use system gh"
            fi

            # Ad-hoc codesign
            if command -v codesign &>/dev/null; then
                codesign --force --deep --sign - "$APP_DIR"
            fi

            ok "macOS ${arch} .app → ${APP_DIR}"
        done
    fi

    # ── Windows NSIS installers ──

    for arch in ${WINDOWS_ARCHS[@]+"${WINDOWS_ARCHS[@]}"}; do
        info "Packaging Windows ${arch} NSIS installer..."

        src_exe="${BIN_DIR}/${APP_NAME}-windows-${arch}.exe"
        if [[ ! -f "$src_exe" ]]; then
            warn "Binary not found: ${src_exe} — skipping"
            continue
        fi

        if $DO_SIGN; then
            info "Signing Windows ${arch} binary..."
            task windows:sign:artifact INPUT="$src_exe"
            task windows:verify:artifact INPUT="$src_exe"
            ok "Signed binary → ${src_exe}"
        fi

        # Stage required artifacts for NSIS
        staging_dir="${BIN_DIR}/windows-${arch}-staging"
        rm -rf "$staging_dir"
        mkdir -p "$staging_dir"

        # Copy main binary
        cp "$src_exe" "${staging_dir}/${APP_NAME}.exe"

        # Create NSIS installer
        if command -v makensis &>/dev/null; then
            # Prepare complete, verified tools. --skip-deps requires cached archives.
            tool_args=(--arch "$arch")
            if $SKIP_DEPS; then tool_args+=(--offline); fi
            go run ./scripts/prepare-windows-tools "${tool_args[@]}"

            NSIS_ARCH_FLAG="AMD64"
            if [[ "$arch" == "arm64" ]]; then
                NSIS_ARCH_FLAG="ARM64"
            fi

            # NSIS resolves File paths relative to the .nsi script, not cwd.
            # Use absolute paths so makensis finds the staged files.
            nsis_version="${VERSION#v}"
            nsis_version="${nsis_version%%-*}"
            nsis_version="${nsis_version%%+*}"
            makensis \
                -DIOFABRIK_TOOLS_DIR="${ROOT_DIR}/build/deps/windows-${arch}" \
                -DINFO_PRODUCTVERSION="$nsis_version" \
                -DARG_WAILS_${NSIS_ARCH_FLAG}_BINARY="${ROOT_DIR}/${staging_dir}/${APP_NAME}.exe" \
                build/windows/nsis/project.nsi

            ok "Windows ${arch} installer → bin/${APP_NAME}-${arch}-installer.exe"

            if $DO_SIGN; then
                installer_path="${BIN_DIR}/${APP_NAME}-${arch}-installer.exe"
                info "Signing Windows ${arch} installer..."
                task windows:sign:artifact INPUT="$installer_path"
                task windows:verify:artifact INPUT="$installer_path"
                ok "Signed installer → ${installer_path}"
            fi
        else
            warn "makensis not available — skipping NSIS installer for windows-${arch}"
            warn "Staged files are in: ${staging_dir}/"
        fi
    done
fi

# ─── Summary ───────────────────────────────────────────────────────────────────

step "Build Summary"

echo ""
echo -e "${BOLD}Artifacts in ${BIN_DIR}/:${NC}"
echo ""

ls -lh "${BIN_DIR}/"*.app 2>/dev/null | while read -r line; do
    echo -e "  ${GREEN}●${NC} $line"
done

ls -lh "${BIN_DIR}/"*-installer.exe 2>/dev/null | while read -r line; do
    echo -e "  ${GREEN}●${NC} $line"
done

ls -lh "${BIN_DIR}/"*-darwin-* "${BIN_DIR}/"*-windows-* 2>/dev/null | grep -v '\.app' | grep -v 'staging' | while read -r line; do
    echo -e "  ${BLUE}●${NC} $line"
done

echo ""
ok "Build complete!"
echo ""
echo -e "${BOLD}Next steps:${NC}"
echo "  1. Test the builds on each target platform"
echo "  2. Create a release: ./scripts/create-release.sh --version $VERSION"
echo "  3. Sign for distribution (macOS): task darwin:sign:notarize"
echo "  4. Sign for distribution (Windows): task windows:sign:installer"
echo ""
