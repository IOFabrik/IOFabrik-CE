#!/usr/bin/env bash
# setup-self-signed-windows-cert.sh
#
# Creates a local self-signed code-signing certificate bundle for Windows signing.
# Outputs:
#   <cert-dir>/iofabrik-selfsigned.key
#   <cert-dir>/iofabrik-selfsigned.crt
#   <cert-dir>/iofabrik-selfsigned.cer
#   <cert-dir>/iofabrik-selfsigned.pfx
#   <cert-dir>/password.txt

set -euo pipefail

CERT_DIR="build/certs/windows/selfsigned"
FORCE=false
SUBJECT="/CN=IOFabrik Local Beta/O=IOFabrik/OU=Engineering/L=Remote/ST=NA/C=US"
DAYS="825"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cert-dir)
      CERT_DIR="$2"
      shift 2
      ;;
    --force)
      FORCE=true
      shift
      ;;
    --subject)
      SUBJECT="$2"
      shift 2
      ;;
    --days)
      DAYS="$2"
      shift 2
      ;;
    --help|-h)
      cat <<'EOF'
Usage: setup-self-signed-windows-cert.sh [options]

Options:
  --cert-dir <dir>   Output directory (default: build/certs/windows/selfsigned)
  --force            Regenerate even if files already exist
  --subject <dn>     OpenSSL subject DN (default: IOFabrik local beta)
  --days <n>         Validity days (default: 825)
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if ! command -v openssl >/dev/null 2>&1; then
  echo "✗ openssl is required to generate a self-signed certificate" >&2
  exit 1
fi

mkdir -p "$CERT_DIR"

KEY_PATH="$CERT_DIR/iofabrik-selfsigned.key"
CRT_PATH="$CERT_DIR/iofabrik-selfsigned.crt"
CER_PATH="$CERT_DIR/iofabrik-selfsigned.cer"
PFX_PATH="$CERT_DIR/iofabrik-selfsigned.pfx"
PASSWORD_PATH="$CERT_DIR/password.txt"

if [[ -f "$PFX_PATH" && "$FORCE" != "true" ]]; then
  echo "ℹ Self-signed certificate already exists: $PFX_PATH"
  echo "✓ Ready"
  exit 0
fi

if [[ ! -f "$PASSWORD_PATH" || "$FORCE" == "true" ]]; then
  openssl rand -base64 24 | tr -d '\n' > "$PASSWORD_PATH"
fi

PASSWORD="$(cat "$PASSWORD_PATH")"

openssl req -x509 -newkey rsa:4096 -sha256 \
  -keyout "$KEY_PATH" \
  -out "$CRT_PATH" \
  -days "$DAYS" \
  -subj "$SUBJECT" \
  -addext "keyUsage=digitalSignature" \
  -addext "extendedKeyUsage=codeSigning" \
  -nodes >/dev/null 2>&1

cp "$CRT_PATH" "$CER_PATH"

openssl pkcs12 -export \
  -inkey "$KEY_PATH" \
  -in "$CRT_PATH" \
  -out "$PFX_PATH" \
  -passout "pass:$PASSWORD" >/dev/null 2>&1

chmod 600 "$KEY_PATH" "$PFX_PATH" "$PASSWORD_PATH"
chmod 644 "$CRT_PATH" "$CER_PATH"

echo "✓ Generated self-signed Windows code-signing cert"
echo "  PFX: $PFX_PATH"
echo "  CER: $CER_PATH"
echo "  Password file: $PASSWORD_PATH"
