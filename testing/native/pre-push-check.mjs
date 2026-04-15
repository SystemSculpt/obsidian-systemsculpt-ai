#!/usr/bin/env node
/**
 * Pre-push native testing gate.
 *
 * Runs unit tests, builds the plugin, and optionally runs Android emulator
 * and Windows smoke tests. Exit code 0 = safe to push.
 *
 * Usage:
 *   node testing/native/pre-push-check.mjs [--skip-android] [--skip-windows] [--skip-unit]
 */
import { execFileSync, spawnSync } from "node:child_process";
import process from "node:process";

const args = new Set(process.argv.slice(2));
const skipUnit = args.has("--skip-unit");
const skipAndroid = args.has("--skip-android");
const skipWindows = args.has("--skip-windows");

const results = [];

function log(msg) {
  console.log(`\n[pre-push] ${msg}`);
}

function step(name, fn) {
  log(`Running: ${name}`);
  const start = Date.now();
  try {
    fn();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    results.push({ name, status: "PASS", elapsed });
    log(`  PASS (${elapsed}s)`);
    return true;
  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    results.push({ name, status: "FAIL", elapsed, error: err.message });
    log(`  FAIL (${elapsed}s): ${err.message?.substring(0, 200)}`);
    return false;
  }
}

function npm(...cmdArgs) {
  const result = spawnSync("npm", ["run", ...cmdArgs], {
    stdio: "pipe",
    encoding: "utf8",
    timeout: 300000,
    cwd: process.cwd(),
  });
  if (result.status !== 0) {
    const output = (result.stderr || result.stdout || "").trim();
    throw new Error(output.split("\n").slice(-5).join("\n"));
  }
  return result.stdout;
}

function hasAndroidDevice() {
  try {
    const out = execFileSync("adb", ["devices"], { encoding: "utf8", timeout: 5000 });
    return out.includes("device") && !out.trim().endsWith("List of devices attached");
  } catch {
    return false;
  }
}

function hasWindowsSSH() {
  const host = String(process.env.SYSTEMSCULPT_WINDOWS_SSH_HOST || "").trim();
  if (!host) {
    return false;
  }
  try {
    execFileSync("ssh", ["-o", "ConnectTimeout=3", host, "echo ok"], {
      encoding: "utf8",
      timeout: 10000,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

// ── Unit tests ──
if (!skipUnit) {
  step("Unit tests", () => npm("test"));
}

// ── Build ──
step("Build plugin", () => npm("build"));

// ── Android smoke ──
if (!skipAndroid) {
  if (hasAndroidDevice()) {
    step("Android: sync plugin", () =>
      npm("test:native:android:debug:open", "--", "--config", "./systemsculpt-sync.android.json", "--headless", "--sync", "--reset-vault", "--skip-open-apps")
    );

    step("Android: accept trust", () => {
      const result = spawnSync("node", ["testing/native/device/android/accept-trust.mjs"], {
        stdio: "pipe",
        encoding: "utf8",
        timeout: 45000,
      });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    });

    step("Android: smoke tests", () => npm("test:native:android"));
  } else {
    log("SKIP: No Android device/emulator connected");
    results.push({ name: "Android smoke tests", status: "SKIP", elapsed: "0" });
  }
}

// ── Windows smoke ──
if (!skipWindows) {
  if (hasWindowsSSH()) {
    step("Windows: desktop baselines", () => npm("test:native:windows:baselines"));
  } else {
    log("SKIP: Windows SSH host not configured or not reachable");
    results.push({ name: "Windows desktop baselines", status: "SKIP", elapsed: "0" });
  }
}

// ── Summary ──
log("─── Results ───");
const maxName = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  const status = r.status === "PASS" ? "✓" : r.status === "FAIL" ? "✗" : "○";
  console.log(`  ${status} ${r.name.padEnd(maxName)}  ${r.elapsed}s`);
}

const failed = results.filter((r) => r.status === "FAIL");
if (failed.length > 0) {
  log(`${failed.length} check(s) FAILED. Push blocked.`);
  process.exit(1);
} else {
  log("All checks passed. Safe to push.");
}
