import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { defaultDispositionLedgerPath, generateInventory, generateVerificationV2, generateVerificationV3, generateDispositionTransitions, semanticTree, validateDispositionState, verifyCurrent, verifyVerificationV2, verifyVerificationV3, verifyDispositionLedger } from './network-egress-inventory.mjs';
import { createPluginBuildOptions } from './plugin-build-options.mjs';

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-test-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  for (const [name, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), body); }
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: root });
  return root;
}
const writeFixture = (root, value) => { const file = path.join(root, 'fixture.json'); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); return file; };
const writeEmptyDispositionLedger = root => {
  const reviewed = JSON.parse(fs.readFileSync(path.join(root, 'testing/fixtures/managed/egress-dispositions-v1-660e7fe.json'), 'utf8'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-empty-disposition-'));
  const file = path.join(directory, 'egress-dispositions-v1-660e7fe.json');
  fs.writeFileSync(file, JSON.stringify({ ...reviewed, transitions: [] }, null, 2) + '\n');
  return file;
};

test('baseline reads committed blobs while current reads staged, unstaged, untracked, and omits deleted files', () => {
  const root = repo({ 'src/a.ts': 'export const a = () => fetch("https://old.invalid");\n', 'src/deleted.ts': 'new WebSocket("ws://old.invalid");\n' });
  const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const a = () => fetch("https://staged.invalid");\n');
  execFileSync('git', ['add', 'src/a.ts'], { cwd: root });
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const a = () => { fetch("https://staged.invalid"); fetch("https://unstaged.invalid"); };\n');
  fs.unlinkSync(path.join(root, 'src/deleted.ts'));
  fs.writeFileSync(path.join(root, 'src/new.ts'), 'const f = fetch; f("https://untracked.invalid");\n');
  const inventory = generateInventory({ root, ref });
  assert.ok(inventory.records.some(r => r.origin === 'baseline' && r.path === 'src/deleted.ts' && r.currentStatus === 'present' && r.evidence.states.length === 1 && r.evidence.states[0] === 'index'));
  assert.ok(inventory.records.some(r => r.origin === 'reviewed_current_addition' && r.path === 'src/new.ts'));
  assert.ok(inventory.records.filter(r => r.path === 'src/a.ts' && r.currentStatus === 'present').length >= 2);
});

test('analyzes staged index and worktree blobs independently in both directions', () => {
  const root = repo({ 'src/a.ts': 'export const value = 1;\n' });
  const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const cleanFixture = writeFixture(root, generateInventory({ root, ref }));

  fs.writeFileSync(path.join(root, 'src/a.ts'), 'fetch("https://staged-only.invalid");\n');
  execFileSync('git', ['add', 'src/a.ts'], { cwd: root });
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const value = 1;\n');
  assert.throws(() => verifyCurrent({ root, fixture: cleanFixture }), /index.*unreviewed|unreviewed.*index/);
  const stagedInventory = generateInventory({ root, ref });
  const staged = stagedInventory.records.find(r => r.primitiveOrImport === 'fetch');
  assert.deepEqual(staged?.evidence.states, ['index']);

  execFileSync('git', ['reset', '-q', 'HEAD', '--', 'src/a.ts'], { cwd: root });
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'fetch("https://worktree-only.invalid");\n');
  assert.throws(() => verifyCurrent({ root, fixture: cleanFixture }), /worktree.*unreviewed|unreviewed.*worktree/);
  const worktreeInventory = generateInventory({ root, ref });
  const worktree = worktreeInventory.records.find(r => r.primitiveOrImport === 'fetch');
  assert.deepEqual(worktree?.evidence.states, ['worktree']);
});

test('preserves duplicate occurrence cardinality while allowing pure line movement', () => {
  const root = repo({ 'src/a.ts': 'fetch("https://same.invalid");\n' });
  const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const fixture = writeFixture(root, generateInventory({ root, ref }));

  fs.writeFileSync(path.join(root, 'src/a.ts'), '\n\nfetch("https://same.invalid");\n');
  assert.doesNotThrow(() => verifyCurrent({ root, fixture }));

  fs.writeFileSync(path.join(root, 'src/a.ts'), 'fetch("https://same.invalid");\nfetch("https://same.invalid");\n');
  assert.throws(() => verifyCurrent({ root, fixture }), /occurrence|unreviewed/);

  execFileSync('git', ['add', 'src/a.ts'], { cwd: root });
  const duplicateFixture = writeFixture(root, generateInventory({ root, ref }));
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'fetch("https://same.invalid");\n');
  execFileSync('git', ['add', 'src/a.ts'], { cwd: root });
  assert.throws(() => verifyCurrent({ root, fixture: duplicateFixture }), /occurrence|stale/);
});

test('detects aliases, computed node properties, constructors, SDK imports, wrappers, and URL dataflow', () => {
  const root = repo({ 'src/a.ts': `
import { requestUrl as rq } from "obsidian";
import * as https from "node:https";
import OpenAI from "openai";
const f = fetch;
export function run(host: string) {
  const url = new URL("/v1", host);
  f(url.toString()); rq({url: url.toString()}); https["get"](url);
  new WebSocket("wss://example.invalid"); new XMLHttpRequest(); new OpenAI();
}
` });
  const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const records = generateInventory({ root, ref }).records;
  for (const primitive of ['fetch', 'obsidian.requestUrl', 'node:https.get', 'WebSocket', 'XMLHttpRequest', 'openai']) assert.ok(records.some(r => r.primitiveOrImport.includes(primitive)), primitive);
  assert.ok(records.some(r => r.classification === 'wrapper_boundary'));
});

test('excludes tests, declarations, generated roots, ignored files, type-only imports, and standalone URLs', () => {
  const root = repo({ 'src/clean.ts': 'import type OpenAI from "openai"; const u = new URL("https://data.invalid");\n', 'src/x.test.ts': 'fetch("https://test.invalid");\n', 'src/types.d.ts': 'declare const fetch: unknown;\n', 'src/generated/x.ts': 'fetch("https://generated.invalid");\n', '.gitignore': 'src/ignored.ts\n' });
  fs.writeFileSync(path.join(root, 'src/ignored.ts'), 'fetch("https://ignored.invalid");\n');
  const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(generateInventory({ root, ref }).records.length, 0);
});

test('verification rejects unreviewed, stale, ownerless, wildcard, and extra approved-core records', () => {
  const root = repo({ 'src/a.ts': 'fetch("https://example.invalid");\n' });
  const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const inventory = generateInventory({ root, ref });
  const fixture = writeFixture(root, inventory);
  assert.doesNotThrow(() => verifyCurrent({ root, fixture }));
  fs.writeFileSync(path.join(root, 'src/new.ts'), 'new WebSocket("wss://new.invalid");\n');
  assert.throws(() => verifyCurrent({ root, fixture }), /unreviewed live primitive/);
  fs.unlinkSync(path.join(root, 'src/new.ts'));
  const broken = structuredClone(inventory);
  broken.records[0].ownerPlan = '';
  broken.records[0].path = 'src/**';
  broken.records.push({ ...broken.records[0], id: 'extra', path: 'src/Other.ts', origin: 'reviewed_current_addition', baselineDisposition: 'approved_core', classification: 'outbound_sink', currentStatus: 'present' });
  const brokenFixture = writeFixture(root, broken);
  assert.throws(() => verifyCurrent({ root, fixture: brokenFixture }), /wildcard|invalid owner|approved_core/);
});

test('pure build options preserve the production contract without touching artifacts', () => {
  const sentinel = fs.mkdtempSync(path.join(os.tmpdir(), 'build-options-'));
  const before = fs.readdirSync(sentinel);
  const options = createPluginBuildOptions({ buildStamp: 'fixed' });
  assert.deepEqual(options.entryPoints, ['src/main.ts']);
  assert.equal(options.outfile, 'main.js');
  assert.equal(options.write, true);
  assert.equal(options.format, 'cjs');
  assert.equal(options.sourcemap, false);
  assert.equal(options.treeShaking, false);
  assert.equal(options.define.__SS_BUILD_STAMP__, '"fixed"');
  assert.ok(options.external.includes('obsidian'));
  assert.deepEqual(fs.readdirSync(sentinel), before);
});

