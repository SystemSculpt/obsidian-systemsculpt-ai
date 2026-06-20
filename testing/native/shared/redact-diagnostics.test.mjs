import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactSecrets, redactDiagnosticsDir } from "./redact-diagnostics.mjs";

test("redactSecrets redacts secret-keyed string values recursively", () => {
  const out = redactSecrets({
    licenseKey: "live-license-uuid",
    serverUrl: "https://secret-staging.example.com",
    licenseValid: true,
    settingsMode: "advanced",
    vaultInstanceId: "id-1",
    nested: { providerApiKey: "sk-xyz", bearerToken: "t0ken", note: "keep-me" },
    arr: [{ apiKey: "k1" }, { harmless: 2 }],
  });

  // Every secret-keyed string is scrubbed, at any depth.
  assert.equal(out.licenseKey, "[REDACTED]");
  assert.equal(out.serverUrl, "[REDACTED]");
  assert.equal(out.nested.providerApiKey, "[REDACTED]");
  assert.equal(out.nested.bearerToken, "[REDACTED]");
  assert.equal(out.arr[0].apiKey, "[REDACTED]");

  // Non-secret fields (incl. a boolean named with a secret-ish key) survive.
  assert.equal(out.licenseValid, true);
  assert.equal(out.settingsMode, "advanced");
  assert.equal(out.vaultInstanceId, "id-1");
  assert.equal(out.nested.note, "keep-me");
  assert.equal(out.arr[1].harmless, 2);
});

test("redactDiagnosticsDir scrubs every JSON under the diagnostics tree", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redact-diag-"));
  try {
    fs.mkdirSync(path.join(dir, "plugin-dir"), { recursive: true });
    fs.mkdirSync(path.join(dir, "bridge-discovery"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "plugin-dir", "data.json"),
      JSON.stringify({ licenseKey: "live", serverUrl: "https://s", settingsMode: "advanced" }),
    );
    fs.writeFileSync(
      path.join(dir, "bridge-discovery", "abc.json"),
      JSON.stringify({ pluginId: "systemsculpt-ai", port: 1234, token: "bearer-secret" }),
    );
    // A non-JSON file must be left untouched (not a credential carrier).
    fs.writeFileSync(path.join(dir, "obsidian.log"), "licenseKey not really here");

    const redacted = redactDiagnosticsDir(dir);
    assert.equal(redacted.length, 2);

    const data = JSON.parse(fs.readFileSync(path.join(dir, "plugin-dir", "data.json"), "utf8"));
    assert.equal(data.licenseKey, "[REDACTED]");
    assert.equal(data.serverUrl, "[REDACTED]");
    assert.equal(data.settingsMode, "advanced");

    const disc = JSON.parse(fs.readFileSync(path.join(dir, "bridge-discovery", "abc.json"), "utf8"));
    assert.equal(disc.token, "[REDACTED]");
    assert.equal(disc.pluginId, "systemsculpt-ai");
    assert.equal(disc.port, 1234);

    assert.equal(fs.readFileSync(path.join(dir, "obsidian.log"), "utf8"), "licenseKey not really here");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("redactDiagnosticsDir is a no-op for a missing directory", () => {
  assert.deepEqual(redactDiagnosticsDir(path.join(os.tmpdir(), "redact-missing-xyz-404")), []);
});
