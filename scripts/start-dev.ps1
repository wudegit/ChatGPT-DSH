param(
  [switch]$Diagnostics
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot '.env.local'

if (-not (Test-Path $envFile)) {
  throw "Missing $envFile. Copy .env.example to .env.local and fill in the secrets."
}

foreach ($rawLine in Get-Content $envFile) {
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

if (-not (Test-Path $tunnelExe)) {
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

$patchPath = Join-Path $repoRoot 'cordis.patch.yml'
$dshCommand = "Set-Location -LiteralPath '$($repoRoot.Replace("'", "''"))'; dsh web --patch '$($patchPath.Replace("'", "''"))' --no-open"
$tunnelDir = Split-Path -Parent $tunnelExe
$tunnelCommand = "Set-Location -LiteralPath '$($tunnelDir.Replace("'", "''"))'; & '$($tunnelExe.Replace("'", "''"))' run --profile '$($tunnelProfile.Replace("'", "''"))'"

$dshProcess = Start-Process powershell.exe -ArgumentList @('-NoExit', '-NoProfile', '-Command', $dshCommand) -WorkingDirectory $repoRoot -PassThru
$tunnelProcess = Start-Process powershell.exe -ArgumentList @('-NoExit', '-NoProfile', '-Command', $tunnelCommand) -WorkingDirectory $tunnelDir -PassThru

Write-Host "Started DSH window (PID $($dshProcess.Id))."
Write-Host "Started tunnel-client window (PID $($tunnelProcess.Id), profile '$tunnelProfile')."
Write-Host "Diagnostics: $(if ($Diagnostics) { 'ON' } else { 'OFF' })"
Write-Host 'Tunnel UI: http://127.0.0.1:8080/ui'