test('v3 semantic identities are independent of checkout location', () => {
  const files = { 'src/a.ts': 'import { requestUrl } from "obsidian"; export const run = (url: string) => { fetch(url); return requestUrl({ url }); };\n' };
  const first = repo(files);
  const secondParent = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-relocated-parent-'));
  const second = path.join(secondParent, 'differently-named-checkout');
  execFileSync('git', ['clone', '-q', first, second]);
  const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: first, encoding: 'utf8' }).trim();
  const fixture = writeFixture(first, generateInventory({ root: first, ref, sourceRef: ref }));
  const v2Path = path.join(first, 'verification-v2.json');
  const v2 = generateVerificationV2({ root: first, fixture, sourceRef: ref, historicalFixturePath: 'fixture.json' });
  fs.writeFileSync(v2Path, JSON.stringify(v2, null, 2) + '\n');
  const options = { fixture, verificationArtifactV2: v2Path, sourceRef: ref, historicalFixturePath: 'fixture.json', priorSemanticCatalogPath: 'verification-v2.json' };
  const one = generateVerificationV3({ root: first, ...options });
  const two = generateVerificationV3({ root: second, ...options });
  assert.deepEqual(one, two);
  assert.doesNotMatch(JSON.stringify(one), new RegExp(`${first.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}|${second.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}`));
});

test('v3 sorts equivalent declaration sets before hashing', () => {
  const source = (overloads) => `${overloads}\nfunction transport(value: string | URL) { return fetch(String(value)); }\ntransport("https://a.invalid");\n`;
  const first = repo({ 'src/a.ts': source('function transport(value: string): Response;\nfunction transport(value: URL): Response;') });
  const second = repo({ 'src/a.ts': source('function transport(value: URL): Response;\nfunction transport(value: string): Response;') });
  const firstRef = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: first, encoding: 'utf8' }).trim();
  const fixture = writeFixture(first, generateInventory({ root: first, ref: firstRef, sourceRef: firstRef }));
  const v2Path = path.join(first, 'verification-v2.json');
  fs.writeFileSync(v2Path, JSON.stringify(generateVerificationV2({ root: first, fixture, sourceRef: firstRef, historicalFixturePath: 'fixture.json' }), null, 2) + '\n');
  const firstArtifact = generateVerificationV3({ root: first, fixture, verificationArtifactV2: v2Path, sourceRef: firstRef, historicalFixturePath: 'fixture.json', priorSemanticCatalogPath: 'verification-v2.json' });
  const secondRef = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: second, encoding: 'utf8' }).trim();
  const secondArtifact = generateVerificationV3({ root: second, fixture, verificationArtifactV2: v2Path, sourceRef: secondRef, historicalFixturePath: 'fixture.json', priorSemanticCatalogPath: 'verification-v2.json' });
  assert.deepEqual(firstArtifact.records.map(record => record.provenance.bindingDeclarationFingerprint), secondArtifact.records.map(record => record.provenance.bindingDeclarationFingerprint));
});

test('v3 rejects real destination, import, callee, and wrapper-edge mutations', () => {
  const original = 'import { requestUrl } from "obsidian";\nexport function send(url: string) { return requestUrl({ url: url + "/v1" }); }\nexport const run = () => send("https://a.invalid");\n';
  const root = repo({ 'src/a.ts': original });
  const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const fixture = writeFixture(root, generateInventory({ root, ref, sourceRef: ref }));
  const v2Path = path.join(root, 'verification-v2.json');
  fs.writeFileSync(v2Path, JSON.stringify(generateVerificationV2({ root, fixture, sourceRef: ref, historicalFixturePath: 'fixture.json' }), null, 2) + '\n');
  const v3Path = path.join(root, 'verification-v3.json');
  fs.writeFileSync(v3Path, JSON.stringify(generateVerificationV3({ root, fixture, verificationArtifactV2: v2Path, sourceRef: ref, historicalFixturePath: 'fixture.json', priorSemanticCatalogPath: 'verification-v2.json' }), null, 2) + '\n');
  const verify = () => verifyVerificationV3({ root, fixture, verificationArtifactV2: v2Path, verificationArtifactV3: v3Path });
  for (const [mutation, diagnostic] of [
    [original.replace('/v1', '/v2'), /arguments_changed|destination_changed/],
    [original.replace('from "obsidian"', 'from "other-transport"'), /import_chain_changed|callee_changed|occurrence_missing/],
    [original.replace('requestUrl({', 'requestUrl?.({'), /callee_changed|dynamic_or_computed_access|wrapper_chain_changed/],
    [original.replace('send("https://a.invalid")', 'send("https://b.invalid")'), /wrapper_chain_changed/]
  ]) { fs.writeFileSync(path.join(root, 'src/a.ts'), mutation); assert.throws(verify, diagnostic); }
});

test('v3 fails closed on extra, unmapped, and duplicate live occurrences and duplicate artifact IDs', () => {
  const root = repo({ 'src/a.ts': 'fetch("https://a.invalid");\n' });
  const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const fixture = writeFixture(root, generateInventory({ root, ref, sourceRef: ref }));
  const v2Path = path.join(root, 'verification-v2.json');
  fs.writeFileSync(v2Path, JSON.stringify(generateVerificationV2({ root, fixture, sourceRef: ref, historicalFixturePath: 'fixture.json' }), null, 2) + '\n');
  const v3Path = path.join(root, 'verification-v3.json');
  const artifact = generateVerificationV3({ root, fixture, verificationArtifactV2: v2Path, sourceRef: ref, historicalFixturePath: 'fixture.json', priorSemanticCatalogPath: 'verification-v2.json' });
  fs.writeFileSync(v3Path, JSON.stringify(artifact, null, 2) + '\n');
  const verify = () => verifyVerificationV3({ root, fixture, verificationArtifactV2: v2Path, verificationArtifactV3: v3Path });

  fs.writeFileSync(path.join(root, 'src/a.ts'), 'fetch("https://a.invalid");\nfetch("https://new.invalid");\n');
  assert.throws(verify, /unreviewed_occurrence/);

  fs.writeFileSync(path.join(root, 'src/a.ts'), 'fetch("https://a.invalid");\nfetch("https://a.invalid");\n');
  assert.throws(verify, /duplicate_actual_v3_id|unreviewed_occurrence/);

  fs.writeFileSync(path.join(root, 'src/a.ts'), 'fetch("https://a.invalid");\nnew WebSocket("wss:\/\/unmapped.invalid");\n');
  assert.throws(verify, /unreviewed_occurrence/);

  fs.writeFileSync(path.join(root, 'src/a.ts'), 'fetch("https://a.invalid");\n');
  const duplicated = structuredClone(artifact);
  duplicated.records.push({ ...duplicated.records[0] });
  fs.writeFileSync(v3Path, JSON.stringify(duplicated, null, 2) + '\n');
  assert.throws(verify, /duplicate_artifact_v3_id/);
});

