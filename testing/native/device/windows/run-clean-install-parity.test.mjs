import test from "node:test";
import assert from "node:assert/strict";
import {
  assertNoLocalPiInstalled,
  buildWindowsLocalPiStatusScript,
  buildLatestWindowsBridgeRecordScript,
  parseArgs,
  parseWindowsBridgeRecord,
  parseWindowsLocalPiStatus,
  resolveKnownProviderEnvCandidates,
  resolveProviderApiKey,
} from "./run-clean-install-parity.mjs";

test("parseArgs accepts Windows host and provider auth options", () => {
  const parsed = parseArgs([
    "--host",
    "custom-windows-host",
    "--provider-id",
    "google",
    "--api-key-env",
    "GEMINI_API_KEY",
    "--require-provider",
  ]);

  assert.equal(parsed.sshHost, "custom-windows-host");
  assert.equal(parsed.providerId, "google");
  assert.equal(parsed.apiKeyEnv, "GEMINI_API_KEY");
  assert.equal(parsed.requireProvider, true);
});

test("resolveKnownProviderEnvCandidates returns the canonical provider env vars", () => {
  assert.deepEqual(resolveKnownProviderEnvCandidates("google"), [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
  ]);
});

test("resolveProviderApiKey prefers direct value, explicit env, shared env, mapping, then provider defaults", () => {
  assert.equal(
    resolveProviderApiKey(
      { providerId: "google", apiKey: "direct-value" },
      { GEMINI_API_KEY: "provider-default" }
    ),
    "direct-value"
  );

  assert.equal(
    resolveProviderApiKey(
      { providerId: "google", apiKeyEnv: "MY_PROVIDER_KEY" },
      { MY_PROVIDER_KEY: "explicit-env", GEMINI_API_KEY: "provider-default" }
    ),
    "explicit-env"
  );

  assert.equal(
    resolveProviderApiKey(
      { providerId: "google" },
      { SYSTEMSCULPT_DESKTOP_PROVIDER_API_KEY: "shared-direct" }
    ),
    "shared-direct"
  );

  assert.equal(
    resolveProviderApiKey(
      { providerId: "google" },
      { SYSTEMSCULPT_DESKTOP_PROVIDER_API_KEYS: JSON.stringify({ google: "mapped-value" }) }
    ),
    "mapped-value"
  );

  assert.equal(
    resolveProviderApiKey(
      { providerId: "google" },
      { GEMINI_API_KEY: "provider-default" }
    ),
    "provider-default"
  );
});

test("buildLatestWindowsBridgeRecordScript fetches the newest SystemSculpt bridge record", () => {
  const script = buildLatestWindowsBridgeRecordScript();

  assert.match(script, /obsidian-automation/);
  assert.match(script, /pluginId -eq 'systemsculpt-ai'/);
  assert.match(script, /Sort-Object startedAt -Descending/);
  assert.match(script, /ConvertTo-Json -Compress/);
});

test("buildWindowsLocalPiStatusScript probes the Windows host for local Pi install markers", () => {
  const script = buildWindowsLocalPiStatusScript();

  assert.match(script, /Get-Command pi/);
  assert.match(script, /\.pi\/models\.json|\.pi\\models\.json/);
  assert.match(script, /ConvertTo-Json -Compress/);
});

test("parseWindowsBridgeRecord validates the forwarded bridge contract", () => {
  const record = parseWindowsBridgeRecord(
    JSON.stringify({
      host: "127.0.0.1",
      port: 58852,
      token: "secret",
      startedAt: "2026-03-29T08:59:35.908Z",
    })
  );

  assert.equal(record.port, 58852);
  assert.equal(record.token, "secret");
});

test("parseWindowsBridgeRecord tolerates prompt noise around the JSON payload", () => {
  const noisyRecord = parseWindowsBridgeRecord(`PS C:\\Users\\Administrator> $record | ConvertTo-Json -Compress
{"host":"127.0.0.1","port":58852,"token":"secret","startedAt":"2026-03-29T08:59:35.908Z"}
PS C:\\Users\\Administrator>`);

  assert.equal(noisyRecord.port, 58852);
  assert.equal(noisyRecord.token, "secret");
});

test("parseWindowsLocalPiStatus tolerates prompt noise around the JSON payload", () => {
  const status = parseWindowsLocalPiStatus(`PS C:\\Users\\Administrator> $probe | ConvertTo-Json -Compress
{"piCommandPath":null,"modelsFileExists":false,"authFileExists":true}
PS C:\\Users\\Administrator>`);

  assert.deepEqual(status, {
    piCommandPath: null,
    modelsFileExists: false,
    authFileExists: true,
  });
});

test("assertNoLocalPiInstalled allows auth.json but rejects a pi command or models.json", () => {
  assert.deepEqual(
    assertNoLocalPiInstalled({
      piCommandPath: null,
      modelsFileExists: false,
      authFileExists: true,
    }),
    {
      piCommandPath: null,
      modelsFileExists: false,
      authFileExists: true,
    }
  );

  assert.throws(
    () =>
      assertNoLocalPiInstalled({
        piCommandPath: "C:\\Users\\Administrator\\AppData\\Roaming\\npm\\pi.cmd",
        modelsFileExists: false,
        authFileExists: false,
      }),
    /no local Pi install/i
  );
  assert.throws(
    () =>
      assertNoLocalPiInstalled({
        piCommandPath: null,
        modelsFileExists: true,
        authFileExists: false,
      }),
    /models\.json/i
  );
});

test("parseWindowsBridgeRecord rejects incomplete records", () => {
  assert.throws(() => parseWindowsBridgeRecord("{}"), /token/i);
  assert.throws(
    () => parseWindowsBridgeRecord(JSON.stringify({ token: "secret", port: 0 })),
    /valid port/i
  );
});
