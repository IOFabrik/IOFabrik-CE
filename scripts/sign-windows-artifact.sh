#!/usr/bin/env bash
# sign-windows-artifact.sh
#
# Signs a Windows artifact using a local self-signed PFX (osslsigncode).
# Intended for beta/internal distribution consistency.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <artifact.exe>" >&2
  exit 1
fi

ARTIFACT="$1"
if [[ ! -f "$ARTIFACT" ]]; then
  echo "✗ Artifact not found: $ARTIFACT" >&2
  exit 1
fi

if ! command -v osslsigncode >/dev/null 2>&1; then
  echo "✗ osslsigncode is required for local self-signed signing" >&2
  echo "  Install on macOS: brew install osslsigncode" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CERT_DIR="${IOFABRIK_WINDOWS_SELF_SIGNED_CERT_DIR:-$ROOT_DIR/build/certs/windows/selfsigned}"
TIMESTAMP_SERVER="${IOFABRIK_WINDOWS_TIMESTAMP_SERVER:-}"

bash "$ROOT_DIR/scripts/setup-self-signed-windows-cert.sh" --cert-dir "$CERT_DIR"

PFX_PATH="$CERT_DIR/iofabrik-selfsigned.pfx"
PASSWORD_PATH="$CERT_DIR/password.txt"

if [[ ! -f "$PFX_PATH" ]]; then
  echo "✗ PFX not found: $PFX_PATH" >&2
  exit 1
fi
if [[ ! -f "$PASSWORD_PATH" ]]; then
  echo "✗ Password file not found: $PASSWORD_PATH" >&2
  exit 1
fi

PASSWORD="$(cat "$PASSWORD_PATH")"
TMP_OUT="${ARTIFACT}.signed.tmp"

SIGN_ARGS=(
  sign
  -pkcs12 "$PFX_PATH"
  -pass "$PASSWORD"
  -h sha256
  -n "IOFabrik"
  -i "https://iofabrik.com"
  -in "$ARTIFACT"
  -out "$TMP_OUT"
)

if [[ -n "$TIMESTAMP_SERVER" ]]; then
  SIGN_ARGS+=( -t "$TIMESTAMP_SERVER" )
fi

osslsigncode "${SIGN_ARGS[@]}"
mv "$TMP_OUT" "$ARTIFACT"

echo "✓ Signed: $ARTIFACT"
