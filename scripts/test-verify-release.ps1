# Run on Windows: powershell -NoProfile -File scripts/test-verify-release.ps1
# Signature responses are simulated; hashing and manifest validation are real.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
$verifierDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$verifier = Join-Path $verifierDirectory 'verify-release.ps1'
$names = @('iofabrik-windows-amd64.exe', 'iofabrik-amd64-installer.exe')
$script:signatureStatus = 'Valid'
$script:timestamp = 'test timestamp'
function Get-AuthenticodeSignature {
    param([string]$LiteralPath)
    [pscustomobject]@{ Status = $script:signatureStatus; SignerCertificate = 'test signer'; TimeStamperCertificate = $script:timestamp }
}
function Assert-Rejected([string]$Description, [scriptblock]$Action) {
    $rejected = $false
    try { & $Action } catch { $rejected = $true }
    if (!$rejected) { throw "Expected rejection: $Description" }
    Write-Host "PASS: $Description"
}
try {
    New-Item -ItemType Directory -Path $root | Out-Null
    foreach ($name in $names) { [IO.File]::WriteAllText((Join-Path $root $name), 'test executable bytes') }
    & $verifier -Directory $root -WriteChecksums
    & $verifier -Directory $root
    Write-Host 'PASS: valid signatures and checksums'
    $manifest = Join-Path $root 'SHA256SUMS'
    $original = [IO.File]::ReadAllText($manifest)
    Assert-Rejected 'refuse to overwrite existing checksums' { & $verifier -Directory $root -WriteChecksums }
    foreach ($name in $names) {
        $path = Join-Path $root $name
        Remove-Item -LiteralPath $path
        Assert-Rejected "missing $name" { & $verifier -Directory $root }
        [IO.File]::WriteAllText($path, 'test executable bytes')
    }
    foreach ($status in @('NotSigned', 'HashMismatch', 'NotTrusted')) {
        $script:signatureStatus = $status
        Assert-Rejected "signature $status" { & $verifier -Directory $root }
    }
    $script:signatureStatus = 'Valid'
    $script:timestamp = $null
    Assert-Rejected 'missing timestamp' { & $verifier -Directory $root }
    $script:timestamp = 'test timestamp'
    [IO.File]::AppendAllText((Join-Path $root $names[0]), 'corrupted')
    Assert-Rejected 'corrupted executable' { & $verifier -Directory $root }
    [IO.File]::WriteAllText((Join-Path $root $names[0]), 'test executable bytes')
    [IO.File]::WriteAllText($manifest, $original.Replace($names[0], 'wrong-name.exe'))
    Assert-Rejected 'wrong checksum filename' { & $verifier -Directory $root }
    [IO.File]::WriteAllText($manifest, $original + "extra`n")
    Assert-Rejected 'extra checksum entry' { & $verifier -Directory $root }
    [IO.File]::WriteAllText($manifest, $original)
    [IO.File]::WriteAllText((Join-Path $root 'update.json'), '{}')
    Assert-Rejected 'unexpected artifact' { & $verifier -Directory $root }
} finally {
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