test('integrated Chat commit verifies with v3 from a differently named checkout', () => {
  const sourceRoot = process.cwd();
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-chat-relocation-'));
  const root = path.join(parent, 'chat-checkout-with-unrelated-name');
  execFileSync('git', ['clone', '-q', '--no-checkout', sourceRoot, root]);
  execFileSync('git', ['checkout', '-q', '478cd5606a578f18dc923e65a36b65a5f601f9c7'], { cwd: root });
  fs.symlinkSync(path.join(sourceRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const v3 = 'testing/fixtures/managed/egress-verification-v3-660e7fe.json';
  fs.copyFileSync(path.join(sourceRoot, v3), path.join(root, v3));
  const output = execFileSync(process.execPath, [path.join(sourceRoot, 'scripts/network-egress-inventory.mjs'), 'current', '--source-ref', '478cd5606a578f18dc923e65a36b65a5f601f9c7', '--fixture', 'testing/fixtures/managed/egress-baseline-660e7fe.json'], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  assert.match(output, /PASS/);
});

test('v2 ignores enclosing class edits but detects semantic sink mutations precisely', () => {
  const original = `import { requestUrl } from "obsidian";
export class Client {
  unrelated() { return "before"; }
  send(base: string) { return requestUrl({ url: base + "/v1", method: "POST" }); }
}
`;
  const root = repo({ 'src/client.ts': original });
  const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const fixture = writeFixture(root, generateInventory({ root, ref, sourceRef: ref }));
  const verificationArtifact = path.join(root, 'verification.json');
  fs.writeFileSync(verificationArtifact, JSON.stringify(generateVerificationV2({ root, fixture, sourceRef: ref, historicalFixturePath: 'fixture.json' }), null, 2) + '\n');
  const verify = () => verifyVerificationV2({ root, fixture, verificationArtifact });

  fs.writeFileSync(path.join(root, 'src/client.ts'), original.replace('unrelated() { return "before"; }', 'added() { return 1; }\n  unrelated() { return "after"; }'));
  assert.doesNotThrow(verify);
  for (const mutation of [
    original.replace('base + "/v1"', 'base + "/v2"'),
    original.replace('method: "POST"', 'method: "GET"'),
    original.replace('{ url: base + "/v1", method: "POST" }', '{ method: "POST", url: base + "/v1" }'),
    original.replace('{ url: base + "/v1", method: "POST" }', '{ ...{ url: base + "/v1" }, method: "POST" }'),
    original.replace('requestUrl({ url: base + "/v1", method: "POST" })', 'requestUrl({ url: base + "/v1", method: "POST" }, base)')
  ]) {
    fs.writeFileSync(path.join(root, 'src/client.ts'), mutation);
    assert.throws(verify, /arguments_changed|destination_changed/);
  }
  fs.writeFileSync(path.join(root, 'src/client.ts'), original.replace('requestUrl({', 'requestUrl?.({'));
  assert.throws(verify, /callee_changed|dynamic_or_computed_access|wrapper_chain_changed/);
  fs.writeFileSync(path.join(root, 'src/client.ts'), original.replace('from "obsidian"', 'from "other-transport"'));
  assert.throws(verify, /import_chain_changed/);
  fs.writeFileSync(path.join(root, 'src/client.ts'), original.replace('return requestUrl', 'return requestUrl') + '\nrequestUrl({ url: "https://duplicate.invalid" });\n');
  assert.throws(verify, /occurrence_count_changed/);
  fs.writeFileSync(path.join(root, 'src/client.ts'), 'export const clean = true;\n');
  assert.throws(verify, /occurrence_missing/);
  fs.mkdirSync(path.join(root, 'src/moved'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/moved/client.ts'), original);
  assert.throws(verify, /occurrence_moved|occurrence_missing/);
});

test('v2 fails closed on dynamic and computed transport bypasses even beside an approved sink', () => {
  const variants = [
    'globalThis["fetch"]("https://b.invalid");',
    'window["fetch"]("https://b.invalid");',
    'self["WebSocket"]("wss://b.invalid");',
    'global["XMLHttpRequest"]();',
    'const transport = globalThis.fetch; transport("https://b.invalid");',
    'const name = "fetch"; globalThis[name]("https://b.invalid");',
    'const name = "fe" + "tch"; globalThis[name]("https://b.invalid");',
    'const prefix = "fe"; const name = `${prefix}tch`; globalThis[name]("https://b.invalid");',
    'const name = ("fetch"); globalThis[name]("https://b.invalid");',
    'declare const name: string; globalThis[name]("https://b.invalid");',
    'const moduleName = "openai"; import(moduleName);',
    'const moduleName = "openai"; require(moduleName);',
    'eval("fetch(\\"https://b.invalid\\")");',
    'new Function("return fetch")();',
    'const transports = { primary: fetch }; transports["primary"]("https://b.invalid");',
    'const { primary } = { primary: fetch }; primary("https://b.invalid");'
  ];
  for (const variant of variants) {
    const root = repo({ 'src/a.ts': 'fetch("https://approved.invalid");\n' });
    const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const fixture = writeFixture(root, generateInventory({ root, ref, sourceRef: ref }));
    const verificationArtifact = path.join(root, 'verification.json');
    fs.writeFileSync(verificationArtifact, JSON.stringify(generateVerificationV2({ root, fixture, sourceRef: ref, historicalFixturePath: 'fixture.json' }), null, 2) + '\n');
    fs.writeFileSync(path.join(root, 'src/a.ts'), `fetch("https://approved.invalid");\n${variant}\n`);
    assert.throws(() => verifyVerificationV2({ root, fixture, verificationArtifact }), /dynamic_or_computed_access/, variant);
  }
});

test('v2 fails closed on unresolved higher-order and returned-factory transport dispatch', () => {
  for (const variant of [
    'function invoke(transport: typeof fetch) { return transport("https://b.invalid"); } invoke(fetch);',
    'function factory() { return fetch; } factory()("https://b.invalid");'
  ]) {
    const root = repo({ 'src/a.ts': `fetch("https://approved.invalid");\n${variant}\n` });
    const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const fixture = writeFixture(root, generateInventory({ root, ref, sourceRef: ref }));
    assert.throws(() => generateVerificationV2({ root, fixture, sourceRef: ref, historicalFixturePath: 'fixture.json' }), /resolution_ambiguous/, variant);
  }
});

test('v2 verifies Git index and worktree independently', () => {
  const root = repo({ 'src/a.ts': 'fetch("https://approved.invalid");\n' });
  const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const fixture = writeFixture(root, generateInventory({ root, ref, sourceRef: ref }));
  const verificationArtifact = path.join(root, 'verification.json');
  fs.writeFileSync(verificationArtifact, JSON.stringify(generateVerificationV2({ root, fixture, sourceRef: ref, historicalFixturePath: 'fixture.json' }), null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'fetch("https://staged.invalid");\n');
  execFileSync('git', ['add', 'src/a.ts'], { cwd: root });
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'fetch("https://approved.invalid");\n');
  assert.throws(() => verifyVerificationV2({ root, fixture, verificationArtifact }), /index .*arguments_changed/);
  execFileSync('git', ['reset', '-q', 'HEAD', '--', 'src/a.ts'], { cwd: root });
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'fetch("https://worktree.invalid");\n');
  assert.throws(() => verifyVerificationV2({ root, fixture, verificationArtifact }), /worktree .*arguments_changed/);
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'fetch("https://approved.invalid");\n');
  fs.writeFileSync(path.join(root, 'src/added.ts'), 'new WebSocket("wss://added.invalid");\n');
  execFileSync('git', ['add', 'src/added.ts'], { cwd: root });
  fs.unlinkSync(path.join(root, 'src/added.ts'));
  assert.throws(() => verifyVerificationV2({ root, fixture, verificationArtifact }), /index .*unreviewed_occurrence/);
  execFileSync('git', ['reset', '-q', 'HEAD', '--', 'src/added.ts'], { cwd: root });
  fs.rmSync(path.join(root, 'src/added.ts'), { force: true });
  fs.writeFileSync(path.join(root, 'src/helper.ts'), 'export const destination = "https://filesystem.invalid";\n');
  execFileSync('git', ['add', 'src/helper.ts'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'helper'], { cwd: root });
  execFileSync('git', ['rm', '-q', 'src/helper.ts'], { cwd: root });
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'import { destination } from "./helper"; fetch(destination);\n');
  execFileSync('git', ['add', 'src/a.ts'], { cwd: root });
  fs.writeFileSync(path.join(root, 'src/helper.ts'), 'export const destination = "https://contamination.invalid";\n');
  assert.throws(() => verifyVerificationV2({ root, fixture, verificationArtifact }), /index .*arguments_changed|index .*destination_changed/);
});

test('source-ref resolution never reads absent production modules from the filesystem', () => {
  const root = repo({ 'src/a.ts': 'import { destination } from "./absent"; fetch(destination);\n' });
  const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const fixture = writeFixture(root, generateInventory({ root, ref, sourceRef: ref }));
  fs.writeFileSync(path.join(root, 'src/absent.ts'), 'export const destination = "https://contamination.invalid";\n');
  const first = generateVerificationV2({ root, fixture, sourceRef: ref, historicalFixturePath: 'fixture.json' });
  fs.writeFileSync(path.join(root, 'src/absent.ts'), 'export const destination = "https://changed.invalid";\n');
  assert.deepEqual(first, generateVerificationV2({ root, fixture, sourceRef: ref, historicalFixturePath: 'fixture.json' }));
});

test('source-ref resolution preserves callers after an entire imported source directory is deleted', () => {
  const root = repo({
    'src/transport/client.ts': 'export function send(url: string) { return fetch(url); }\n',
    'src/callers/run.ts': 'import { send } from "../transport/client"; export function run() { return send("https://approved.invalid"); }\n',
  });
  const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const fixture = writeFixture(root, generateInventory({ root, ref, sourceRef: ref }));
  const before = generateVerificationV2({ root, fixture, sourceRef: ref, historicalFixturePath: 'fixture.json' });
  execFileSync('git', ['rm', '-qr', 'src/callers', 'src/transport'], { cwd: root });
  const after = generateVerificationV2({ root, fixture, sourceRef: ref, historicalFixturePath: 'fixture.json' });
  assert.deepEqual(after, before);
  const wrapper = after.records.find(record => record.primitiveOrImport === 'wrapper:send->fetch');
  assert.ok(wrapper?.provenance.wrapperCallChain.some(edge => edge.path === 'src/callers/run.ts'));
});

test('v2 resolves cross-file wrapper callers and fails when the caller edge changes', () => {
  const files = {
    'src/transport.ts': 'export function send(url: string) { return fetch(url); }\n',
    'src/caller.ts': 'import { send } from "./transport"; export function run() { return send("https://a.invalid"); }\n'
  };
  const root = repo(files);
  const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const fixture = writeFixture(root, generateInventory({ root, ref, sourceRef: ref }));
  const verificationArtifact = path.join(root, 'verification.json');
  fs.writeFileSync(verificationArtifact, JSON.stringify(generateVerificationV2({ root, fixture, sourceRef: ref, historicalFixturePath: 'fixture.json' }), null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'src/caller.ts'), files['src/caller.ts'].replace('https://a.invalid', 'https://b.invalid'));
  assert.throws(() => verifyVerificationV2({ root, fixture, verificationArtifact }), /wrapper_chain_changed|occurrence_changed/);
});

test('v2 discovers statically re-exported transports through TypeChecker aliases', () => {
  const root = repo({
    'src/bridge.ts': 'export { requestUrl as send } from "obsidian";\n',
    'src/a.ts': 'import { send } from "./bridge"; send({ url: "https://a.invalid" });\n'
  });
  const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const fixture = writeFixture(root, generateInventory({ root, ref, sourceRef: ref }));
  assert.throws(() => generateVerificationV2({ root, fixture, sourceRef: ref, historicalFixturePath: 'fixture.json' }), /occurrence_count_changed/);
});

test('v2 fingerprints destination symbol dependencies while ignoring unrelated declarations', () => {
  const original = 'const base = "https://a.invalid";\nconst unrelated = 1;\nfetch(base + "/v1");\n';
  const root = repo({ 'src/a.ts': original });
  const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const fixture = writeFixture(root, generateInventory({ root, ref, sourceRef: ref }));
  const verificationArtifact = path.join(root, 'verification.json');
  fs.writeFileSync(verificationArtifact, JSON.stringify(generateVerificationV2({ root, fixture, sourceRef: ref, historicalFixturePath: 'fixture.json' }), null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'src/a.ts'), original.replace('unrelated = 1', 'unrelated = 2'));
  assert.doesNotThrow(() => verifyVerificationV2({ root, fixture, verificationArtifact }));
  fs.writeFileSync(path.join(root, 'src/a.ts'), original.replace('https://a.invalid', 'https://b.invalid'));
  assert.throws(() => verifyVerificationV2({ root, fixture, verificationArtifact }), /destination_changed|occurrence_changed/);
});

test('v2 maps wrappers by signature and direct sink edge, not enclosing class text', () => {
  const original = `export class Api {
  noise() { return 1; }
  getStatus(url: string): Promise<Response> { return fetch(url); }
  caller(url: string) { return this.getStatus(url); }
}
`;
  const root = repo({ 'src/api.ts': original });
  const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const fixture = writeFixture(root, generateInventory({ root, ref, sourceRef: ref }));
  const verificationArtifact = path.join(root, 'verification.json');
  const generated = generateVerificationV2({ root, fixture, sourceRef: ref, historicalFixturePath: 'fixture.json' });
  fs.writeFileSync(verificationArtifact, JSON.stringify(generated, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'src/api.ts'), original.replace('noise() { return 1; }', 'noise() { return 2; }\n  extra() { return 3; }'));
  assert.doesNotThrow(() => verifyVerificationV2({ root, fixture, verificationArtifact }));
  fs.writeFileSync(path.join(root, 'src/api.ts'), original.replace('getStatus(url: string)', 'getStatus(url: URL)'));
  assert.throws(() => verifyVerificationV2({ root, fixture, verificationArtifact }), /wrapper_chain_changed|occurrence_changed|arguments_changed/);
});

test('v2 generation is deterministic and fails closed on tampered history and metadata', () => {
  const root = repo({ 'src/a.ts': 'fetch("https://a.invalid");\n' });
  const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const fixture = writeFixture(root, generateInventory({ root, ref, sourceRef: ref }));
  const one = generateVerificationV2({ root, fixture, sourceRef: ref, historicalFixturePath: 'fixture.json' });
  const two = generateVerificationV2({ root, fixture, sourceRef: ref, historicalFixturePath: 'fixture.json' });
  assert.deepEqual(one, two);
  const verificationArtifact = path.join(root, 'verification.json');
  fs.writeFileSync(verificationArtifact, JSON.stringify(one, null, 2) + '\n');
  const history = JSON.parse(fs.readFileSync(fixture, 'utf8')); history.records[0].ownerPlan = '017'; fs.writeFileSync(fixture, JSON.stringify(history, null, 2) + '\n');
  assert.throws(() => verifyVerificationV2({ root, fixture, verificationArtifact }), /history_tampered/);
});

test('v2 rejects missing, extra, duplicate, and unknown companion mappings', () => {
  const root = repo({ 'src/a.ts': 'fetch("https://a.invalid");\n' });
  const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const fixture = writeFixture(root, generateInventory({ root, ref, sourceRef: ref }));
  const artifact = generateVerificationV2({ root, fixture, sourceRef: ref, historicalFixturePath: 'fixture.json' });
  const verificationArtifact = path.join(root, 'verification.json');
  const check = value => { fs.writeFileSync(verificationArtifact, JSON.stringify(value, null, 2) + '\n'); return () => verifyVerificationV2({ root, fixture, verificationArtifact, sourceRef: ref }); };
  assert.throws(check({ ...artifact, records: [] }), /mapping_count_mismatch/);
  assert.throws(check({ ...artifact, records: [...artifact.records, artifact.records[0]] }), /mapping_count_mismatch/);
  assert.throws(check({ ...artifact, records: [{ ...artifact.records[0], historicalRecordId: 'unknown' }] }), /history_tampered/);
  assert.throws(check({ ...artifact, schemaVersion: 99 }), /unsupported_analyzer_version/);
});

test('v2 wrapper provenance includes deterministic recursive shortest chains and rejects cycles', () => {
  const files = {
    'src/transport.ts': 'export function send(url: string) { return fetch(url); }\n',
    'src/mid.ts': 'import { send } from "./transport"; export function mid(url: string) { return send(url); }\n',
    'src/top.ts': 'import { mid } from "./mid"; export const one = () => mid("https://one.invalid"); export const two = () => mid("https://two.invalid");\n'
  };
  const root = repo(files);
  const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const fixture = writeFixture(root, generateInventory({ root, ref, sourceRef: ref }));
  const artifact = generateVerificationV2({ root, fixture, sourceRef: ref, historicalFixturePath: 'fixture.json' });
  const wrapper = artifact.records.find(record => record.primitiveOrImport === 'wrapper:send->fetch');
  assert.ok(wrapper.provenance.wrapperCallChain.length >= 5);
  assert.deepEqual(artifact, generateVerificationV2({ root, fixture, sourceRef: ref, historicalFixturePath: 'fixture.json' }));
  const cyclic = repo({ 'src/a.ts': 'export function a(url: string) { return b(url); } export function b(url: string) { a(url); return fetch(url); }\n' });
  const cyclicRef = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: cyclic, encoding: 'utf8' }).trim();
  const cyclicFixture = writeFixture(cyclic, generateInventory({ root: cyclic, ref: cyclicRef, sourceRef: cyclicRef }));
  assert.throws(() => generateVerificationV2({ root: cyclic, fixture: cyclicFixture, sourceRef: cyclicRef, historicalFixturePath: 'fixture.json' }), /resolution_ambiguous: cyclic wrapper call graph/);
});

