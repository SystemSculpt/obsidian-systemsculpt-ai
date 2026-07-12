import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { generateInventory, generateVerificationV2, verifyCurrent, verifyVerificationV2 } from './network-egress-inventory.mjs';
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

test('default current and verify pin the trust-boundary refs and immutable history', () => {
  const cwd = process.cwd();
  const fixture = 'testing/fixtures/managed/egress-baseline-660e7fe.json';
  for (const args of [
    ['verify', '--ref', 'HEAD', '--fixture', fixture],
    ['verify', '--source-ref', 'HEAD', '--fixture', fixture],
    ['current', '--source-ref', 'HEAD', '--fixture', fixture]
  ]) assert.throws(() => execFileSync(process.execPath, ['scripts/network-egress-inventory.mjs', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }), /history_tampered/);
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

test('generation is deterministic', () => {
  const root = repo({ 'src/b.ts': 'fetch("https://b.invalid");\n', 'src/a.ts': 'fetch("https://a.invalid");\n' });
  const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.deepEqual(generateInventory({ root, ref }), generateInventory({ root, ref }));
});
