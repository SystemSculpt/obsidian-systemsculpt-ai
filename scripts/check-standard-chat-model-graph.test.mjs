import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeStandardChatModelGraph } from "./check-standard-chat-model-graph.mjs";

async function fixture(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "standard-chat-graph-"));
  for (const [relative, source] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source);
  }
  return root;
}

test("rejects a static provider-runtime import with its exact path", async () => {
  const root = await fixture({
    "root.ts": 'import "./services/providerRuntime/ProviderRuntime";\n',
    "services/providerRuntime/ProviderRuntime.ts": "export {};\n",
  });
  try {
    const report = analyzeStandardChatModelGraph({ projectRoot: root, moduleRoots: ["root.ts"], methodRoots: [] });
    assert.equal(report.ok, false);
    assert.match(report.findings[0].path.join(" -> "), /root\.ts.*ProviderRuntime/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects dynamic Pi imports and forbidden modelService member reads", async () => {
  const root = await fixture({
    "root.ts": 'export async function run(plugin: object) { await import("./services/pi-native/Auth"); return plugin.modelService.getModels(); }\n',
    "services/pi-native/Auth.ts": "export {};\n",
  });
  try {
    const report = analyzeStandardChatModelGraph({ projectRoot: root, moduleRoots: ["root.ts"], methodRoots: [{ file: "root.ts", names: ["run"] }] });
    assert.equal(report.ok, false);
    assert.ok(report.findings.some((finding) => finding.reason.includes("pi-native")));
    assert.ok(report.findings.some((finding) => finding.reason.includes("modelService")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects legacy entitlement authority imports and member reads", async () => {
  const root = await fixture({
    "root.ts": 'import "./services/entitlement/EntitlementService"; export function run(plugin: object) { return plugin.getEntitlementService().canUseChat(); }\n',
    "services/entitlement/EntitlementService.ts": "export {};\n",
  });
  try {
    const report = analyzeStandardChatModelGraph({ projectRoot: root, moduleRoots: ["root.ts"], methodRoots: [] });
    assert.equal(report.ok, false);
    assert.ok(report.findings.some((finding) => finding.reason.includes("services/entitlement")));
    assert.ok(report.findings.some((finding) => finding.reason.includes("getEntitlementService")));
    assert.ok(report.findings.some((finding) => finding.reason.includes("canUseChat")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fails closed on an unresolved relative import", async () => {
  const root = await fixture({ "root.ts": 'import "./missing";\n' });
  try {
    const report = analyzeStandardChatModelGraph({ projectRoot: root, moduleRoots: ["root.ts"], methodRoots: [] });
    assert.equal(report.ok, false);
    assert.match(report.findings[0].reason, /unresolved import/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("accepts the managed identity/account seam", async () => {
  const root = await fixture({
    "root.ts": 'import { account } from "./account"; export function run() { return account(); }\n',
    "account.ts": 'export const account = () => "SystemSculpt";\n',
  });
  try {
    const report = analyzeStandardChatModelGraph({ projectRoot: root, moduleRoots: ["root.ts"], methodRoots: [{ file: "root.ts", names: ["run"] }] });
    assert.deepEqual(report, { ok: true, findings: [] });
  } finally { await rm(root, { recursive: true, force: true }); }
});
