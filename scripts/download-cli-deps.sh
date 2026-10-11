#!/usr/bin/env bash
#
# download-cli-deps.sh — Download portable git & gh CLI binaries for bundling
#
# Downloads MinGit (Windows) and gh CLI (all platforms) into build/deps/<os>-<arch>/
# so the build script and installers can bundle them alongside the app binary.
#
# Usage:
#   ./scripts/download-cli-deps.sh [--all | --platform <os-arch>]
#
# Options:
#   --all                 Download deps for all supported platforms
#   --platform <os-arch>  Download deps for a specific platform (e.g. darwin-arm64, windows-amd64)
#   --gh-version <ver>    Override macOS gh CLI version (default: 2.65.0)
#   --clean               Remove existing deps before downloading
#
# Supported platforms:
#   darwin-arm64, darwin-amd64, windows-amd64, windows-arm64
#
set -euo pipefail

# ─── Version pins ──────────────────────────────────────────────────────────────

GH_VERSION="2.65.0"                 # GitHub CLI

# ─── Configuration ─────────────────────────────────────────────────────────────

DEPS_DIR="build/deps"
CACHE_DIR="build/deps/.cache"       # Downloaded archives cached here

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

# ─── Argument parsing ──────────────────────────────────────────────────────────

PLATFORMS=()
CLEAN=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --all)
            PLATFORMS=(darwin-arm64 darwin-amd64 windows-amd64 windows-arm64)
            shift ;;
        --platform)
            PLATFORMS+=("$2"); shift 2 ;;
        --gh-version)
            GH_VERSION="$2"; shift 2 ;;
        --clean)
            CLEAN=true; shift ;;
        --help|-h)
            sed -n '2,/^set -euo/{ /^set -euo/d; s/^# \{0,1\}//p; }' "$0"
            exit 0 ;;
        *)
            die "Unknown option: $1 (use --help)" ;;
    esac
done

# Default: detect current platform
if [[ ${#PLATFORMS[@]} -eq 0 ]]; then
    current_os=$(uname -s | tr '[:upper:]' '[:lower:]')
    current_arch=$(uname -m)
    case "$current_arch" in
        x86_64)         current_arch="amd64" ;;
        aarch64|arm64)  current_arch="arm64" ;;
    esac
    if [[ "$current_os" != "darwin" ]]; then
        current_os="windows"  # Assume Windows if not macOS for dep download
    fi
    PLATFORMS=("${current_os}-${current_arch}")
    info "No platform specified, defaulting to: ${BOLD}${PLATFORMS[0]}${NC}"
fi

# ─── Clean ─────────────────────────────────────────────────────────────────────

if $CLEAN; then
    info "Cleaning existing deps..."
    for plat in "${PLATFORMS[@]}"; do
        rm -rf "${DEPS_DIR}/${plat}"
    done
    ok "Cleaned"
fi

mkdir -p "$CACHE_DIR"

# ─── Download helpers ──────────────────────────────────────────────────────────

download() {
    local url="$1"
    local dest="$2"

    if [[ -f "$dest" ]]; then
        ok "Cached: $(basename "$dest")"
        return 0
    fi

    info "Downloading: $(basename "$dest")"
    if curl -fSL --progress-bar -o "${dest}.tmp" "$url"; then
        mv "${dest}.tmp" "$dest"
        ok "Downloaded: $(basename "$dest")"
    else
        rm -f "${dest}.tmp"
        die "Failed to download: $url"
    fi
}

# ─── gh CLI ────────────────────────────────────────────────────────────────────

download_gh() {
    local os="$1"     # macOS or windows
    local arch="$2"   # amd64 or arm64
    local dest_dir="$3"

    local gh_os
    case "$os" in
        darwin)  gh_os="macOS" ;;
        windows) gh_os="windows" ;;
        *)       die "Unsupported OS for gh: $os" ;;
    esac

    local ext="zip"
    local filename="gh_${GH_VERSION}_${gh_os}_${arch}.${ext}"
    local url="https://github.com/cli/cli/releases/download/v${GH_VERSION}/${filename}"
    local archive="${CACHE_DIR}/${filename}"

    download "$url" "$archive"

    info "Extracting gh CLI to ${dest_dir}/gh/"
    mkdir -p "${dest_dir}/gh"

    # gh zips contain a top-level directory like gh_2.65.0_macOS_arm64/
    local tmpdir
    tmpdir=$(mktemp -d)
    unzip -qo "$archive" -d "$tmpdir"

    # Find the extracted directory and move contents
    local inner_dir
    inner_dir=$(find "$tmpdir" -mindepth 1 -maxdepth 1 -type d | head -1)

    if [[ -n "$inner_dir" ]]; then
        cp -R "${inner_dir}/"* "${dest_dir}/gh/"
    else
        cp -R "${tmpdir}/"* "${dest_dir}/gh/"
    fi

    rm -rf "$tmpdir"
    ok "gh CLI ${GH_VERSION} (${os}-${arch}) ready"
}

