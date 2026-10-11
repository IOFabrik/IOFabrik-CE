# Windows PowerShell 5.1+. Validate the exact public release asset contract.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [switch]$WriteChecksums
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'Release verification requires Windows.' }
$names = @('iofabrik-windows-amd64.exe', 'iofabrik-amd64-installer.exe')
$directoryPath = (Resolve-Path -LiteralPath $Directory).ProviderPath
$checksumPath = Join-Path $directoryPath 'SHA256SUMS'
$allowed = @($names) + @('SHA256SUMS')
foreach ($item in Get-ChildItem -LiteralPath $directoryPath -Force) {
    if ($item.PSIsContainer -or $item.Name -cnotin $allowed) {
        throw "Unexpected release artifact: $($item.Name)"
    }
}
# Check both signatures before computing either digest. Never permit the local
# self-signed signature-presence bypass used by development signing tools.
foreach ($name in $names) {
    $path = Join-Path $directoryPath $name
    if (!(Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -eq 0) {
        throw "Missing or empty artifact: $name"
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $path
    if ($signature.Status -ne 'Valid' -or !$signature.SignerCertificate) {
        throw "Invalid Authenticode signature for ${name}: $($signature.Status)"
    }
    if (!$signature.TimeStamperCertificate) { throw "Timestamp certificate missing: $name" }
}
$expected = @($names | ForEach-Object {
    $hash = (Get-FileHash -LiteralPath (Join-Path $directoryPath $_) -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $_"
})
if ($WriteChecksums) {
    if (Test-Path -LiteralPath $checksumPath) { throw 'SHA256SUMS already exists; validate it instead of overwriting it.' }
    [IO.File]::WriteAllText($checksumPath, ($expected -join "`n") + "`n", [Text.Encoding]::ASCII)
}
$actual = @(Get-Content -LiteralPath $checksumPath)
if ($actual.Count -ne $expected.Count) { throw 'SHA256SUMS must contain exactly the two required assets.' }
for ($i = 0; $i -lt $expected.Count; $i++) {
    if ($actual[$i] -cne $expected[$i]) { throw "Checksum mismatch or invalid filename: $($names[$i])" }
}
Write-Host 'Authenticode signatures and SHA256SUMS verified.'
