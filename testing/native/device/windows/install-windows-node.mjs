#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_WINDOWS_NODE_EXE,
  DEFAULT_WINDOWS_SSH_HOST,
  runRemotePowerShellScript,
} from "./remote-run.mjs";

const DEFAULT_NODE_MAJOR = 20;
const DEFAULT_REMOTE_TEMP_ROOT = "C:/Windows/Temp";
const DEFAULT_WINDOWS_NODE_INSTALL_EXE = "C:/Users/Public/SystemSculpt/nodejs/node.exe";

function fail(message) {
  throw new Error(message);
}

function psSingleQuote(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function parseJsonObjectText(rawText, label) {
  const trimmed = String(rawText || "").trim();
  if (!trimmed) {
    fail(`${label} returned no data.`);
  }

  const candidateTexts = [trimmed];
  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidateTexts.push(trimmed.slice(objectStart, objectEnd + 1));
  }

  let lastError = null;
  for (const candidate of candidateTexts) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Failed to parse ${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

export function parseArgs(argv) {
  const options = {
    sshHost: String(process.env.SYSTEMSCULPT_WINDOWS_SSH_HOST || DEFAULT_WINDOWS_SSH_HOST).trim(),
    nodeExe:
      String(process.env.SYSTEMSCULPT_WINDOWS_NODE_EXE || "").trim() ||
      DEFAULT_WINDOWS_NODE_INSTALL_EXE,
    major: DEFAULT_NODE_MAJOR,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") {
      options.sshHost = String(argv[index + 1] || "").trim() || options.sshHost;
      index += 1;
      continue;
    }
    if (arg === "--node-exe") {
      options.nodeExe = String(argv[index + 1] || "").trim() || options.nodeExe;
      index += 1;
      continue;
    }
    if (arg === "--major") {
      const parsed = Number.parseInt(String(argv[index + 1] || ""), 10);
      if (!Number.isFinite(parsed) || parsed < 18) {
        fail(`Invalid value for --major: ${String(argv[index + 1] || "")}`);
      }
      options.major = parsed;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    fail(`Unknown argument: ${arg}`);
  }

  return options;
}

function usage() {
  console.log(`Usage: node testing/native/device/windows/install-windows-node.mjs [options]

Install or refresh a user-scoped Node.js runtime inside the Windows SSH host.

Options:
  --host <alias>       SSH host alias. Default: ${DEFAULT_WINDOWS_SSH_HOST}
  --node-exe <path>    Node install path inside Windows. Default: ${DEFAULT_WINDOWS_NODE_INSTALL_EXE}
  --major <n>          Node major line to install from nodejs.org. Default: ${DEFAULT_NODE_MAJOR}
`);
}

export function buildResolveNodeReleaseScript(options = {}) {
  const major = Math.max(18, Number(options.major) || DEFAULT_NODE_MAJOR);
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$major = ${major}`,
    "$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()",
    "switch ($arch) {",
    "  'arm64' { $nodeArch = 'arm64' }",
    "  'x64' { $nodeArch = 'x64' }",
    "  default { throw ('Unsupported Windows architecture for Node install: ' + $arch) }",
    "}",
    "$indexResponse = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json'",
    "$index = if ($indexResponse -is [array]) { $indexResponse } elseif ($indexResponse.value) { $indexResponse.value } else { $indexResponse }",
    "$zipFileTag = 'win-' + $nodeArch + '-zip'",
    "$release = $index | Where-Object {",
    "  $_.version -match ('^v' + $major + '\\.') -and $_.files -contains $zipFileTag",
    "} | Select-Object -First 1",
    "if (-not $release) { throw ('No Node.js release found for major ' + $major + ' and arch ' + $nodeArch) }",
    "[pscustomobject]@{",
    "  major = $major",
    "  arch = $nodeArch",
    "  releaseVersion = $release.version",
    "  zipFileTag = $zipFileTag",
    "} | ConvertTo-Json -Compress -Depth 5",
    "",
  ].join("\n");
}

export function buildDownloadNodeZipScript(state) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$downloadDir = ${psSingleQuote(state.downloadDir)}`,
    `$zipPath = ${psSingleQuote(state.zipPath)}`,
    `$downloadUrl = ${psSingleQuote(state.downloadUrl)}`,
    "New-Item -ItemType Directory -Path $downloadDir -Force | Out-Null",
    "& curl.exe -fsSL --output $zipPath $downloadUrl",
    "if ($LASTEXITCODE -ne 0) { throw ('Failed to download Node zip: ' + $downloadUrl) }",
    "$downloaded = Get-Item $zipPath",
    "[pscustomobject]@{",
    "  zipPath = $downloaded.FullName",
    "  bytes = [int64]$downloaded.Length",
    "} | ConvertTo-Json -Compress -Depth 5",
    "",
  ].join("\n");
}

export function buildInstallNodeZipScript(state) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$downloadDir = ${psSingleQuote(state.downloadDir)}`,
    `$zipPath = ${psSingleQuote(state.zipPath)}`,
    `$expandedRoot = ${psSingleQuote(state.expandedRoot)}`,
    `$installDir = ${psSingleQuote(state.installDir)}`,
    "if (!(Test-Path $zipPath)) { throw ('Missing downloaded Node zip: ' + $zipPath) }",
    "Expand-Archive -Path $zipPath -DestinationPath $downloadDir -Force",
    "if (!(Test-Path $expandedRoot)) { throw ('Expanded Node directory missing: ' + $expandedRoot) }",
    "if (Test-Path $installDir) { Remove-Item $installDir -Recurse -Force -ErrorAction SilentlyContinue }",
    "New-Item -ItemType Directory -Path $installDir -Force | Out-Null",
    "Copy-Item -Path (Join-Path $expandedRoot '*') -Destination $installDir -Recurse -Force",
    "[pscustomobject]@{",
    "  installDir = $installDir",
    "  expandedRoot = $expandedRoot",
    "} | ConvertTo-Json -Compress -Depth 5",
    "",
  ].join("\n");
}

export function buildFinalizeNodeInstallScript(state) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$installDir = ${psSingleQuote(state.installDir)}`,
    `$nodeExe = ${psSingleQuote(state.nodeExe)}`,
    `$downloadDir = ${psSingleQuote(state.downloadDir)}`,
    "if (!(Test-Path $nodeExe)) { throw ('Installed node.exe missing: ' + $nodeExe) }",
    "$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "$pathEntries = @()",
    "if ($userPath) {",
    "  $pathEntries = $userPath.Split(';') | Where-Object { $_ -and $_.Trim() }",
    "}",
    "$pathUpdated = $false",
    "if ($pathEntries -notcontains $installDir) {",
    "  [Environment]::SetEnvironmentVariable('Path', ((@($installDir) + $pathEntries) -join ';'), 'User')",
    "  $pathUpdated = $true",
    "}",
    "$version = (& $nodeExe --version).Trim()",
    "if (Test-Path $downloadDir) {",
    "  try {",
    "    Remove-Item $downloadDir -Recurse -Force -ErrorAction Stop",
    "  } catch {}",
    "}",
    "[pscustomobject]@{",
    "  ok = $true",
    "  version = $version",
    "  installDir = $installDir",
    "  nodeExe = $nodeExe",
    "  pathUpdated = $pathUpdated",
    "} | ConvertTo-Json -Compress -Depth 5",
    "",
  ].join("\n");
}

