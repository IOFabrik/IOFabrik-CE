#!/usr/bin/env bash
# Prepare and validate a Windows x64 stable release, optionally upload it.
# Run in Git Bash on Windows with Windows PowerShell available.
# Usage: scripts/create-release.sh --version X.Y.Z [--dir bin] [--output release/X.Y.Z]
#        [--notes 'text' | --notes @file] [--validate-only] [--upload]
# --validate-only checks an existing output directory without rewriting checksums.
set -euo pipefail

die() { echo "Error: $*" >&2; exit 1; }
VERSION=''
BINARIES_DIR=bin
OUTPUT_DIR=''
NOTES=''
UPLOAD=false
VALIDATE_ONLY=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version|-v|--dir|-d|--output|-o|--notes|-n)
      [[ $# -ge 2 && -n "$2" ]] || die "Missing value for $1"
      case "$1" in
        --version|-v) VERSION="$2" ;;
        --dir|-d) BINARIES_DIR="$2" ;;
        --output|-o) OUTPUT_DIR="$2" ;;
        --notes|-n) NOTES="$2" ;;
      esac
      shift 2 ;;
    --upload) UPLOAD=true; shift ;;
    --validate-only) VALIDATE_ONLY=true; shift ;;
    --help|-h) sed -n '2,6s/^# //p' "$0"; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done
[[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || die 'Use a stable version such as 1.2.3 (without v).'
OUTPUT_DIR="${OUTPUT_DIR:-release/$VERSION}"
ASSETS=(iofabrik-windows-amd64.exe iofabrik-amd64-installer.exe)
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"

if $VALIDATE_ONLY; then
  [[ -d "$OUTPUT_DIR" ]] || die "Release directory not found: $OUTPUT_DIR"
else
  for name in "${ASSETS[@]}"; do
    [[ -s "$BINARIES_DIR/$name" ]] || die "Missing or empty artifact: $BINARIES_DIR/$name"
  done
  [[ ! -e "$OUTPUT_DIR" ]] || die 'Output already exists; use --validate-only or choose a new output directory.'
fi
command -v powershell >/dev/null 2>&1 || die 'Windows PowerShell is required for Authenticode verification.'
if $UPLOAD; then
  command -v gh >/dev/null 2>&1 || die 'gh CLI is required for --upload.'
fi
if [[ "$NOTES" == @* ]]; then
  [[ -f "${NOTES#@}" ]] || die "Release notes file not found: ${NOTES#@}"
  NOTES="$(cat -- "${NOTES#@}")"
fi
NOTES="${NOTES:-IOFabrik v$VERSION}"

# Pass paths as arguments, never interpolate them into PowerShell source.
windows_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}
verify_release() {
  powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass \
    -File "$(windows_path "$SCRIPT_DIR/verify-release.ps1")" \
    -Directory "$(windows_path "$OUTPUT_DIR")" "$@"
}

if ! $VALIDATE_ONLY; then
  mkdir -p -- "$OUTPUT_DIR"
  for name in "${ASSETS[@]}"; do cp -- "$BINARIES_DIR/$name" "$OUTPUT_DIR/$name"; done
  verify_release -WriteChecksums
fi
# Always re-read and validate the staged bytes before any upload.
verify_release
if $UPLOAD; then
  NOTES_FILE="$(mktemp)"
  trap 'rm -f -- "$NOTES_FILE"' EXIT
  printf '%s\n' "$NOTES" > "$NOTES_FILE"
  gh release create "v$VERSION" --repo IOFabrik/IOFabrik-CE \
    --verify-tag --title "IOFabrik v$VERSION" --notes-file "$NOTES_FILE" \
    "$OUTPUT_DIR/${ASSETS[0]}" "$OUTPUT_DIR/${ASSETS[1]}" "$OUTPUT_DIR/SHA256SUMS"
fi
printf 'Validated release v%s: %s\n' "$VERSION" "$OUTPUT_DIR"
