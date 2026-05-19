#!/usr/bin/env pwsh
# smallcode — one-line installer for Windows
#
# Downloads the platform-specific portable tarball from GitHub Releases
# and installs it locally. No npm / node-gyp build tools needed.
#
# Usage (run as normal user, not admin):
#   irm https://raw.githubusercontent.com/Zireael/smallcode/main/install.ps1 | iex
#
# Environment variables (all optional):
#   SMALLCODE_HOME   Install directory  (default: ~\.smallcode)
#   SMALLCODE_REPO   GitHub repo        (default: Zireael/smallcode)
#   SMALLCODE_VER    Release version    (default: latest)

param(
  [string]$Version = "latest",
  [string]$InstallDir = "",
  [string]$Repo = "Zireael/smallcode"
)

# ---- config ---------------------------------------------------------------
if (-not $InstallDir) {
  $InstallDir = [Environment]::GetEnvironmentVariable("SMALLCODE_HOME", "User")
}
if (-not $InstallDir) {
  $InstallDir = "$env:USERPROFILE\.smallcode"
}

if ($env:SMALLCODE_REPO) { $Repo = $env:SMALLCODE_REPO }
if ($env:SMALLCODE_VER)  { $Version = $env:SMALLCODE_VER }

# ---- detect platform ------------------------------------------------------
$arch = if ([Environment]::Is64BitOperatingSystem) { "X64" } else { "ARM64" }
$platformTag = "Windows-$arch"
$bundle = "smallcode-$platformTag.tar.gz"

if ($Version -eq "latest") {
  $downloadUrl = "https://github.com/$Repo/releases/latest/download/$bundle"
} else {
  $downloadUrl = "https://github.com/$Repo/releases/download/v$Version/$bundle"
}

# ---- intro ----------------------------------------------------------------
Write-Host "==> smallcode installer"
Write-Host "    Platform    $platformTag"
Write-Host "    Install to  $InstallDir"
Write-Host "    Version     $Version"

# ---- download -------------------------------------------------------------
$tmpDir = Join-Path $env:TEMP "smallcode-install-$([System.IO.Path]::GetRandomFileName())"
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
$tmpFile = Join-Path $tmpDir $bundle

Write-Host "==> Downloading $downloadUrl ..."
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -Uri $downloadUrl -OutFile $tmpFile -UseBasicParsing

# ---- extract --------------------------------------------------------------
Write-Host "==> Extracting ..."
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# Use system tar to avoid Git Bash/MSYS2 tar's path issues on Windows
$tarBin = if (Test-Path "$env:SystemRoot\System32\tar.exe") {
  "$env:SystemRoot\System32\tar.exe"
} else {
  "tar"
}
Write-Host "    Using tar: $tarBin"
& $tarBin -xzf $tmpFile -C $InstallDir --strip-components=1

# Remove temporary files
Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue

# ---- launcher wrapper (.cmd for old cmd.exe) ------------------------------
$launcherCmd = Join-Path $InstallDir "smallcode.cmd"
@"
@echo off
set "NODE_PATH=%~dp0node_modules"
node "%~dp0bin\smallcode.js" %*
"@ | Out-File -FilePath $launcherCmd -Encoding ascii

# Also create a PowerShell launcher
$launcherPs = Join-Path $InstallDir "smallcode.ps1"
@"
`$env:NODE_PATH = Join-Path `$PSScriptRoot "node_modules"
& "node" (Join-Path `$PSScriptRoot "bin\smallcode.js") `$args
"@ | Out-File -FilePath $launcherPs -Encoding ascii

# ---- warn about shadowed install ------------------------------------------
$existingCmd = Get-Command "smallcode" -ErrorAction SilentlyContinue
if ($existingCmd -and $existingCmd.Source -notlike "$InstallDir*") {
  Write-Host "==> WARNING: 'smallcode' already resolves to $($existingCmd.Source)"
  Write-Host "    The new install at $InstallDir will NOT be used."
  Write-Host "    To fix: remove the old install, then restart your terminal."
  Write-Host ""
}

# ---- add to PATH ----------------------------------------------------------
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$pathUpdated = $false
if ($userPath -notlike "*$InstallDir*") {
  $newPath = "$InstallDir;$userPath"
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  Write-Host "==> Added $InstallDir to user PATH"
  $pathUpdated = $true
}

# Refresh current session's PATH so 'smallcode' works immediately
if ($pathUpdated -or ($env:Path -notlike "*$InstallDir*")) {
  $env:Path = "$InstallDir;$env:Path"
  Write-Host "==> Refreshed PATH for this terminal session"
}

Write-Host ""
Write-Host "==> Done!  Run 'smallcode --help' to verify."