export function buildInstallNodeScript(options = {}) {
  const major = Math.max(18, Number(options.major) || DEFAULT_NODE_MAJOR);
  const nodeExe =
    String(options.nodeExe || DEFAULT_WINDOWS_NODE_INSTALL_EXE).trim() ||
    DEFAULT_WINDOWS_NODE_INSTALL_EXE;
  const installDir = path.posix.dirname(nodeExe).replace(/\\/g, "/");

  return [
    buildResolveNodeReleaseScript({ major }),
    "",
    `# installDir=${installDir}`,
    `# nodeExe=${nodeExe}`,
  ].join("\n");
}

async function runWindowsSshScript(script, options = {}) {
  return await runRemotePowerShellScript(script, {
    transport: "ssh",
    sshHost: options.sshHost || DEFAULT_WINDOWS_SSH_HOST,
    nodeExe: options.nodeExe || DEFAULT_WINDOWS_NODE_EXE,
  });
}

async function resolveReleaseState(options) {
  const resolved = parseJsonObjectText(
    await runWindowsSshScript(buildResolveNodeReleaseScript(options), options),
    "the Node release probe"
  );
  const releaseVersion = String(resolved.releaseVersion || "").trim();
  const arch = String(resolved.arch || "").trim();
  if (!releaseVersion || !arch) {
    fail("Node release probe returned incomplete metadata.");
  }

  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const downloadDir = `${DEFAULT_REMOTE_TEMP_ROOT}/systemsculpt-node-${nonce}`;
  const zipName = `node-${releaseVersion}-win-${arch}.zip`;
  const installDir = path.posix.dirname(options.nodeExe).replace(/\\/g, "/");

  return {
    major: Number(resolved.major) || options.major,
    arch,
    releaseVersion,
    zipName,
    downloadUrl: `https://nodejs.org/dist/${releaseVersion}/${zipName}`,
    downloadDir,
    zipPath: `${downloadDir}/${zipName}`,
    expandedRoot: `${downloadDir}/node-${releaseVersion}-win-${arch}`,
    installDir,
    nodeExe: options.nodeExe,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  console.error("[windows-install-node] resolving latest Node release");
  const releaseState = await resolveReleaseState(options);
  console.error(
    `[windows-install-node] downloading ${releaseState.releaseVersion} (${releaseState.arch})`
  );
  parseJsonObjectText(
    await runWindowsSshScript(buildDownloadNodeZipScript(releaseState), options),
    "the Node zip download"
  );

  console.error("[windows-install-node] extracting and installing Node");
  parseJsonObjectText(
    await runWindowsSshScript(buildInstallNodeZipScript(releaseState), options),
    "the Node install step"
  );

  console.error("[windows-install-node] finalizing PATH and verifying node.exe");
  const finalized = parseJsonObjectText(
    await runWindowsSshScript(buildFinalizeNodeInstallScript(releaseState), options),
    "the Node verification step"
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        ...finalized,
        arch: releaseState.arch,
        releaseVersion: releaseState.releaseVersion,
        downloadUrl: releaseState.downloadUrl,
      },
      null,
      2
    )}\n`
  );
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(
      `[windows-install-node] ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  });
}