# ─── macOS Git ─────────────────────────────────────────────────────────────────
# macOS does not have a portable "MinGit" equivalent. We bundle the system or
# Homebrew git if available, or leave a placeholder for CI to populate.

bundle_macos_git() {
    local arch="$1"
    local dest_dir="$2"

    # Strategy: check for Homebrew git first (preferred, newer version),
    # then fall back to Xcode CLT git, then Apple's /usr/bin/git
    local git_src=""
    local git_base=""

    # 1. Homebrew git (typically at /opt/homebrew or /usr/local)
    local brew_prefix
    if command -v brew &>/dev/null; then
        brew_prefix="$(brew --prefix)"
        if [[ -x "${brew_prefix}/bin/git" ]]; then
            git_base="${brew_prefix}"
            git_src="Homebrew"
        fi
    fi

    # 2. Xcode CLT git
    if [[ -z "$git_src" ]] && [[ -x "/Library/Developer/CommandLineTools/usr/bin/git" ]]; then
        git_base="/Library/Developer/CommandLineTools/usr"
        git_src="Xcode CLT"
    fi

    if [[ -z "$git_src" ]]; then
        warn "No git installation found to bundle for macOS ${arch}."
        warn "The app will fall back to system PATH at runtime."
        warn "To bundle git: install Homebrew git (brew install git) and re-run."
        return 0
    fi

    info "Bundling git from ${git_src} (${git_base})"
    mkdir -p "${dest_dir}/git/bin"
    mkdir -p "${dest_dir}/git/libexec"

    # Copy the git binary
    cp "${git_base}/bin/git" "${dest_dir}/git/bin/git"

    # Copy git-core helpers (needed for operations like git-remote-https)
    if [[ -d "${git_base}/libexec/git-core" ]]; then
        cp -R "${git_base}/libexec/git-core" "${dest_dir}/git/libexec/"
    fi

    # Copy git-lfs if available
    if [[ -x "${git_base}/bin/git-lfs" ]]; then
        cp "${git_base}/bin/git-lfs" "${dest_dir}/git/bin/git-lfs"
        ok "Bundled git-lfs"
    fi

    # Copy required shared libraries on macOS (Homebrew git links against some)
    if [[ "$git_src" == "Homebrew" ]]; then
        mkdir -p "${dest_dir}/git/lib"
        # Use otool to find dynamic dependencies and copy non-system ones
        local deps
        deps=$(otool -L "${dest_dir}/git/bin/git" 2>/dev/null | awk 'NR>1{print $1}' | grep -v '^/usr/lib' | grep -v '^/System' || true)
        for dep in $deps; do
            if [[ -f "$dep" ]]; then
                cp "$dep" "${dest_dir}/git/lib/" 2>/dev/null || true
            fi
        done
    fi

    # Ad-hoc sign the copied binary for macOS
    if command -v codesign &>/dev/null; then
        codesign --force --sign - "${dest_dir}/git/bin/git" 2>/dev/null || true
        if [[ -x "${dest_dir}/git/bin/git-lfs" ]]; then
            codesign --force --sign - "${dest_dir}/git/bin/git-lfs" 2>/dev/null || true
        fi
    fi

    ok "macOS git bundled from ${git_src}"
}

# ─── Process each platform ────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║  IOFabrik — Download CLI Dependencies           ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════╝${NC}"
echo ""

for platform in "${PLATFORMS[@]}"; do
    os_part="${platform%-*}"
    arch_part="${platform#*-}"
    dest_dir="${DEPS_DIR}/${platform}"

    echo -e "${BOLD}── ${platform} ──${NC}"
    mkdir -p "$dest_dir"

    case "$os_part" in
        darwin)
            bundle_macos_git "$arch_part" "$dest_dir"
            download_gh "darwin" "$arch_part" "$dest_dir"
            ;;
        windows)
            go run ./scripts/prepare-windows-tools --arch "$arch_part" --output "$dest_dir"
            ;;
        *)
            warn "Unsupported OS: $os_part (skipping)"
            ;;
    esac

    echo ""
done

# ─── Summary ───────────────────────────────────────────────────────────────────

echo -e "${BOLD}═══ Dependencies ready ═══${NC}"
echo ""
for platform in "${PLATFORMS[@]}"; do
    dest_dir="${DEPS_DIR}/${platform}"
    if [[ -d "$dest_dir" ]]; then
        echo -e "  ${GREEN}●${NC} ${platform}"
        if [[ -d "${dest_dir}/git" ]]; then
            git_size=$(du -sh "${dest_dir}/git" 2>/dev/null | awk '{print $1}')
            echo "      git: ${git_size}"
        fi
        if [[ -d "${dest_dir}/gh" ]]; then
            gh_size=$(du -sh "${dest_dir}/gh" 2>/dev/null | awk '{print $1}')
            echo "      gh:  ${gh_size}"
        fi
    fi
done
echo ""
ok "Done. Run ${BOLD}./scripts/build-all.sh${NC} next."