test('v2 keeps same-named methods collision-safe', () => {
  const root = repo({ 'src/a.ts': 'class A { send(url: string) { return fetch(url); } } class B { send(url: string) { return fetch(url); } } new A().send("https://a.invalid"); new B().send("https://b.invalid");\n' });
  const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const fixture = writeFixture(root, generateInventory({ root, ref, sourceRef: ref }));
  assert.doesNotThrow(() => generateVerificationV2({ root, fixture, sourceRef: ref, historicalFixturePath: 'fixture.json' }));
});

test('default verify pins trust-boundary refs while current supports deterministic source-ref verification', () => {
  const cwd = process.cwd();
  const fixture = 'testing/fixtures/managed/egress-baseline-660e7fe.json';
  for (const args of [
    ['verify', '--ref', 'HEAD', '--fixture', fixture],
    ['verify', '--source-ref', 'HEAD', '--fixture', fixture]
  ]) assert.throws(() => execFileSync(process.execPath, ['scripts/network-egress-inventory.mjs', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }), /history_tampered/);
  const sourceRef = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  assert.match(execFileSync(process.execPath, ['scripts/network-egress-inventory.mjs', 'current', '--source-ref', sourceRef, '--fixture', fixture], { cwd, encoding: 'utf8', stdio: 'pipe' }), /PASS/);
});

