#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT/autoresearch-logs"
RUN_ID="${AUTORESEARCH_RUN_ID:-$(date -u +"%Y%m%dT%H%M%SZ")}"
RUN_DIR="$LOG_DIR/$RUN_ID"
mkdir -p "$RUN_DIR"

TEST_LOG="$RUN_DIR/focused-tests.log"
BUILD_LOG="$RUN_DIR/build.log"
SYNC_LOG="$RUN_DIR/sync.log"
WINDOWS_LOG="$RUN_DIR/windows-probe.json"

run_step() {
  local name="$1"
  shift
  echo "[autoresearch] $name"
  "$@"
}

capture_windows_probe() {
  ssh tickblaze-kamatera 'powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -' <<'PS1'
$ErrorActionPreference = "Stop"

$vaultPath = Join-Path $env:USERPROFILE "Documents\SystemSculptWindowsQA"
$obsidianExe = Join-Path $env:LOCALAPPDATA "Programs\Obsidian\Obsidian.exe"
$discoveryDir = Join-Path $env:USERPROFILE ".systemsculpt\obsidian-automation"

Get-Process Obsidian -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
if (Test-Path $discoveryDir) {
  Get-ChildItem -Path $discoveryDir -Filter *.json -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
}

if (!(Test-Path $obsidianExe)) {
  throw "Obsidian executable not found: $obsidianExe"
}
if (!(Test-Path $vaultPath)) {
  throw "Windows QA vault not found: $vaultPath"
}

Start-Process -FilePath $obsidianExe -ArgumentList @($vaultPath) | Out-Null

$deadline = (Get-Date).AddMinutes(2)
$discovery = $null
$pingResult = $null

function Test-BridgeRecord {
  param(
    [Parameter(Mandatory = $true)]
    [pscustomobject]$Parsed,
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $headers = @{
    Authorization = "Bearer $([string]$Parsed.token)"
    "Content-Type" = "application/json"
  }

  try {
    $pong = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$([int]$Parsed.port)/v1/ping" -Headers $headers
    return [ordered]@{
      ok = $true
      discovery = [ordered]@{
        path = $Path
        host = if ($Parsed.host) { [string]$Parsed.host } else { "127.0.0.1" }
        port = [int]$Parsed.port
        token = [string]$Parsed.token
        startedAt = if ($Parsed.startedAt) { [string]$Parsed.startedAt } else { $null }
        vaultName = if ($Parsed.vaultName) { [string]$Parsed.vaultName } else { $null }
      }
      ping = $pong.data
    }
  } catch {
    return $null
  }
}

do {
  Start-Sleep -Milliseconds 750
  $candidate = Get-ChildItem -Path $discoveryDir -Filter *.json -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
  if ($candidate) {
    try {
      $parsed = Get-Content -Raw -Path $candidate.FullName | ConvertFrom-Json
      if ($parsed.port -and $parsed.token) {
        $probe = Test-BridgeRecord -Parsed $parsed -Path $candidate.FullName
        if ($probe) {
          $discovery = $probe.discovery
          $pingResult = $probe.ping
        }
      }
    } catch {
    }
  }
} while (-not $discovery -and (Get-Date) -lt $deadline)

if (-not $discovery) {
  throw "Timed out waiting for Windows desktop automation discovery."
}

$headers = @{
  Authorization = "Bearer $($discovery.token)"
  "Content-Type" = "application/json"
}

function Invoke-BridgeJson {
  param(
    [string]$Path,
    [object]$Body = $null
  )

  $uri = "http://$($discovery.host):$($discovery.port)$Path"
  $jsonBody = if ($null -eq $Body) { $null } else { $Body | ConvertTo-Json -Depth 10 -Compress }
  try {
    $response = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body $jsonBody
    return [ordered]@{
      ok = $true
      data = $response.data
      error = $null
      stack = $null
    }
  } catch {
    $responseText = $null
    if ($_.Exception.Response) {
      try {
        $stream = $_.Exception.Response.GetResponseStream()
        if ($stream) {
          $reader = New-Object System.IO.StreamReader($stream)
          $responseText = $reader.ReadToEnd()
          $reader.Dispose()
          $stream.Dispose()
        }
      } catch {
      }
    }

    $parsedBody = $null
    if ($responseText) {
      try {
        $parsedBody = $responseText | ConvertFrom-Json
      } catch {
      }
    }

    return [ordered]@{
      ok = $false
      data = if ($parsedBody -and $parsedBody.data) { $parsedBody.data } else { $null }
      error = if ($parsedBody -and $parsedBody.error) { [string]$parsedBody.error } else { [string]$_.Exception.Message }
      stack = if ($parsedBody -and $parsedBody.stack) { [string]$parsedBody.stack } else { $null }
    }
  }
}

$settingsOpen = Invoke-BridgeJson -Path "/v1/settings/open" -Body @{ targetTab = "providers" }
$providersSnapshot = Invoke-BridgeJson -Path "/v1/settings/providers/snapshot" -Body @{}

$result = [ordered]@{
  discovery = $discovery
  ping = $pingResult
  settingsOpen = $settingsOpen
  providersSnapshot = $providersSnapshot
  metrics = [ordered]@{
    settings_open_ok = if ($settingsOpen.ok) { 1 } else { 0 }
    providers_snapshot_ok = if ($providersSnapshot.ok) { 1 } else { 0 }
  }
}

$result | ConvertTo-Json -Depth 20
PS1
}

pushd "$ROOT" >/dev/null

run_step "focused local checks" \
  bash -lc 'npm test -- src/testing/automation/__tests__/DesktopAutomationBridge.test.ts src/__tests__/settings-providers-tab.test.ts src/__tests__/settings-providers-tab.import-safe.test.ts src/studio/piAuth/__tests__/studio-pi-auth-storage-fetch-shim.test.ts src/services/pi/__tests__/PiSdkRuntime.paths.test.ts' \
  | tee "$TEST_LOG"

run_step "production build" \
  bash -lc 'npm run build' \
  | tee "$BUILD_LOG"

run_step "sync plugin artifacts" \
  bash -lc 'node scripts/sync-local-vaults.mjs' \
  | tee "$SYNC_LOG"

echo "[autoresearch] windows providers probe"
WINDOWS_PAYLOAD="$(capture_windows_probe)"
printf '%s\n' "$WINDOWS_PAYLOAD" | tee "$WINDOWS_LOG"

node - "$WINDOWS_LOG" <<'NODE'
const fs = require("node:fs");
const logPath = process.argv[2];
const payload = JSON.parse(fs.readFileSync(logPath, "utf8"));
const metrics = payload?.metrics || {};
const boolMetric = (value) => (Number(value) === 1 ? 1 : 0);
console.log(`METRIC focused_tests_ok=1`);
console.log(`METRIC build_ok=1`);
console.log(`METRIC sync_ok=1`);
console.log(`METRIC settings_open_ok=${boolMetric(metrics.settings_open_ok)}`);
console.log(`METRIC providers_snapshot_ok=${boolMetric(metrics.providers_snapshot_ok)}`);
if (!payload?.providersSnapshot?.ok) {
  console.log(`DETAIL providers_snapshot_error=${JSON.stringify(String(payload?.providersSnapshot?.error || ""))}`);
}
if (!payload?.settingsOpen?.ok) {
  console.log(`DETAIL settings_open_error=${JSON.stringify(String(payload?.settingsOpen?.error || ""))}`);
}
NODE

popd >/dev/null
