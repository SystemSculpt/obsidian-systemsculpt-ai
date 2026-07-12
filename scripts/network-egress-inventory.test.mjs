import assert from 'node:assert/strict';
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
  fs.writeFileSync(path.join(root, 'src/client.ts'), original.replace('base + "/v1"', 'base + "/v2"'));
  assert.throws(verify, /arguments_changed/);
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

test('generation is deterministic', () => {
  const root = repo({ 'src/b.ts': 'fetch("https://b.invalid");\n', 'src/a.ts': 'fetch("https://a.invalid");\n' });
  const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.deepEqual(generateInventory({ root, ref }), generateInventory({ root, ref }));
});
