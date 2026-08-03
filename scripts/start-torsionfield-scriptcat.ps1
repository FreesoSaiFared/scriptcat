param(
  [int]$RemoteDebuggingPort = 9333,
  [string]$ChromePath = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$extensionPath = Join-Path $repoRoot "dist\ext"
$runtimeRoot = Join-Path $env:LOCALAPPDATA "Torsionfield\ScriptCat-1.5"
$profilePath = Join-Path $runtimeRoot "chrome-profile"
$receiptPath = Join-Path $runtimeRoot "last-launch.json"

if (-not $ChromePath) {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Google\Chrome SxS\Application\chrome.exe"
  )
  $ChromePath = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if (-not $ChromePath -or -not (Test-Path $ChromePath)) {
  throw "Chrome executable not found. Pass -ChromePath explicitly."
}

Push-Location $repoRoot
try {
  if (-not (Test-Path (Join-Path $extensionPath "manifest.json"))) {
    & corepack pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed with exit code $LASTEXITCODE" }
    & corepack pnpm run build
    if ($LASTEXITCODE -ne 0) { throw "ScriptCat build failed with exit code $LASTEXITCODE" }
  }
} finally {
  Pop-Location
}

New-Item -ItemType Directory -Force -Path $profilePath | Out-Null
$arguments = @(
  "--user-data-dir=$profilePath",
  "--disable-extensions-except=$extensionPath",
  "--load-extension=$extensionPath",
  "--remote-debugging-port=$RemoteDebuggingPort",
  "chrome://extensions/"
)
$process = Start-Process -FilePath $ChromePath -ArgumentList $arguments -PassThru

$deadline = (Get-Date).AddSeconds(20)
$targets = $null
while ((Get-Date) -lt $deadline) {
  try {
    $targets = Invoke-RestMethod "http://127.0.0.1:$RemoteDebuggingPort/json/list"
    if ($targets) { break }
  } catch {
    Start-Sleep -Milliseconds 400
  }
}
if (-not $targets) { throw "Chrome started, but CDP did not become available on port $RemoteDebuggingPort" }

$worker = $targets | Where-Object {
  $_.type -eq "service_worker" -and $_.url -like "chrome-extension://*/service_worker.js"
} | Select-Object -First 1
if (-not $worker) { throw "Chrome started, but ScriptCat's service worker was not found" }

$extensionId = ([regex]::Match($worker.url, "chrome-extension://([^/]+)/")).Groups[1].Value
$receipt = [ordered]@{
  ok = $true
  processId = $process.Id
  extensionId = $extensionId
  extensionPath = $extensionPath
  profilePath = $profilePath
  remoteDebuggingPort = $RemoteDebuggingPort
  serviceWorker = $worker.url
  startedAt = (Get-Date).ToUniversalTime().ToString("o")
}
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
$receipt | ConvertTo-Json | Set-Content -Encoding UTF8 $receiptPath
$receipt | ConvertTo-Json
