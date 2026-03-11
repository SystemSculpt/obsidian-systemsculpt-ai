#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";

function fail(message) {
  console.error(`[ios-appium] ${message}`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    const stdout = String(result.stdout || "").trim();
    const details = stderr || stdout || `exit ${result.status}`;
    throw new Error(`${command} ${args.join(" ")} failed: ${details}`);
  }

  return String(result.stdout || "").trim();
}

function main() {
  let appiumPrefix;
  try {
    appiumPrefix = run("brew", ["--prefix", "appium"]);
  } catch (error) {
    fail(`Homebrew Appium is not available: ${error instanceof Error ? error.message : String(error)}`);
  }

  const resolvedNodePath = path.join(appiumPrefix, "libexec", "lib", "node_modules");
  const existingNodePath = String(process.env.NODE_PATH || "").trim();
  const nodePath = existingNodePath
    ? `${resolvedNodePath}${path.delimiter}${existingNodePath}`
    : resolvedNodePath;

  let signingIdentities = "";
  try {
    signingIdentities = run("security", ["find-identity", "-v", "-p", "codesigning"]);
  } catch (error) {
    console.warn(`[ios-appium] Could not inspect code-signing identities: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (/0 valid identities found/i.test(signingIdentities)) {
    console.warn("[ios-appium] No valid code-signing identities are configured on this Mac. Appium can start, but real-device WebDriverAgent sessions will fail until Xcode has a Development Team set up.");
  }

  console.log(`[ios-appium] Using NODE_PATH=${resolvedNodePath}`);
  console.log("[ios-appium] Starting Appium with the Homebrew module-resolution fix applied.");

  const child = spawn("appium", process.argv.slice(2), {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_PATH: nodePath,
    },
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main();
