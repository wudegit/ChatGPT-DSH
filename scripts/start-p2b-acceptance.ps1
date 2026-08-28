param(
  [string]$Workspace = 'D:\work\ChatGPT-DSH-P2B-Test',
  [switch]$Diagnostics
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot '.env.local'
$patchPath = Join-Path $repoRoot 'cordis.patch.yml'

if (-not (Test-Path -LiteralPath $Workspace)) {
  throw "Workspace not found: $Workspace"
}

$workspacePath = (Resolve-Path -LiteralPath $Workspace).Path

if (-not (Test-Path -LiteralPath $envFile)) {
  throw "Missing $envFile. Create it first and fill in the required secrets."
}

foreach ($rawLine in Get-Content -LiteralPath $envFile) {
  $line = $rawLine.Trim()
  if ($line.Length -eq 0 -or $line.StartsWith('#')) { continue }

  $parts = $line -split '=', 2
  if ($parts.Count -ne 2) { continue }

  $name = $parts[0].Trim()
  $value = $parts[1].Trim()

  if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
    $value = $value.Substring(1, $value.Length - 2)
  }

  Set-Item -Path "Env:$name" -Value $value
}

if ([string]::IsNullOrWhiteSpace($env:CHATGPT_DSH_TOKEN)) {
  throw 'CHATGPT_DSH_TOKEN is missing from .env.local'
}

if ([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)) {
  throw 'CONTROL_PLANE_API_KEY is missing from .env.local'
}

$tunnelExe = if ($env:TUNNEL_CLIENT_EXE) { $env:TUNNEL_CLIENT_EXE } else { 'D:\program\tunnel\tunnel-client.exe' }
$tunnelProfile = if ($env:TUNNEL_PROFILE) { $env:TUNNEL_PROFILE } else { 'chatgpt-dsh' }

if (-not (Test-Path -LiteralPath $tunnelExe)) {
  throw "tunnel-client not found: $tunnelExe"
}

if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
  throw 'dsh was not found on PATH'
}

foreach ($port in 3080, 3210, 8080) {
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    throw "Port $port is already in use by PID $($listener.OwningProcess). Stop the old DSH/tunnel process first."
  }
}

$env:CHATGPT_DSH_DIAGNOSTIC_REQUESTS = if ($Diagnostics) { '1' } else { '0' }
$env:CHATGPT_DSH_AUTH = "Bearer $env:CHATGPT_DSH_TOKEN"
$env:MCP_EXTRA_HEADERS = 'Authorization: env:CHATGPT_DSH_AUTH'

$escapedWorkspace = $workspacePath.Replace("'", "''")
$escapedPatchPath = $patchPath.Replace("'", "''")
$escapedTunnelExe = $tunnelExe.Replace("'", "''")
$escapedTunnelProfile = $tunnelProfile.Replace("'", "''")
$tunnelDir = Split-Path -Parent $tunnelExe
$escapedTunnelDir = $tunnelDir.Replace("'", "''")

# P2-B acceptance requires the DSH Host cwd to be the target workspace.
# Do not switch this command back to $repoRoot: process.cwd() is what the
# workspace-binding implementation captures into SessionHeader.cwd.
$dshCommand = "Set-Location -LiteralPath '$escapedWorkspace'; dsh web --patch '$escapedPatchPath' --no-open"
$tunnelCommand = "Set-Location -LiteralPath '$escapedTunnelDir'; & '$escapedTunnelExe' run --profile '$escapedTunnelProfile'"

$dshProcess = Start-Process powershell.exe -ArgumentList @('-NoExit', '-NoProfile', '-Command', $dshCommand) -WorkingDirectory $workspacePath -PassThru
$tunnelProcess = Start-Process powershell.exe -ArgumentList @('-NoExit', '-NoProfile', '-Command', $tunnelCommand) -WorkingDirectory $tunnelDir -PassThru

Write-Host "P2-B acceptance workspace: $workspacePath"
Write-Host "Loaded secrets from: $envFile"
Write-Host "Started DSH window (PID $($dshProcess.Id))."
Write-Host "Started tunnel-client window (PID $($tunnelProcess.Id), profile '$tunnelProfile')."
Write-Host "Diagnostics: $(if ($Diagnostics) { 'ON' } else { 'OFF' })"
Write-Host 'Tunnel UI: http://127.0.0.1:8080/ui'

