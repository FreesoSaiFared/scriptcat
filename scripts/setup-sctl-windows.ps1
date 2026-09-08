[CmdletBinding()]
param(
  [string]$Version = "0.1.0",
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA "sctl\data"),
  [switch]$Enroll,
  [switch]$NoStartupTask
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$InstallRoot = Join-Path $env:LOCALAPPDATA "sctl\bin"
$SctlExe = Join-Path $InstallRoot "sctl.exe"
$Runner = Join-Path $env:LOCALAPPDATA "sctl\run-sctl-serve.ps1"
$TaskName = "ScriptCat sctl daemon"

function Assert-LastExitCode([string]$Step) {
  if ($LASTEXITCODE -ne 0) {
    throw "$Step failed with exit code $LASTEXITCODE"
  }
}

Write-Host "[sctl] installing official sctl v$Version"
$env:SCTL_VERSION = $Version
$env:SCTL_INSTALL_DIR = $InstallRoot
$installer = Invoke-RestMethod "https://raw.githubusercontent.com/scriptscat/sctl/main/scripts/install.ps1"
Invoke-Expression $installer

if (-not (Test-Path -LiteralPath $SctlExe)) {
  throw "sctl executable not found at $SctlExe"
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
[Environment]::SetEnvironmentVariable("SCTL_DATA_DIR", $DataDir, "User")
$env:SCTL_DATA_DIR = $DataDir

& $SctlExe version
Assert-LastExitCode "sctl version"

$runnerContent = @"
`$ErrorActionPreference = "Stop"
`$env:SCTL_DATA_DIR = "$($DataDir.Replace('"','`"'))"
& "$($SctlExe.Replace('"','`"'))" serve
exit `$LASTEXITCODE
"@
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Runner) | Out-Null
Set-Content -LiteralPath $Runner -Value $runnerContent -Encoding UTF8

if (-not $NoStartupTask) {
  $powershellExe = (Get-Command powershell.exe).Source
  $argument = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Runner`""
  $action = New-ScheduledTaskAction -Execute $powershellExe -Argument $argument
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Official ScriptCat sctl daemon for External Access" -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
} else {
  $existing = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $SctlExe -and $_.CommandLine -match '\bserve\b' }
  if (-not $existing) {
    Start-Process -FilePath $SctlExe -ArgumentList @("serve") -WindowStyle Hidden -Environment @{ SCTL_DATA_DIR = $DataDir }
  }
}

$deadline = (Get-Date).AddSeconds(15)
do {
  Start-Sleep -Milliseconds 500
  & $SctlExe status 2>$null
  $statusExit = $LASTEXITCODE
} while ($statusExit -ne 0 -and (Get-Date) -lt $deadline)

if ($statusExit -ne 0) {
  throw "sctl daemon did not become reachable. Run: `$env:SCTL_DATA_DIR='$DataDir'; & '$SctlExe' serve"
}

Write-Host ""
Write-Host "[sctl] daemon reachable"
Write-Host "[sctl] data dir: $DataDir"
Write-Host "[sctl] endpoint: ws://127.0.0.1:8643"
Write-Host ""
Write-Host "ScriptCat one-time enrollment is intentionally interactive:"
Write-Host "  1. Load an External-Access-capable ScriptCat build."
Write-Host "  2. ScriptCat Options -> Tools -> External Access: enable it."
Write-Host "  3. Run:  & '$SctlExe' connect"
Write-Host "  4. Enter the locally displayed one-time code into ScriptCat. Do not paste it into chat."
Write-Host "  5. Verify: & '$SctlExe' status"
Write-Host "  6. Inventory: & '$SctlExe' get -o json"

if ($Enroll) {
  Write-Host ""
  Write-Host "[sctl] starting local enrollment. Complete the code entry in ScriptCat."
  & $SctlExe connect
  Assert-LastExitCode "sctl connect"
  & $SctlExe status
  Assert-LastExitCode "sctl status after enrollment"
}
