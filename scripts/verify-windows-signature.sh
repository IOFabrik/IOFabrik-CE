#!/usr/bin/env bash
# verify-windows-signature.sh
#
# Verifies Authenticode signatures for Windows binaries/installers.
#
# Verification priority:
#   1) signtool (preferred on Windows)
#   2) PowerShell Get-AuthenticodeSignature (Windows fallback)
#   3) osslsigncode verify (cross-platform fallback)
#
# Usage:
#   ./scripts/verify-windows-signature.sh <artifact.exe>

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <artifact.exe>" >&2
  exit 1
fi

ARTIFACT="$1"
ALLOW_SELF_SIGNED="${IOFABRIK_WINDOWS_SELF_SIGNED:-false}"

if [[ ! -f "$ARTIFACT" ]]; then
  echo "✗ Artifact not found: $ARTIFACT" >&2
  exit 1
fi

# Prefer signtool where available
if command -v signtool >/dev/null 2>&1; then
  echo "ℹ Verifying with signtool: $ARTIFACT"
  if signtool verify /pa /all /v "$ARTIFACT"; then
    echo "✓ Signature verified (signtool)"
    exit 0
  fi
  if [[ "$ALLOW_SELF_SIGNED" != "true" ]]; then
    exit 1
  fi
  echo "⚠ Trust-chain verification failed, falling back to signature-presence checks (self-signed mode)."
fi

# Windows fallback via PowerShell
if command -v powershell >/dev/null 2>&1; then
  echo "ℹ Verifying with PowerShell: $ARTIFACT"
  if [[ "$ALLOW_SELF_SIGNED" == "true" ]]; then
    powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "
      \$sig = Get-AuthenticodeSignature -FilePath '$ARTIFACT';
      if (\$sig.Status -eq 'NotSigned' -or -not \$sig.SignerCertificate) {
        Write-Error 'No Authenticode signature present';
        exit 1;
      }
      Write-Host ('Signature present (self-signed mode): ' + \$sig.SignerCertificate.Subject);
      if (\$sig.TimeStamperCertificate) {
        Write-Host ('Timestamp: ' + \$sig.TimeStamperCertificate.Subject);
      }
    "
    echo "✓ Signature present (PowerShell, self-signed mode)"
    exit 0
  fi

  powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "
    \$sig = Get-AuthenticodeSignature -FilePath '$ARTIFACT';
    if (\$sig.Status -ne 'Valid') {
      Write-Error ('Authenticode status is ' + \$sig.Status);
      exit 1;
    }
    if (-not \$sig.TimeStamperCertificate) {
      Write-Error 'Timestamp certificate missing';
      exit 1;
    }
    Write-Host ('Signature OK: ' + \$sig.SignerCertificate.Subject);
    Write-Host ('Timestamp: ' + \$sig.TimeStamperCertificate.Subject);
  "
  echo "✓ Signature verified (PowerShell)"
  exit 0
fi

# Cross-platform fallback
if command -v osslsigncode >/dev/null 2>&1; then
  echo "ℹ Verifying with osslsigncode: $ARTIFACT"
  if [[ "$ALLOW_SELF_SIGNED" == "true" ]]; then
    output="$(osslsigncode verify -in "$ARTIFACT" 2>&1 || true)"
    echo "$output"
    if echo "$output" | grep -Eiq "No signature found|Unable to extract existing signature"; then
      echo "✗ No Authenticode signature found" >&2
      exit 1
    fi
  else
    osslsigncode verify -in "$ARTIFACT"
  fi
  echo "✓ Signature verified (osslsigncode)"
  exit 0
fi

echo "✗ No signature verification tool available." >&2
echo "  Install one of: signtool (Windows SDK), PowerShell (Windows), or osslsigncode." >&2
exit 1
