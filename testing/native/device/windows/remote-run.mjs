#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { build as buildWithEsbuild } from "esbuild";

import { assertProductionPluginArtifacts, REQUIRED_PLUGIN_ARTIFACTS } from "../../../../scripts/plugin-artifacts.mjs";

export const DEFAULT_WINDOWS_SSH_HOST = "tickblaze-kamatera";
export const DEFAULT_WINDOWS_REMOTE_TEMP_DIR = "C:/Windows/Temp";
export const DEFAULT_SSH_CONNECT_TIMEOUT_SECONDS = 10;
export const DEFAULT_SSH_SERVER_ALIVE_INTERVAL_SECONDS = 15;
export const DEFAULT_SSH_SERVER_ALIVE_COUNT_MAX = 120;
export const DEFAULT_SSH_MAX_BUFFER_BYTES = 1024 * 1024 * 24;

function fail(message) {
  throw new Error(message);
}

function outputText(result) {
  return [String(result.stdout || "").trim(), String(result.stderr || "").trim()]
    .filter(Boolean)
    .join("\n");
}

function psSingleQuote(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

export function toPowerShellArrayLiteral(values = []) {
  if (!Array.isArray(values) || values.length < 1) {
    return "@()";
  }
  return `@(${values.map((value) => psSingleQuote(value)).join(", ")})`;
}

export function buildRemoteWindowsNodeScript(options = {}) {
  const workspaceFiles = Array.isArray(options.workspaceFiles)
    ? options.workspaceFiles
        .map((entry) => ({
          relativePath: String(entry?.relativePath || "").trim(),
          sourceBase64: String(entry?.sourceBase64 || "").trim(),
        }))
        .filter((entry) => entry.relativePath && entry.sourceBase64)
    : [];
  if (workspaceFiles.length < 1) {
    fail("Missing Windows task workspace files.");
  }

  const entryRelativePath =
    String(options.entryRelativePath || workspaceFiles[0]?.relativePath || "").trim() ||
    workspaceFiles[0].relativePath;
  const cleanupPaths = Array.isArray(options.cleanupPaths) ? options.cleanupPaths : [];
  const args = Array.isArray(options.args) ? options.args : [];
  const workspaceFilesLiteral = [
    "@(",
    ...workspaceFiles.map(
      (file) =>
        `  [pscustomobject]@{ relativePath = ${psSingleQuote(file.relativePath)}; sourceBase64 = ${psSingleQuote(file.sourceBase64)} }`
    ),
    ")",
  ].join("\n");

  return [
    "$ErrorActionPreference = 'Stop'",
    "$workspacePath = Join-Path $env:TEMP ('ss-remote-' + [guid]::NewGuid().ToString())",
    `$scriptArgs = ${toPowerShellArrayLiteral(args)}`,
    `$cleanupPaths = ${toPowerShellArrayLiteral(cleanupPaths)}`,
    `$workspaceFiles = ${workspaceFilesLiteral}`,
    "New-Item -ItemType Directory -Path $workspacePath -Force | Out-Null",
    "foreach ($workspaceFile in $workspaceFiles) {",
    "  $targetPath = Join-Path $workspacePath $workspaceFile.relativePath",
    "  $targetDir = Split-Path -Parent $targetPath",
    "  if ($targetDir -and !(Test-Path $targetDir)) {",
    "    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null",
    "  }",
    "  [System.IO.File]::WriteAllText(",
    "    $targetPath,",
    "    [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($workspaceFile.sourceBase64)),",
    "    [System.Text.UTF8Encoding]::new($false)",
    "  )",
    "}",
    `$scriptPath = Join-Path $workspacePath ${psSingleQuote(entryRelativePath)}`,
    "$exitCode = 0",
    "Push-Location $workspacePath",
    "try {",
    "  node $scriptPath @scriptArgs",
    "  $exitCode = $LASTEXITCODE",
    "} finally {",
    "  Pop-Location",
    "}",
    "if (Test-Path $workspacePath) { Remove-Item $workspacePath -Recurse -Force -ErrorAction SilentlyContinue }",
    "foreach ($cleanupPath in $cleanupPaths) {",
    "  if ($cleanupPath -and (Test-Path $cleanupPath)) {",
    "    Remove-Item $cleanupPath -Force -ErrorAction SilentlyContinue",
    "  }",
    "}",
    "exit $exitCode",
    "",
  ].join("\n");
}

export function buildSshOptionArgs(options = {}) {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${Math.max(1, Number(options.connectTimeoutSeconds) || DEFAULT_SSH_CONNECT_TIMEOUT_SECONDS)}`,
    "-o",
    `ServerAliveInterval=${Math.max(
      1,
      Number(options.serverAliveIntervalSeconds) || DEFAULT_SSH_SERVER_ALIVE_INTERVAL_SECONDS
    )}`,
    "-o",
    `ServerAliveCountMax=${Math.max(
      1,
      Number(options.serverAliveCountMax) || DEFAULT_SSH_SERVER_ALIVE_COUNT_MAX
    )}`,
  ];
}

export async function findOpenLocalPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

export async function waitForForwardedPort(localPort, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const connected = await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port: localPort });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });

    if (connected) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  fail(`Timed out waiting for the Windows bridge port-forward on localhost:${localPort}.`);
}

export async function stopChildProcess(child) {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }

  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);

  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      new Promise((resolve) => child.once("exit", () => resolve(true))),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
}

export async function startSshLocalPortForward(options = {}) {
  const remotePort = Number(options.remotePort);
  if (!Number.isFinite(remotePort) || remotePort <= 0) {
    fail(`Invalid remote port for SSH port-forward: ${String(options.remotePort)}`);
  }

  const localPort = Number.isFinite(Number(options.localPort))
    ? Number(options.localPort)
    : await findOpenLocalPort();
  const remoteHost = String(options.remoteHost || "127.0.0.1").trim() || "127.0.0.1";
  const sshHost = String(options.sshHost || DEFAULT_WINDOWS_SSH_HOST).trim() || DEFAULT_WINDOWS_SSH_HOST;
  const sshArgs = [
    "-N",
    "-T",
    "-o",
    "ExitOnForwardFailure=yes",
    ...buildSshOptionArgs(options),
    "-L",
    `${localPort}:${remoteHost}:${remotePort}`,
    sshHost,
  ];
  const sshProcess = spawn("ssh", sshArgs, {
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderr = "";
  sshProcess.stderr?.setEncoding("utf8");
  sshProcess.stderr?.on("data", (chunk) => {
    stderr += String(chunk || "");
  });

  const exitBeforeReady = new Promise((_, reject) => {
    sshProcess.once("exit", (code, signal) => {
      reject(
        new Error(
          stderr.trim() ||
            `Windows SSH port-forward exited before it became ready (code=${code ?? "null"}, signal=${signal ?? "null"}).`
        )
      );
    });
  });

  try {
    await Promise.race([
      waitForForwardedPort(localPort, Number(options.timeoutMs) || 15_000),
      exitBeforeReady,
    ]);
  } catch (error) {
    await stopChildProcess(sshProcess);
    throw error;
  }

  return {
    process: sshProcess,
    localPort,
    remoteHost,
    remotePort,
    sshHost,
    getStderr: () => stderr.trim(),
  };
}

export function buildRemotePowerShellInvocation(options = {}) {
  const command = String(options.command || "").trim();
  if (!command) {
    fail("Missing remote PowerShell command.");
  }

  return [
    "-T",
    ...buildSshOptionArgs(options),
    String(options.sshHost || DEFAULT_WINDOWS_SSH_HOST).trim() || DEFAULT_WINDOWS_SSH_HOST,
    command,
  ];
}

async function copyLocalFileToWindowsPath(localPath, remotePath, options = {}) {
  const result = spawnSync(
    "scp",
    [
      "-q",
      ...buildSshOptionArgs(options),
      localPath,
      `${String(options.sshHost || DEFAULT_WINDOWS_SSH_HOST).trim() || DEFAULT_WINDOWS_SSH_HOST}:${remotePath}`,
    ],
    {
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: Math.max(1024 * 1024, Number(options.maxBufferBytes) || DEFAULT_SSH_MAX_BUFFER_BYTES),
    }
  );

  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    fail(outputText(result) || "Failed to copy a file to the Windows host.");
  }
}

export async function runRemotePowerShellScript(script, options = {}) {
  const remoteScript = String(script || "");
  if (!remoteScript.trim()) {
    fail("Missing remote PowerShell script.");
  }

  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const prefix = String(options.fileNamePrefix || "ss-remote-ps").trim() || "ss-remote-ps";
  const localPath = path.join(os.tmpdir(), `${prefix}-${nonce}.ps1`);
  const remoteTempDir =
    String(options.remoteTempDir || DEFAULT_WINDOWS_REMOTE_TEMP_DIR).trim() ||
    DEFAULT_WINDOWS_REMOTE_TEMP_DIR;
  const remotePath = `${remoteTempDir.replace(/[\\/]+$/g, "")}/${prefix}-${nonce}.ps1`;
  const remotePathLiteral = psSingleQuote(remotePath);
  const remoteCommand = [
    "powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command",
    psSingleQuote(
      `$exitCode = 0; try { & ${remotePathLiteral}; $exitCode = $LASTEXITCODE } finally { if (Test-Path ${remotePathLiteral}) { Remove-Item ${remotePathLiteral} -Force -ErrorAction SilentlyContinue } }; exit $exitCode`
    ),
  ].join(" ");

  await fs.writeFile(localPath, remoteScript, "utf8");

  try {
    await copyLocalFileToWindowsPath(localPath, remotePath, options);

    const result = spawnSync("ssh", buildRemotePowerShellInvocation({ ...options, command: remoteCommand }), {
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: Math.max(1024 * 1024, Number(options.maxBufferBytes) || DEFAULT_SSH_MAX_BUFFER_BYTES),
    });

    if (result.error) {
      throw result.error;
    }
    if ((result.status ?? 1) !== 0) {
      fail(outputText(result) || `Windows SSH command failed with exit code ${result.status ?? "unknown"}.`);
    }

    return String(result.stdout || "");
  } finally {
    await fs.rm(localPath, { force: true }).catch(() => {});
  }
}

export async function copySecretToWindowsTempFile(value, options = {}) {
  const secretValue = String(value || "");
  if (!secretValue.trim()) {
    fail("Missing secret value for Windows temp-file copy.");
  }

  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const prefix = String(options.fileNamePrefix || "ss-secret").trim() || "ss-secret";
  const localPath = path.join(os.tmpdir(), `${prefix}-${nonce}.txt`);
  const remoteTempDir =
    String(options.remoteTempDir || DEFAULT_WINDOWS_REMOTE_TEMP_DIR).trim() ||
    DEFAULT_WINDOWS_REMOTE_TEMP_DIR;
  const remotePath = `${remoteTempDir.replace(/[\\/]+$/g, "")}/${prefix}-${nonce}.txt`;

  await fs.writeFile(localPath, secretValue, "utf8");

  try {
    const result = spawnSync(
      "scp",
      [
        "-q",
        ...buildSshOptionArgs(options),
        localPath,
        `${String(options.sshHost || DEFAULT_WINDOWS_SSH_HOST).trim() || DEFAULT_WINDOWS_SSH_HOST}:${remotePath}`,
      ],
      {
        encoding: "utf8",
        stdio: "pipe",
        maxBuffer: Math.max(1024 * 1024, Number(options.maxBufferBytes) || DEFAULT_SSH_MAX_BUFFER_BYTES),
      }
    );

    if (result.error) {
      throw result.error;
    }
    if ((result.status ?? 1) !== 0) {
      fail(outputText(result) || "Failed to copy a secret file to the Windows host.");
    }

    return remotePath;
  } finally {
    await fs.rm(localPath, { force: true }).catch(() => {});
  }
}

export async function buildWindowsNodeModuleWorkspace(entryPath, options = {}) {
  const resolvedEntryPath = path.resolve(String(entryPath || ""));
  if (!resolvedEntryPath) {
    fail("Missing Windows task entry path.");
  }

  const bundleResult = await buildWithEsbuild({
    entryPoints: [resolvedEntryPath],
    bundle: true,
    format: "esm",
    platform: "node",
    target: ["node20"],
    write: false,
    logLevel: "silent",
  });
  const bundledEntry = bundleResult.outputFiles?.[0];
  if (!bundledEntry) {
    fail(`Failed to bundle Windows task entry: ${resolvedEntryPath}`);
  }

  const artifactRoot = path.resolve(String(options.artifactRoot || process.cwd()));
  const pluginInspection = assertProductionPluginArtifacts({ root: artifactRoot });
  const workspaceFiles = await Promise.all(
    REQUIRED_PLUGIN_ARTIFACTS.map(async (fileName) => {
      const sourcePath = path.join(pluginInspection.root, fileName);
      const source = await fs.readFile(sourcePath, "utf8");
      return {
        relativePath: fileName,
        sourceBase64: Buffer.from(source, "utf8").toString("base64"),
      };
    })
  );
  workspaceFiles.unshift({
    relativePath: "entry.mjs",
    sourceBase64: Buffer.from(bundledEntry.text, "utf8").toString("base64"),
  });

  return {
    entryRelativePath: "entry.mjs",
    workspaceFiles,
    artifactRoot: pluginInspection.root,
  };
}

export async function runWindowsNodeModuleRemotely(entryPath, options = {}) {
  const workspace = await buildWindowsNodeModuleWorkspace(entryPath, options);
  const script = buildRemoteWindowsNodeScript({
    entryRelativePath: workspace.entryRelativePath,
    workspaceFiles: workspace.workspaceFiles,
    args: Array.isArray(options.args) ? options.args : [],
    cleanupPaths: Array.isArray(options.cleanupPaths) ? options.cleanupPaths : [],
  });

  return await runRemotePowerShellScript(script, options);
}

export function parseRemoteRunArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const options = {
    entryPath: "",
    sshHost: DEFAULT_WINDOWS_SSH_HOST,
    taskArgs: [],
  };

  let delimiterIndex = args.indexOf("--");
  if (delimiterIndex < 0) {
    delimiterIndex = args.length;
  } else {
    options.taskArgs = args.slice(delimiterIndex + 1);
  }

  for (let index = 0; index < delimiterIndex; index += 1) {
    const arg = args[index];
    if (arg === "--entry") {
      options.entryPath = path.resolve(String(args[index + 1] || ""));
      index += 1;
      continue;
    }
    if (arg === "--host") {
      options.sshHost = String(args[index + 1] || "").trim() || options.sshHost;
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
  console.log(`Usage: node testing/native/device/windows/remote-run.mjs --entry <path> [--host <alias>] -- [task args...]

Send a local JavaScript file to the Windows VM over SSH, execute it with the
remote Node runtime, and stream stdout back to this host.
`);
}

async function main() {
  const options = parseRemoteRunArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (!options.entryPath) {
    usage();
    fail("Missing --entry.");
  }
  const stdout = await runWindowsNodeModuleRemotely(options.entryPath, {
    sshHost: options.sshHost,
    args: options.taskArgs,
  });
  process.stdout.write(stdout);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`[windows-remote-run] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