test('default verify rejects a companion regenerated from laundered source semantics', () => {
  const root = process.cwd();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-source-launder-'));
  execFileSync('git', ['clone', '-q', '--no-checkout', root, temp]);
  execFileSync('git', ['checkout', '-q', 'c4f81ebc35aa836f787f198b8341d9496bc367ba'], { cwd: temp });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: temp });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: temp });
  const fixture = path.join(temp, 'testing/fixtures/managed/egress-baseline-660e7fe.json');
  fs.copyFileSync(path.join(root, 'testing/fixtures/managed/egress-baseline-660e7fe.json'), fixture);
  const source = path.join(temp, 'src/services/SystemSculptService.ts');
  const original = fs.readFileSync(source, 'utf8');
  fs.writeFileSync(source, original.replace('method: "GET"', 'method: "POST"'));
  execFileSync('git', ['add', 'src/services/SystemSculptService.ts'], { cwd: temp });
  execFileSync('git', ['commit', '-qm', 'launder reviewed egress semantics'], { cwd: temp });
  const changedRef = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: temp, encoding: 'utf8' }).trim();
  const laundered = generateVerificationV2({ root: temp, fixture, sourceRef: changedRef, historicalFixturePath: 'testing/fixtures/managed/egress-baseline-660e7fe.json' });
  assert.equal(laundered.approvedSource.commit, changedRef);
  const launderedPath = path.join(temp, 'testing/fixtures/managed/egress-verification-v2-660e7fe.json');
  fs.writeFileSync(launderedPath, JSON.stringify(laundered, null, 2) + '\n');
  assert.throws(() => execFileSync(process.execPath, [path.join(root, 'scripts/network-egress-inventory.mjs'), 'verify', '--fixture', fixture, '--verification-artifact', launderedPath], { cwd: temp, encoding: 'utf8', stdio: 'pipe' }), /history_tampered.*approvedSource\.commit/);
});

test('default verify rejects coordinated historical fixture and companion tampering', () => {
  const root = process.cwd();
  const fixture = path.join(root, 'testing/fixtures/managed/egress-baseline-660e7fe.json');
  const companion = path.join(root, 'testing/fixtures/managed/egress-verification-v2-660e7fe.json');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-coordinated-'));
  const tamperedFixture = path.join(temp, 'egress-baseline-660e7fe.json');
  const tamperedCompanion = path.join(temp, 'egress-verification-v2-660e7fe.json');
  const history = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  history.records[0].ownerPlan = history.records[0].ownerPlan === '031' ? '017' : '031';
  fs.writeFileSync(tamperedFixture, JSON.stringify(history, null, 2) + '\n');
  const artifact = JSON.parse(fs.readFileSync(companion, 'utf8'));
  const bytes = fs.readFileSync(tamperedFixture);
  artifact.historicalFixture.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  artifact.historicalFixture.gitBlob = execFileSync('git', ['hash-object', tamperedFixture], { cwd: root, encoding: 'utf8' }).trim();
  fs.writeFileSync(tamperedCompanion, JSON.stringify(artifact, null, 2) + '\n');
  assert.throws(() => execFileSync(process.execPath, ['scripts/network-egress-inventory.mjs', 'verify', '--fixture', tamperedFixture, '--verification-artifact', tamperedCompanion], { cwd: root, encoding: 'utf8', stdio: 'pipe' }), /history_tampered/);
  for (const field of ['historicalOrigin', 'historicalOccurrenceIdentity', 'path', 'classification', 'primitiveOrImport']) {
    const mutation = structuredClone(JSON.parse(fs.readFileSync(companion, 'utf8')));
    mutation.records[0][field] = `${mutation.records[0][field]}-laundered`;
    fs.writeFileSync(tamperedCompanion, JSON.stringify(mutation, null, 2) + '\n');
    assert.throws(() => verifyVerificationV2({ root, fixture, verificationArtifact: tamperedCompanion, sourceRef: mutation.approvedSource.commit }), /history_tampered/, field);
  }
});

test('empty disposition ledger classifies all historical records without rewriting v1 or v2', () => {
  const root = process.cwd();
  const fixture = path.join(root, 'testing/fixtures/managed/egress-baseline-660e7fe.json');
  const verificationArtifact = path.join(root, 'testing/fixtures/managed/egress-verification-v2-660e7fe.json');
  const dispositionLedger = writeEmptyDispositionLedger(root);
  const result = verifyDispositionLedger({ root, fixture, verificationArtifact, dispositionLedger });
  assert.equal(result.transitions, 0);
  const states = [...result.effective.values()];
  assert.equal(states.length, 140);
  assert.equal(states.filter(record => record.effectiveStatus === 'present').length, 131);
  assert.equal(states.filter(record => record.effectiveStatus === 'historical_removed').length, 9);
});

test('disposition ledger rejects malformed versions, anchors, mappings, and non-empty transitions', () => {
  const root = process.cwd();
  const fixture = path.join(root, 'testing/fixtures/managed/egress-baseline-660e7fe.json');
  const verificationArtifact = path.join(root, 'testing/fixtures/managed/egress-verification-v2-660e7fe.json');
  const original = JSON.parse(fs.readFileSync(writeEmptyDispositionLedger(root), 'utf8'));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-disposition-'));
  const check = (mutation, pattern) => {
    const dispositionLedger = path.join(temp, 'ledger.json');
    fs.writeFileSync(dispositionLedger, JSON.stringify(mutation(structuredClone(original)), null, 2) + '\n');
    assert.throws(() => verifyDispositionLedger({ root, fixture, verificationArtifact, dispositionLedger }), pattern);
  };
  check(value => ({ ...value, schemaVersion: 2 }), /disposition_history_tampered/);
  check(value => ({ ...value, unexpected: true }), /disposition_history_tampered/);
  check(value => { value.historicalFixture.sha256 = '0'.repeat(64); return value; }, /disposition_anchor_mismatch/);
  check(value => { value.semanticCatalog.mappingCount -= 1; return value; }, /disposition_anchor_mismatch/);
  check(value => { value.transitions.push({ sequence: 0 }); return value; }, /disposition_history_tampered/);
});

function transitionRepo(file = 'src/services/YouTubeMetadataService.ts', source = 'export function send() { return fetch("https://example.invalid"); }\n', extraFiles = {}) {
  const root = repo({ ...extraFiles, [file]: source });
  const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), dir = path.join(root, 'testing/fixtures/managed'); fs.mkdirSync(dir, { recursive: true });
  const fixture = path.join(dir, 'egress-baseline-test.json'); fs.writeFileSync(fixture, JSON.stringify(generateInventory({ root, ref, sourceRef: ref }), null, 2) + '\n');
  const v2 = path.join(dir, 'egress-verification-v2-test.json'); fs.writeFileSync(v2, JSON.stringify(generateVerificationV2({ root, fixture, sourceRef: ref, historicalFixturePath: 'testing/fixtures/managed/egress-baseline-test.json' }), null, 2) + '\n');
  const v3 = path.join(dir, 'egress-verification-v3-test.json'); fs.writeFileSync(v3, JSON.stringify(generateVerificationV3({ root, fixture, verificationArtifactV2: v2, sourceRef: ref, historicalFixturePath: 'testing/fixtures/managed/egress-baseline-test.json', priorSemanticCatalogPath: 'testing/fixtures/managed/egress-verification-v2-test.json' }), null, 2) + '\n');
  const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
  const historyBytes = fs.readFileSync(fixture), v2Bytes = fs.readFileSync(v2), catalog = JSON.parse(v2Bytes), ledger = path.join(dir, 'egress-dispositions-v1-test.json');
  fs.writeFileSync(ledger, JSON.stringify({ schemaVersion: 1, ledgerVersion: 'network-egress-dispositions-v1', historicalFixture: { path: 'testing/fixtures/managed/egress-baseline-test.json', gitBlob: execFileSync('git', ['hash-object', fixture], { cwd: root, encoding: 'utf8' }).trim(), sha256: crypto.createHash('sha256').update(historyBytes).digest('hex') }, semanticCatalog: { path: 'testing/fixtures/managed/egress-verification-v2-test.json', gitBlob: execFileSync('git', ['hash-object', v2], { cwd: root, encoding: 'utf8' }).trim(), sha256: crypto.createHash('sha256').update(v2Bytes).digest('hex'), mappingCount: catalog.records.length, mappingSha256: crypto.createHash('sha256').update(canonical(catalog.records)).digest('hex') }, transitions: [] }, null, 2) + '\n');
  execFileSync('git', ['add', '.'], { cwd: root }); execFileSync('git', ['commit', '-qm', 'catalog'], { cwd: root });
  return { root, fixture, v2, v3, ledger, file, tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim(), ledgerBlob: execFileSync('git', ['hash-object', ledger], { cwd: root, encoding: 'utf8' }).trim(), ledgerSha: crypto.createHash('sha256').update(fs.readFileSync(ledger)).digest('hex') };
}
function transitionArgs(setup) { const records = JSON.parse(fs.readFileSync(setup.v3, 'utf8')).records; return { root: setup.root, verificationArtifactV3: setup.v3, dispositionLedger: setup.ledger, ownerPlan: records[0].ownerPlan, recordIds: records.map(record => record.historicalRecordId), predecessorSourceTree: setup.tree, predecessorLedgerBlob: setup.ledgerBlob, predecessorLedgerSha256: setup.ledgerSha, predecessorTransitionCount: 0, predecessorFinalTransitionHash: 'NONE' }; }
function stageOwnerRemoval(setup) { fs.writeFileSync(path.join(setup.root, setup.file), 'export const removed = true;\n'); execFileSync('git', ['add', setup.file], { cwd: setup.root }); return generateDispositionTransitions(transitionArgs(setup)); }

