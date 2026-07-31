#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  countConfiguredTargets,
  resolveSyncConfigPath,
} from "./plugin-sync.mjs";
import {
  LOCAL_AGENT_API_BASE_URL,
  STAGING_API_BASE_URL,
  normalizeApiBaseUrl,
} from "./plugin-build-options.mjs";

export const DEV_WATCHER_SERVICE_LABEL = "com.systemsculpt.obsidian-plugin-dev";

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

export function resolveDevWatcherServicePaths(options = {}) {
  const home = path.resolve(String(options.home || os.homedir()));
  const launchAgentsDir = path.join(home, "Library", "LaunchAgents");
  const logsDir = path.join(home, "Library", "Logs", "SystemSculpt");
  return {
    home,
    launchAgentsDir,
    logsDir,
    plistPath: path.join(launchAgentsDir, `${DEV_WATCHER_SERVICE_LABEL}.plist`),
    stdoutPath: path.join(logsDir, "obsidian-plugin-dev.log"),
    stderrPath: path.join(logsDir, "obsidian-plugin-dev.error.log"),
  };
}

export function createDevWatcherLaunchAgentPlist(options) {
  const root = path.resolve(String(options.root));
  const configPath = path.resolve(String(options.configPath));
  const paths = resolveDevWatcherServicePaths({ home: options.home });
  const executablePath = [
    path.dirname(process.execPath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter((value, index, values) => values.indexOf(value) === index).join(":");
  const apiBaseUrl = options.apiBaseUrl
    ? normalizeApiBaseUrl(options.apiBaseUrl)
    : null;
  const apiBaseEnvironment = apiBaseUrl
    ? `
    <key>SYSTEMSCULPT_API_BASE_URL</key>
    <string>${xml(apiBaseUrl)}</string>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(DEV_WATCHER_SERVICE_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${xml(path.join(root, "run.sh"))}</string>
    <string>--headless</string>
    <string>--sync-config</string>
    <string>${xml(configPath)}</string>
    <string>--</string>
    <string>production-watch</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(executablePath)}</string>
    ${apiBaseEnvironment}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>2</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(paths.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(paths.stderrPath)}</string>
</dict>
</plist>
`;
}

function atomicWrite(filePath, contents) {
  const tempPath = `${filePath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tempPath, contents, { mode: 0o644 });
    fs.renameSync(tempPath, filePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function checked(command, args, runCommand) {
  const result = runCommand(command, args, {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result?.error || result?.status !== 0) {
    const reason = result?.error?.message || result?.stderr || `exit ${result?.status}`;
    throw new Error(`${command} ${args.join(" ")} failed: ${String(reason).trim()}`);
  }
  return result;
}

function requireMac(platform) {
  if (platform !== "darwin") {
    throw new Error("The persistent development watcher currently requires macOS launchd.");
  }
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitForServiceToUnload(options) {
  const {
    serviceTarget,
    runCommand,
    sleep = sleepSync,
    timeoutMs = 5_000,
    pollIntervalMs = 50,
  } = options;
  const attempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = runCommand("launchctl", ["print", serviceTarget], {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (result?.error || result?.status !== 0) return;
    sleep(pollIntervalMs);
  }
  throw new Error(`launchctl did not unload ${serviceTarget} within ${timeoutMs}ms.`);
}

export function installDevWatcherService(options = {}) {
  const root = path.resolve(String(options.root || process.cwd()));
  const configPath = resolveSyncConfigPath(options.configPath);
  const home = path.resolve(String(options.home || os.homedir()));
  const platform = options.platform || process.platform;
  const uid = options.uid ?? process.getuid?.();
  const runCommand = options.runCommand || spawnSync;
  const sleep = options.sleep || sleepSync;
  requireMac(platform);
  if (!Number.isInteger(uid) || uid < 0) throw new Error("Unable to resolve the current macOS user.");
  if (!fs.existsSync(path.join(root, "run.sh"))) throw new Error(`run.sh is missing from ${root}.`);
  if (countConfiguredTargets({ root, configPath }) < 1) {
    throw new Error(`No plugin targets are configured in ${configPath}.`);
  }

  const paths = resolveDevWatcherServicePaths({ home });
  fs.mkdirSync(paths.launchAgentsDir, { recursive: true });
  fs.mkdirSync(paths.logsDir, { recursive: true });
  atomicWrite(paths.plistPath, createDevWatcherLaunchAgentPlist({
    root,
    configPath,
    home,
    apiBaseUrl: options.apiBaseUrl,
  }));

  const domain = `gui/${uid}`;
  const serviceTarget = `${domain}/${DEV_WATCHER_SERVICE_LABEL}`;
  runCommand("launchctl", ["bootout", serviceTarget], {
    encoding: "utf8",
    stdio: "pipe",
  });
  waitForServiceToUnload({
    serviceTarget,
    runCommand,
    sleep,
    timeoutMs: options.unloadTimeoutMs,
    pollIntervalMs: options.unloadPollIntervalMs,
  });
  checked("launchctl", ["bootstrap", domain, paths.plistPath], runCommand);
  checked("launchctl", ["kickstart", "-k", serviceTarget], runCommand);
  return {
    ...paths,
    root,
    configPath,
    domain,
    apiBaseUrl: options.apiBaseUrl ? normalizeApiBaseUrl(options.apiBaseUrl) : null,
  };
}

export function uninstallDevWatcherService(options = {}) {
  const home = path.resolve(String(options.home || os.homedir()));
  const platform = options.platform || process.platform;
  const uid = options.uid ?? process.getuid?.();
  const runCommand = options.runCommand || spawnSync;
  requireMac(platform);
  if (!Number.isInteger(uid) || uid < 0) throw new Error("Unable to resolve the current macOS user.");
  const paths = resolveDevWatcherServicePaths({ home });
  runCommand("launchctl", ["bootout", `gui/${uid}/${DEV_WATCHER_SERVICE_LABEL}`], {
    encoding: "utf8",
    stdio: "pipe",
  });
  fs.rmSync(paths.plistPath, { force: true });
  return paths;
}

export function inspectDevWatcherService(options = {}) {
  const platform = options.platform || process.platform;
  const uid = options.uid ?? process.getuid?.();
  const runCommand = options.runCommand || spawnSync;
  requireMac(platform);
  if (!Number.isInteger(uid) || uid < 0) throw new Error("Unable to resolve the current macOS user.");
  const result = runCommand(
    "launchctl",
    ["print", `gui/${uid}/${DEV_WATCHER_SERVICE_LABEL}`],
    { encoding: "utf8", stdio: "pipe" },
  );
  return {
    running: !result?.error && result?.status === 0,
    detail: String(result?.stdout || result?.stderr || "").trim(),
  };
}

function parseArgs(argv) {
  const command = argv[0];
  let configPath;
  let target = "production";
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === "--config" && argv[index + 1]) {
      configPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (argv[index] === "--target" && argv[index + 1]) {
      target = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!["production", "staging", "local-agent"].includes(target)) {
    throw new Error(`Unknown plugin watcher target: ${target}`);
  }
  if (!["install", "uninstall", "status"].includes(command)) {
    throw new Error("Usage: node scripts/dev-watcher-service.mjs <install|uninstall|status> [--config <path>] [--target production|staging|local-agent]");
  }
  return { command, configPath, target };
}

async function main() {
  const { command, configPath, target } = parseArgs(process.argv.slice(2));
  if (command === "install") {
    const result = installDevWatcherService({
      configPath,
      apiBaseUrl: target === "staging"
        ? STAGING_API_BASE_URL
        : target === "local-agent"
          ? LOCAL_AGENT_API_BASE_URL
          : undefined,
    });
    console.log(`[dev] Persistent watcher installed from ${result.root}.`);
    console.log(`[dev] API target: ${target}.`);
    console.log(`[dev] Sync config: ${result.configPath}`);
    console.log(`[dev] Log: ${result.stdoutPath}`);
    return;
  }
  if (command === "uninstall") {
    uninstallDevWatcherService();
    console.log("[dev] Persistent watcher removed.");
    return;
  }
  const status = inspectDevWatcherService();
  console.log(status.running ? "[dev] Persistent watcher is running." : "[dev] Persistent watcher is not running.");
  if (!status.running) process.exitCode = 1;
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
