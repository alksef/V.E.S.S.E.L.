# Tauri builds the frontend via beforeBuildCommand.
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet("release", "debug", "r", "d")]
    [string]$Mode = "release",
    [switch]$Bundle,
    [ValidateNotNullOrEmpty()]
    [string]$CargoTargetDir,
    [ValidateNotNullOrEmpty()]
    [string]$RustBinDir,
    [ValidateNotNullOrEmpty()]
    [string]$ConfigFile
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$Mode = switch ($Mode.ToLowerInvariant()) {
    "r" { "release" }
    "d" { "debug" }
    default { $Mode.ToLowerInvariant() }
}

function Resolve-BuildPath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { throw "Build path cannot be empty." }
    $expanded = [Environment]::ExpandEnvironmentVariables($Value)
    if (-not [IO.Path]::IsPathRooted($expanded)) {
        $expanded = Join-Path $repoRoot $expanded
    }
    return [IO.Path]::GetFullPath($expanded)
}

$configPath = if ($ConfigFile) { Resolve-BuildPath $ConfigFile } else {
    Join-Path $PSScriptRoot "build.local.psd1"
}
$config = @{}
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    $config = Import-PowerShellDataFile -LiteralPath $configPath
    foreach ($key in $config.Keys) {
        if ($key -notin @("CargoTargetDir", "RustBinDir")) {
            throw "Unknown build config key: $key"
        }
        if ($null -ne $config[$key] -and $config[$key] -isnot [string]) {
            throw "Build config key $key must be a string or null."
        }
    }
} elseif ($ConfigFile) {
    throw "Build config not found: $configPath"
}

$targetPath = if ($PSBoundParameters.ContainsKey("CargoTargetDir")) { $CargoTargetDir }
    elseif (Test-Path Env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR }
    elseif ($null -ne $config.CargoTargetDir) { $config.CargoTargetDir }
    else { "src-tauri\target" }
$targetDir = Resolve-BuildPath $targetPath

$rustPath = if ($PSBoundParameters.ContainsKey("RustBinDir")) { $RustBinDir }
    elseif (Test-Path Env:VESSEL_RUST_BIN_DIR) { $env:VESSEL_RUST_BIN_DIR }
    elseif ($null -ne $config.RustBinDir) { $config.RustBinDir }
    elseif (Test-Path (Join-Path $env:USERPROFILE ".cargo\bin")) {
        Join-Path $env:USERPROFILE ".cargo\bin"
    } else { $null }
if ($null -ne $rustPath) {
    $rustPath = Resolve-BuildPath $rustPath
    if (-not (Test-Path -LiteralPath $rustPath -PathType Container)) {
        throw "Rust bin directory not found: $rustPath"
    }
}

$previousPath = $env:PATH
$previousTargetDir = $env:CARGO_TARGET_DIR
Push-Location $repoRoot
try {
    $env:CARGO_TARGET_DIR = $targetDir
    if ($rustPath) { $env:PATH = "$rustPath;$env:PATH" }
    Write-Host "Building $Mode; Cargo target: $targetDir"
    $tauriArgs = @("tauri", "build")
    if ($Mode -eq "debug") { $tauriArgs += "--debug" }
    if (-not $Bundle) { $tauriArgs += "--no-bundle" }
    & pnpm @tauriArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    $binary = Join-Path $targetDir "$Mode\vessel.exe"
    if (-not (Test-Path -LiteralPath $binary)) {
        throw "Build output not found: $binary"
    }
    Write-Host "Built: $binary"
} finally {
    $env:PATH = $previousPath
    $env:CARGO_TARGET_DIR = $previousTargetDir
    Pop-Location
}
