param(
    [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"
if (Get-Variable PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $true
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$ArgumentList
    )

    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($ArgumentList -join ' ')"
    }
}

$ProjectDir = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $ProjectDir ".env"
Set-Location $ProjectDir

foreach ($Program in @("git.exe", "node.exe", "npm.cmd", "pm2.cmd")) {
    if (-not (Get-Command $Program -ErrorAction SilentlyContinue)) {
        throw "Required command is missing: $Program"
    }
}

if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
    throw "Missing $EnvFile. Create it from .env.example before deploying."
}

$CurrentBranch = (& git.exe branch --show-current).Trim()
if ($LASTEXITCODE -ne 0) {
    throw "Could not determine the current Git branch."
}
if ($CurrentBranch -ne $Branch) {
    throw "Current branch is '$CurrentBranch'; expected '$Branch'."
}

& git.exe diff --quiet
if ($LASTEXITCODE -ne 0) {
    throw "Tracked files have local changes. Commit or stash them before deploying."
}
& git.exe diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
    throw "The Git index has uncommitted changes. Commit or stash them before deploying."
}

$EnvBackup = Join-Path ([System.IO.Path]::GetTempPath()) ("los-barrios-env-" + [guid]::NewGuid().ToString("N"))
Copy-Item -LiteralPath $EnvFile -Destination $EnvBackup

try {
    Write-Host "Fetching origin/$Branch..."
    Invoke-Checked git.exe fetch origin $Branch
    Invoke-Checked git.exe merge --ff-only "origin/$Branch"

    # The local deployment credentials always win over repository contents.
    Copy-Item -LiteralPath $EnvBackup -Destination $EnvFile -Force

    Write-Host "Installing locked dependencies..."
    Invoke-Checked npm.cmd ci --include=dev

    Write-Host "Verifying the release..."
    Invoke-Checked npm.cmd test
    Invoke-Checked npm.cmd run typecheck
    Invoke-Checked npm.cmd run build

    $BuiltEntry = Join-Path $ProjectDir "dist/bot.js"
    if (-not (Test-Path -LiteralPath $BuiltEntry -PathType Leaf)) {
        throw "Build completed without creating dist/bot.js."
    }

    Write-Host "Removing development-only dependencies..."
    Invoke-Checked npm.cmd prune --omit=dev

    Write-Host "Reloading los-barrios-bot with PM2..."
    Invoke-Checked pm2.cmd startOrReload ecosystem.config.cjs --update-env
    Invoke-Checked pm2.cmd save

    Write-Host "Deployment completed successfully."
}
finally {
    if (Test-Path -LiteralPath $EnvBackup) {
        Copy-Item -LiteralPath $EnvBackup -Destination $EnvFile -Force
        Remove-Item -LiteralPath $EnvBackup -Force
    }
}