test('transition generation binds staged owner removals to tree, blobs, predecessor, and deterministic order', () => {
  const setup = transitionRepo(), next = stageOwnerRemoval(setup); assert.ok(next.transitions.length >= 1); assert.deepEqual(next, generateDispositionTransitions(transitionArgs(setup)));
  const output = path.join(setup.root, 'next.json'); fs.writeFileSync(output, JSON.stringify(next, null, 2) + '\n'); assert.equal(verifyDispositionLedger({ root: setup.root, fixture: setup.fixture, verificationArtifact: setup.v2, verificationArtifactV3: setup.v3, dispositionLedger: output }).transitions, next.transitions.length);
  assert.throws(() => verifyDispositionLedger({ root: setup.root, fixture: setup.fixture, verificationArtifact: setup.v2, dispositionLedger: output }), /disposition_mapping_mismatch/);
  assert.throws(() => generateDispositionTransitions({ ...transitionArgs(setup), ownerPlan: '027', recordIds: [] }), /disposition_owner_mismatch/);
});

test('transition history rejects chain, predecessor, tree, and blob tampering', () => {
  const setup = transitionRepo(), next = stageOwnerRemoval(setup), output = path.join(setup.root, 'next.json');
  const check = mutate => { const value = structuredClone(next); mutate(value); fs.writeFileSync(output, JSON.stringify(value, null, 2) + '\n'); assert.throws(() => verifyDispositionLedger({ root: setup.root, fixture: setup.fixture, verificationArtifact: setup.v2, verificationArtifactV3: setup.v3, dispositionLedger: output }), /disposition_/); };
  check(value => { value.transitions[0].ownerPlan = '027'; }); check(value => { value.transitions[0].sourceEvidence[0].afterGitBlobOrNull = '0'.repeat(40); }); check(value => { value.transitions[0].predecessorLedger.sha256 = '0'.repeat(64); }); check(value => { value.transitions[0].stagedSourceTree = setup.tree; });
});

test('transition generation distinguishes index and worktree and rejects wrong checkpoint', () => {
  const setup = transitionRepo(); fs.writeFileSync(path.join(setup.root, setup.file), 'export const removed = true;\n'); assert.throws(() => generateDispositionTransitions(transitionArgs(setup)), /removed_occurrence_present/);
  execFileSync('git', ['add', setup.file], { cwd: setup.root }); assert.throws(() => generateDispositionTransitions({ ...transitionArgs(setup), predecessorSourceTree: '0'.repeat(40) }), /disposition_source_tree_missing/);
  const stagedRemoval = fs.readFileSync(path.join(setup.root, setup.file), 'utf8'), original = execFileSync('git', ['show', `HEAD:${setup.file}`], { cwd: setup.root, encoding: 'utf8' }); fs.writeFileSync(path.join(setup.root, setup.file), original); assert.throws(() => generateDispositionTransitions(transitionArgs(setup)), /index\/worktree confusion/); fs.writeFileSync(path.join(setup.root, setup.file), stagedRemoval);
  assert.doesNotThrow(() => generateDispositionTransitions(transitionArgs(setup)));
});

test('synthetic exact-count owner 026, 026a, and 027 dry-runs remain owner-scoped', () => {
  for (const [file, expectedOwner, count] of [['src/services/YouTubeMetadataService.ts', '026', 19], ['src/services/readwise.ts', '026a', 5], ['src/mcp/client.ts', '027', 4]]) {
    const source = Array.from({ length: count }, (_, index) => `fetch("https://example.invalid/${index}");`).join('\n') + '\n';
    const setup = transitionRepo(file, source), next = stageOwnerRemoval(setup), records = JSON.parse(fs.readFileSync(setup.v3, 'utf8')).records;
    assert.equal(records.length, count); assert.ok(records.every(record => record.ownerPlan === expectedOwner));
    assert.equal(next.transitions.length, count); assert.ok(next.transitions.every(entry => entry.ownerPlan === expectedOwner));
  }
});

