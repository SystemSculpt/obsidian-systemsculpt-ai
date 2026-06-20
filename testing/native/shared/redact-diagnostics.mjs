import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Secret redaction for CI failure-diagnostics artifacts (issue: E2E lanes
 * uploaded the seeded license key inside data.json).
 *
 * GitHub log masking does NOT protect artifact file contents, so any secret we
 * copy into the diagnostics tree (the seeded plugin data.json license/serverUrl,
 * the bridge discovery bearer token) would be downloadable from the run's
 * artifacts. This module scrubs those before upload. Shared by every desktop
 * E2E lane (linux/macos/windows) so the redaction can never drift between them.
 */

// Keys whose string values are secrets or secret-derived. Broad on purpose:
// over-redacting a diagnostics dump is safe; missing one leaks a credential.
export const SECRET_KEY_PATTERN =
  /key|token|secret|license|password|url|server|host|endpoint|credential/i;

/** Recursively replace secret-keyed string values with "[REDACTED]" in place. */
export function redactSecrets(value) {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      value[key] =
        SECRET_KEY_PATTERN.test(key) && typeof value[key] === "string"
          ? "[REDACTED]"
          : redactSecrets(value[key]);
    }
  }
  return value;
}

function collectJsonFiles(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsonFiles(full, acc);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Redact every *.json under a diagnostics directory (best-effort). Returns the
 * list of files actually rewritten. Files that don't parse as JSON are skipped
 * untouched — they're never the secret vector (the seeded credentials live in
 * data.json / the bridge discovery JSON).
 */
const UNPARSEABLE_MARKER = {
  _redacted: "unparseable JSON replaced to avoid leaking unredacted secrets",
};

export function redactDiagnosticsDir(diagDir) {
  if (!diagDir || !fs.existsSync(diagDir)) {
    return [];
  }
  const redacted = [];
  for (const file of collectJsonFiles(diagDir, [])) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      // Fail closed: a *.json we can't read/parse might still contain secrets,
      // so we must never ship its raw contents. Replace it with a marker (or, if
      // that also fails, delete it) instead of leaving it in the artifact.
      try {
        fs.writeFileSync(file, JSON.stringify(UNPARSEABLE_MARKER, null, 2));
        redacted.push(file);
      } catch {
        try {
          fs.rmSync(file, { force: true });
          redacted.push(file);
        } catch {
          // Nothing more we can safely do; surface it rather than hide it.
          console.error("WARNING: could not redact or remove", file);
        }
      }
      continue;
    }
    try {
      fs.writeFileSync(file, JSON.stringify(redactSecrets(parsed), null, 2));
      redacted.push(file);
    } catch {
      // Couldn't write the redacted form — remove the original so the unredacted
      // file is never uploaded.
      try {
        fs.rmSync(file, { force: true });
        redacted.push(file);
      } catch {
        console.error("WARNING: could not redact or remove", file);
      }
    }
  }
  return redacted;
}

// CLI: `node redact-diagnostics.mjs <diagnostics-dir>` (used by the E2E lanes).
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: redact-diagnostics.mjs <diagnostics-dir>");
    process.exit(2);
  }
  for (const file of redactDiagnosticsDir(dir)) {
    console.log("Redacted secrets in", file);
  }
}