function canonicalTest(value) { return Array.isArray(value) ? `[${value.map(canonicalTest).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalTest(value[key])}`).join(',')}}` : JSON.stringify(value); }
function rehashTransitions(transitions) { transitions.forEach((entry, index) => { entry.sequence = index; entry.previousTransitionHash = index ? transitions[index - 1].transitionHash : null; const copy = { ...entry }; delete copy.transitionHash; entry.transitionHash = crypto.createHash('sha256').update(`network-egress-disposition-v1\0${canonicalTest(copy)}`).digest('hex'); }); }

test('whole-chain recompute, reordered suffix, and incomplete evidence still fail closed', () => {
  const setup = transitionRepo(), next = stageOwnerRemoval(setup), output = path.join(setup.root, 'tampered.json'); assert.ok(next.transitions.length >= 2, 'reorder fixture must contain multiple transitions');
  const verify = value => { fs.writeFileSync(output, JSON.stringify(value, null, 2) + '\n'); return () => verifyDispositionLedger({ root: setup.root, fixture: setup.fixture, verificationArtifact: setup.v2, verificationArtifactV3: setup.v3, dispositionLedger: output }); };
  const rewritten = structuredClone(next); rewritten.transitions[0].ownerPlan = '027'; rehashTransitions(rewritten.transitions); assert.throws(verify(rewritten), /disposition_owner_mismatch/);
  const reordered = structuredClone(next), originalOrder = reordered.transitions.map(entry => entry.historicalRecordId); reordered.transitions.reverse(); assert.notDeepEqual(reordered.transitions.map(entry => entry.historicalRecordId), originalOrder); rehashTransitions(reordered.transitions); assert.throws(verify(reordered), /disposition_not_append_only|disposition_predecessor_mismatch/);
  const incomplete = structuredClone(next); incomplete.transitions.forEach(entry => entry.sourceEvidence.pop()); rehashTransitions(incomplete.transitions); assert.throws(verify(incomplete), /disposition_source_blob_mismatch/);
});

test('one predecessor batch cannot splice divergent cumulative staged snapshots', () => {
  const setup = transitionRepo('src/services/YouTubeMetadataService.ts', 'export function send() { return fetch("https://example.invalid"); }\n', { 'src/unrelated.ts': 'export const value = 1;\n' });
  fs.writeFileSync(path.join(setup.root, setup.file), 'export const removed = true;\n'); execFileSync('git', ['add', setup.file], { cwd: setup.root }); const batchA = generateDispositionTransitions(transitionArgs(setup)); assert.ok(batchA.transitions.length >= 2);
  fs.writeFileSync(path.join(setup.root, 'src/unrelated.ts'), 'export const value = 2;\n'); execFileSync('git', ['add', 'src/unrelated.ts'], { cwd: setup.root }); const batchB = generateDispositionTransitions(transitionArgs(setup)); assert.notEqual(batchA.transitions[0].stagedSourceTree, batchB.transitions[0].stagedSourceTree);
  const spliced = { ...batchA, transitions: [structuredClone(batchA.transitions[0]), structuredClone(batchB.transitions[1])] }; rehashTransitions(spliced.transitions); const output = path.join(setup.root, 'spliced.json'); fs.writeFileSync(output, JSON.stringify(spliced, null, 2) + '\n');
  assert.throws(() => verifyDispositionLedger({ root: setup.root, fixture: setup.fixture, verificationArtifact: setup.v2, verificationArtifactV3: setup.v3, dispositionLedger: output }), /disposition_predecessor_mismatch/);
  assert.throws(() => verifyDispositionLedger({ root: setup.root, fixture: setup.fixture, verificationArtifact: setup.v2, dispositionLedger: output }), /disposition_mapping_mismatch/);
});

test('checkpoint commit must be in HEAD ancestry, not only an arbitrary side ref', () => {
  const setup = transitionRepo(), next = stageOwnerRemoval(setup), main = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: setup.root, encoding: 'utf8' }).trim();
  execFileSync('git', ['reset', '--hard', '-q', 'HEAD'], { cwd: setup.root }); execFileSync('git', ['checkout', '--orphan', 'fabricated-side', '-q'], { cwd: setup.root });
  const sideLedger = `${fs.readFileSync(setup.ledger, 'utf8').trimEnd()}  \n`; fs.writeFileSync(setup.ledger, sideLedger); execFileSync('git', ['add', '.'], { cwd: setup.root }); execFileSync('git', ['commit', '-qm', 'fabricated side checkpoint'], { cwd: setup.root });
  const sideTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: setup.root, encoding: 'utf8' }).trim(), sideBlob = execFileSync('git', ['hash-object', setup.ledger], { cwd: setup.root, encoding: 'utf8' }).trim(), sideSha = crypto.createHash('sha256').update(fs.readFileSync(setup.ledger)).digest('hex'); execFileSync('git', ['checkout', '-q', main], { cwd: setup.root });
  const forged = structuredClone(next); forged.transitions.forEach(entry => { entry.predecessorSourceTree = sideTree; entry.predecessorLedger.gitBlob = sideBlob; entry.predecessorLedger.sha256 = sideSha; entry.sourceEvidence.forEach(evidence => { evidence.beforeGitBlobOrNull = execFileSync('git', ['ls-tree', sideTree, '--', evidence.path], { cwd: setup.root, encoding: 'utf8' }).trim().split(/\s+/)[2] || null; }); }); rehashTransitions(forged.transitions);
  const output = path.join(setup.root, 'side.json'); fs.writeFileSync(output, JSON.stringify(forged, null, 2) + '\n'); assert.throws(() => verifyDispositionLedger({ root: setup.root, fixture: setup.fixture, verificationArtifact: setup.v2, verificationArtifactV3: setup.v3, dispositionLedger: output }), /disposition_predecessor_mismatch/);
});

test('generation rejects staged non-source paths, omitted and extra IDs, and computed replacements', () => {
  const stagedOther = transitionRepo(); fs.writeFileSync(path.join(stagedOther.root, stagedOther.file), 'export const removed = true;\n'); fs.writeFileSync(path.join(stagedOther.root, 'notes.txt'), 'staged\n'); execFileSync('git', ['add', stagedOther.file, 'notes.txt'], { cwd: stagedOther.root }); assert.throws(() => generateDispositionTransitions(transitionArgs(stagedOther)), /staged non-production paths/);
  const omitted = transitionRepo(); fs.writeFileSync(path.join(omitted.root, omitted.file), 'export const removed = true;\n'); execFileSync('git', ['add', omitted.file], { cwd: omitted.root }); const args = transitionArgs(omitted); assert.ok(args.recordIds.length >= 2); const incompleteIds = args.recordIds.slice(0, -1); assert.ok(incompleteIds.length > 0 && incompleteIds.length < args.recordIds.length); assert.throws(() => generateDispositionTransitions({ ...args, recordIds: incompleteIds }), /present_occurrence_missing|owner_mismatch/); assert.throws(() => generateDispositionTransitions({ ...args, recordIds: [...args.recordIds, '0'.repeat(64)] }), /disposition_owner_mismatch/);
  const dynamic = transitionRepo(); fs.writeFileSync(path.join(dynamic.root, dynamic.file), 'const key = "fetch"; globalThis[key]("https://example.invalid");\n'); execFileSync('git', ['add', dynamic.file], { cwd: dynamic.root }); assert.throws(() => generateDispositionTransitions(transitionArgs(dynamic)), /dynamic_or_computed_access|unreviewed_occurrence/);
});

test('duplicate identical ordinals use present-first multiset assignment', () => {
  const setup = transitionRepo('src/services/YouTubeMetadataService.ts', 'fetch("https://same.invalid");\nfetch("https://same.invalid");\n');
  const records = JSON.parse(fs.readFileSync(setup.v3, 'utf8')).records; assert.equal(records.length, 2);
  fs.writeFileSync(path.join(setup.root, setup.file), 'fetch("https://same.invalid");\n'); execFileSync('git', ['add', setup.file], { cwd: setup.root });
  const next = generateDispositionTransitions({ ...transitionArgs(setup), recordIds: [records[0].historicalRecordId] }); const output = path.join(setup.root, 'one-removed.json'); fs.writeFileSync(output, JSON.stringify(next, null, 2) + '\n');
  const checked = verifyDispositionLedger({ root: setup.root, fixture: setup.fixture, verificationArtifact: setup.v2, verificationArtifactV3: setup.v3, dispositionLedger: output }); assert.equal(checked.transitions, 1);
  const ledgerValue = JSON.parse(fs.readFileSync(output, 'utf8')), v3 = JSON.parse(fs.readFileSync(setup.v3, 'utf8')); assert.doesNotThrow(() => validateDispositionState(setup.root, v3, checked.effective, undefined, ledgerValue));
  fs.writeFileSync(path.join(setup.root, setup.file), 'fetch("https://same.invalid");\nfetch("https://same.invalid");\nfetch("https://same.invalid");\n'); execFileSync('git', ['add', setup.file], { cwd: setup.root });
  assert.throws(() => validateDispositionState(setup.root, v3, checked.effective, undefined, ledgerValue), /unreviewed_occurrence|removed_occurrence_present/);
  assert.throws(() => generateDispositionTransitions({ ...transitionArgs(setup), recordIds: [records[0].historicalRecordId] }), /unreviewed_occurrence|removed_occurrence_present/);
});

test('cross-owner identical same-key mappings fail as ambiguous', () => {
  const setup = transitionRepo('src/services/YouTubeMetadataService.ts', 'fetch("https://same.invalid");\nfetch("https://same.invalid");\n'), v3 = JSON.parse(fs.readFileSync(setup.v3, 'utf8')); assert.equal(v3.records.length, 2); v3.records[1].ownerPlan = '027';
  const effective = new Map(v3.records.map(record => [record.historicalRecordId, { historicalRecordId: record.historicalRecordId, effectiveStatus: 'present' }]));
  assert.throws(() => validateDispositionState(setup.root, v3, effective, undefined, { transitions: [] }), /disposition_owner_mismatch/);
});

test('destination dependency paths are mandatory source evidence', () => {
  const setup = transitionRepo('src/services/YouTubeMetadataService.ts', 'import { destination } from "./egressConfig";\nexport function send() { return fetch(destination); }\n', { 'src/services/egressConfig.ts': 'export const destination = "https://example.invalid";\n' });
  fs.writeFileSync(path.join(setup.root, setup.file), 'import { destination } from "./egressConfig";\nexport function send() { return undefined; }\n'); execFileSync('git', ['add', setup.file], { cwd: setup.root }); const next = generateDispositionTransitions(transitionArgs(setup));
  assert.ok(next.transitions.every(entry => entry.sourceEvidence.some(evidence => evidence.path === 'src/services/egressConfig.ts')));
  const tampered = structuredClone(next); tampered.transitions.forEach(entry => { entry.sourceEvidence = entry.sourceEvidence.filter(evidence => evidence.path !== 'src/services/egressConfig.ts'); }); rehashTransitions(tampered.transitions); const output = path.join(setup.root, 'missing-dependency.json'); fs.writeFileSync(output, JSON.stringify(tampered, null, 2) + '\n');
  assert.throws(() => verifyDispositionLedger({ root: setup.root, fixture: setup.fixture, verificationArtifact: setup.v2, verificationArtifactV3: setup.v3, dispositionLedger: output }), /disposition_source_blob_mismatch/);
});

test('immutable catalogs pin exact Plan026, Plan026a, and Plan027 owner families', () => {
  const root = process.cwd(), dir = path.join(root, 'testing/fixtures/managed');
  const catalog = JSON.parse(fs.readFileSync(path.join(dir, 'egress-verification-v3-660e7fe.json'), 'utf8'));
  const history = JSON.parse(fs.readFileSync(path.join(dir, 'egress-baseline-660e7fe.json'), 'utf8'));
  const expected = {
    '026': ['57fb99c67310c1334f9b016234f7d65244c03489d5a304a2d088a22b3f60e3ac', '311da6389b1aa32cbe8fce290f6b956af0e211eb3b6d1a8cee41258ff3507e8b', 'dda453d9ade64b48094d472c49e10fd4ee9dad69e0325d734b2032f49f0ee7ea', 'da80787fe53b4f97c534232be1cfe997790e90a3a748fa76e9dc09145bff9d52', '15b027bd438d0f31ceb07f00eedabeb0c0800f0e0b312e76fb0266281004242d', '0ce1fe1a1041e495c6d6b622637f5f2e0bf440ae012cd8bd2b3d8730022c8ab2', '304e94c1aff53a8ee25b1a5bef13fb0f8564dc317b24b78057e209a5dad2cd8b', '3743b1227037ae49c976456378edd725bf99ba03610439e28d9d2198f520b1ac', '4f8c8b7764e1519c4ca8c7e1345620f807759bb8f9ba61ba5fc9501d0e5488d9', '59c931221bd69aa1c7dff035db9ddcbd4bd4e9b70826f311dcd904773ac27b87', 'cc540427a09601815f5e2850891d1a5097365fe11876a7b349af90e0b9dcdc23', '793ec3029011f74af6cd745fcfb05b0fff310cddedb92ef6929416f7fd1ed731', '5aa5299fe30525a0fce478b06d13187919a3473b27fad411740a74f55e7ed2dc', '6981b82e72bbf600394383f7ab11727845e4507627cc3e4d315ee0824f4754ce', '2dba1e76a832bc0e067d1526b8a573dc2568ea7202f5f8358b18bcf76c4dad4b', '380a6afef4612ce4f2ba962c69b3ac4628cd0b8734f27dbf1eb1a63a9849edec', '565bb258942178f9e8df5a4890522d3804d65aa9a73c52aba50d6de3f5c660f8', '234f94e92812cd883bd99f4f11d0c13b1b595471d30808fa035c81f6d37fb9fd', 'ee4e36b5b65b017f818e8a80a91fea62cea8815b43bd27ecbc2f592801c23d60'],
    '026a': ['a5e5c87851ed958329c32f7133e6bc21d1a6c155b20e54d44179340bda617184', '0789977141c851ed35bb679c0216896cbed4b6f4a233f7eb30856ba57c473623', '709f90369877b1c33e2ffe27b7c486dde3c0cb4fc4efd1c0478701c970d855f8', 'ebb4d691ea0286f8c725b85c40f051d791888d0a894cd45624c749dc0d46a9da', '1c71307d89a776132f269e75c330cff4be84a8255102bab1dff1cbd66a9b4e93'],
    '027': ['7f43aec1faa1a2fade716a85d86d85355caa5fa12f701c10a7fa53e43184bb5d', '5d0adf88620f850aa4e0abb2759fbbc444f5f6bfeabc9e70ecc0bdd23c2d6c66', '2fca44e549dee18aa18e9131fc599851d7506bc97ef441aeaf17feb817dbe4cc', '2e9fab54cfc30c79d5a79ccbd00fa734346650d920d61e05ebf866d2cab564f0']
  };
  for (const [owner, ids] of Object.entries(expected)) assert.deepEqual(catalog.records.filter(record => record.ownerPlan === owner).map(record => record.historicalRecordId), ids);
  assert.deepEqual(history.records.filter(record => record.ownerPlan === '027' && record.currentStatus === 'removed').map(record => record.id), ['0e3a37394a2336510cf44b0a68e8390cadd30baed8c60d00c0330df904412c83', 'd2eeae8c21b74093ab1f046e6146aafb331186c27bac4b2bdb2e5a15256ed90f', '68361bb04bf9daeda7bc7e40165c7a7ea659e1856f26331d638086b0677ef3f7']);
  assert.equal(history.records.filter(record => ['026', '026a'].includes(record.ownerPlan) && record.currentStatus === 'removed').length, 0);
});

test('bounded Plan027 staged-tree CLI transition self-verifies four removals', () => {
  const sourceRoot = process.cwd(), source = Array.from({ length: 4 }, (_, index) => `fetch("https://example.invalid/${index}");`).join('\n') + '\n';
  const setup = transitionRepo('src/mcp/client.ts', source), records = JSON.parse(fs.readFileSync(setup.v3, 'utf8')).records;
  assert.equal(records.length, 4); assert.ok(records.every(record => record.ownerPlan === '027'));
  fs.writeFileSync(path.join(setup.root, setup.file), 'export const removed = true;\n'); execFileSync('git', ['add', setup.file], { cwd: setup.root });
  const output = path.join(setup.root, 'ledger-027.json'); const cliArgs = [path.join(sourceRoot, 'scripts/network-egress-inventory.mjs'), 'transition', '--to', 'removed', '--owner-plan', '027', '--fixture', setup.fixture, '--verification-artifact', setup.v2, '--verification-artifact-v3', setup.v3, '--disposition-ledger', setup.ledger, '--predecessor-source-tree', setup.tree, '--predecessor-ledger-blob', setup.ledgerBlob, '--predecessor-ledger-sha256', setup.ledgerSha, '--predecessor-transition-count', '0', '--predecessor-final-transition-hash', 'NONE', '--output', output, ...records.flatMap(record => ['--record-id', record.historicalRecordId])]; execFileSync(process.execPath, cliArgs, { cwd: setup.root, stdio: 'pipe' }); const next = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(next.transitions.length, 4);
  const checked = verifyDispositionLedger({ root: setup.root, fixture: setup.fixture, verificationArtifact: setup.v2, verificationArtifactV3: setup.v3, dispositionLedger: output }); assert.equal([...checked.effective.values()].filter(record => record.ownerPlan === '027' && record.effectiveStatus === 'removed').length, 4);
});

test('CLI transition failure preserves an existing output and removes its temporary file', () => {
  const sourceRoot = process.cwd(), setup = transitionRepo('src/mcp/client.ts', 'fetch("https://example.invalid");\n'), records = JSON.parse(fs.readFileSync(setup.v3, 'utf8')).records;
  fs.writeFileSync(path.join(setup.root, setup.file), 'export const removed = true;\n'); execFileSync('git', ['add', setup.file], { cwd: setup.root });
  const output = path.join(setup.root, 'existing.json'), sentinel = 'keep-existing-output\n', wrongV2 = path.join(setup.root, 'wrong-v2.json'); fs.writeFileSync(output, sentinel); fs.writeFileSync(wrongV2, `${fs.readFileSync(setup.v2, 'utf8')} `);
  const cliArgs = [path.join(sourceRoot, 'scripts/network-egress-inventory.mjs'), 'transition', '--to', 'removed', '--owner-plan', '027', '--fixture', setup.fixture, '--verification-artifact', wrongV2, '--verification-artifact-v3', setup.v3, '--disposition-ledger', setup.ledger, '--predecessor-source-tree', setup.tree, '--predecessor-ledger-blob', setup.ledgerBlob, '--predecessor-ledger-sha256', setup.ledgerSha, '--predecessor-transition-count', '0', '--predecessor-final-transition-hash', 'NONE', '--output', output, ...records.flatMap(record => ['--record-id', record.historicalRecordId])];
  assert.throws(() => execFileSync(process.execPath, cliArgs, { cwd: setup.root, encoding: 'utf8', stdio: 'pipe' }), /disposition_anchor_mismatch/);
  assert.equal(fs.readFileSync(output, 'utf8'), sentinel);
  assert.deepEqual(fs.readdirSync(setup.root).filter(name => name.startsWith(`${path.basename(output)}.tmp-`)), []);
});

test('analyzer-v2 success text does not claim the disposition ledger is empty', () => {
  const source = fs.readFileSync(new URL('./network-egress-inventory.mjs', import.meta.url), 'utf8');
  assert.match(source, /semantic v2 companion, and disposition ledger verified/);
  assert.doesNotMatch(source, /empty disposition ledger verified/);
});

test('default disposition discovery resolves the exact sibling ledger', () => {
  const root = process.cwd(), fixture = path.join(root, 'testing/fixtures/managed/egress-baseline-660e7fe.json');
  const verificationArtifact = path.join(root, 'testing/fixtures/managed/egress-verification-v2-660e7fe.json');
  const verificationArtifactV3 = path.join(root, 'testing/fixtures/managed/egress-verification-v3-660e7fe.json');
  const ledger = path.join(root, 'testing/fixtures/managed/egress-dispositions-v1-660e7fe.json');
  assert.equal(defaultDispositionLedgerPath(fixture), ledger);
  const automatic = verifyDispositionLedger({ root, fixture, verificationArtifact, verificationArtifactV3 });
  const explicit = verifyDispositionLedger({ root, fixture, verificationArtifact, verificationArtifactV3, dispositionLedger: ledger });
  assert.deepEqual([...automatic.effective.values()], [...explicit.effective.values()]);
});

test('generation is deterministic', () => {
  const root = repo({ 'src/b.ts': 'fetch("https://b.invalid");\n', 'src/a.ts': 'fetch("https://a.invalid");\n' });
  const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.deepEqual(generateInventory({ root, ref }), generateInventory({ root, ref }));
});
