#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/;
const EXCLUDED = /(?:^|\/)(?:__tests__|fixtures|generated)(?:\/|$)|\.(?:test|spec|d)\.[cm]?[jt]sx?$/;
const SDK_PACKAGES = /^(?:openai|@anthropic-ai\/sdk|@openai\/codex(?:-sdk)?|@mariozechner\/(?:pi-ai|pi-coding-agent)|@google\/generative-ai|cohere-ai|groq-sdk|@xenova\/transformers)(?:\/|$)/;
const NODE_NETWORK = new Set(['http', 'https', 'net', 'tls', 'dns', 'node:http', 'node:https', 'node:net', 'node:tls', 'node:dns']);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const normalize = value => String(value).replace(/\s+/g, ' ').trim();
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const isProductionPath = file => file.startsWith('src/') && EXTENSIONS.test(file) && !EXCLUDED.test(file);

function baselineFiles(root, ref) {
  return git(root, ['ls-tree', '-r', '--name-only', ref, '--', 'src']).split('\n').filter(isProductionPath).sort();
}
function indexFiles(root) {
  return git(root, ['ls-files', '--cached', '--', 'src']).split('\n').filter(isProductionPath).sort();
}
function worktreeFiles(root) {
  const tracked = git(root, ['ls-files', '--cached', '--', 'src']).split('\n');
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '--', 'src']).split('\n');
  return [...new Set([...tracked, ...untracked].filter(Boolean))].filter(isProductionPath).filter(file => fs.existsSync(path.join(root, file))).sort();
}
function sourceFor(root, mode, ref, file) {
  if (mode === 'baseline') return git(root, ['show', `${ref}:${file}`]);
  if (mode === 'index') return git(root, ['show', `:${file}`]);
  return fs.readFileSync(path.join(root, file), 'utf8');
}
function lineColumn(sf, pos) {
  const lc = sf.getLineAndCharacterOfPosition(pos);
  return { line: lc.line + 1, column: lc.character + 1 };
}
function span(sf, node) {
  const start = lineColumn(sf, node.getStart(sf));
  const end = lineColumn(sf, node.getEnd());
  return { startLine: start.line, startColumn: start.column, endLine: end.line, endColumn: end.column };
}
function enclosingStatement(node) {
  let current = node;
  while (current.parent && !ts.isStatement(current) && !ts.isImportDeclaration(current) && !ts.isVariableDeclaration(current)) current = current.parent;
  return current;
}
function destinationClass(text) {
  const value = text.toLowerCase();
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/.test(value)) return 'loopback_outbound';
  if (/systemsculpt|systemsculpt\.com/.test(value)) return 'systemsculpt';
  if (/https?:\/\//.test(value)) return 'third_party';
  if (/settings|config|endpoint|baseurl|url\b|host\b/.test(value)) return 'user_configured';
  return 'computed_or_unknown';
}
function ownerFor(file, primitive, text) {
  const p = file.toLowerCase();
  const t = text.toLowerCase();
  if (p.includes('platformrequestclient') || p.includes('managed-capability')) return '016';
  if (p.includes('remoteconfig')) return '017';
  if (p.includes('licenseservice') || p.endsWith('/httpclient.ts')) return '031';
  if (p.includes('readwise')) return '026a';
  if (p.includes('/mcp/') && /http|request|fetch/.test(primitive.toLowerCase())) return '027';
  if (p.includes('studio') && /http request|httprequestnode|http-node/.test(`${p} ${t}`)) return '027a';
  if (p.includes('studio')) return '023';
  if (p.includes('youtube')) return '026';
  if (p.includes('transcri') || p.includes('audio')) return '020';
  if (p.includes('document') || p.includes('uploadjob') || p.includes('upload-service')) return '021';
  if (p.includes('embedding')) return p.includes('local') ? '031' : '018';
  if (p.includes('research') || p.includes('changelog') || p.includes('version')) return '026';
  if (p.includes('provider') || p.includes('/pi/') || SDK_PACKAGES.test(primitive) || p.includes('image')) return '031';
  if (p.includes('systemsculptservice')) {
    const identity = `${primitive} ${t}`.toLowerCase();
    if (/wrapper:(?:generate.*workflow|post.?process|generate.*purpose)/.test(identity)) return '022';
    if (/wrapper:(?:stream|chat|complete)/.test(identity)) return '017';
    return '031';
  }
  if (p.includes('chat') || p.includes('stream')) return '017';
  return '031';
}
function dispositionFor(file, primitive) {
  return file.includes('PlatformRequestClient') && /requestUrl|fetch|httpRequest/.test(primitive) ? 'approved_core' : 'temporary';
}
function collectBindings(sf) {
  const aliases = new Map();
  const imports = [];
  const visit = node => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const module = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause?.name) aliases.set(clause.name.text, { module, imported: 'default' });
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) aliases.set(clause.namedBindings.name.text, { module, imported: '*' });
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const el of clause.namedBindings.elements) aliases.set(el.name.text, { module, imported: el.propertyName?.text || el.name.text });
      imports.push({ node, module, typeOnly: Boolean(clause?.isTypeOnly) });
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isIdentifier(node.initializer) && aliases.has(node.initializer.text)) aliases.set(node.name.text, aliases.get(node.initializer.text));
      if (ts.isIdentifier(node.initializer) && node.initializer.text === 'fetch') aliases.set(node.name.text, { module: 'globalThis', imported: 'fetch' });
      if (ts.isPropertyAccessExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)) aliases.set(node.name.text, { module: aliases.get(node.initializer.expression.text)?.module || node.initializer.expression.text, imported: node.initializer.name.text });
      if (ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === 'require' && ts.isStringLiteral(node.initializer.arguments[0])) aliases.set(node.name.text, { module: node.initializer.arguments[0].text, imported: '*' });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { aliases, imports };
}
function primitiveForCall(node, aliases) {
  const expr = node.expression;
  if (ts.isIdentifier(expr)) {
    const alias = aliases.get(expr.text);
    if (expr.text === 'fetch') return 'fetch';
    if (['requestUrl', 'httpRequest'].includes(expr.text)) return expr.text === 'requestUrl' ? 'obsidian.requestUrl' : 'project.httpRequest';
    if (alias?.module === 'globalThis' && alias.imported === 'fetch') return 'fetch';
    if (alias?.module === 'obsidian' && alias.imported === 'requestUrl') return 'obsidian.requestUrl';
    if (alias && NODE_NETWORK.has(alias.module) && ['request','get','connect','createConnection','lookup','resolve','resolve4','resolve6','resolveAny','resolveCname','resolveMx','resolveNaptr','resolveNs','resolvePtr','resolveSoa','resolveSrv','resolveTxt','reverse'].includes(alias.imported)) return `${alias.module}.${alias.imported}`;
  }
  if (ts.isPropertyAccessExpression(expr)) {
    const base = expr.expression.getText();
    const name = expr.name.text;
    const alias = ts.isIdentifier(expr.expression) ? aliases.get(expr.expression.text) : undefined;
    const module = alias?.module || base;
    if (NODE_NETWORK.has(module) && ['request','get','connect','createConnection','lookup','resolve','resolve4','resolve6','resolveAny','resolveCname','resolveMx','resolveNaptr','resolveNs','resolvePtr','resolveSoa','resolveSrv','resolveTxt','reverse'].includes(name)) return `${module}.${name}`;
    if (name === 'requestUrl') return 'obsidian.requestUrl';
    if (name === 'httpRequest') return 'project.httpRequest';
    if (name === 'fetch') return 'fetch';
  }
  if (ts.isElementAccessExpression(expr) && ts.isStringLiteralLike(expr.argumentExpression)) {
    const name = expr.argumentExpression.text;
    const alias = ts.isIdentifier(expr.expression) ? aliases.get(expr.expression.text) : undefined;
    if (alias && NODE_NETWORK.has(alias.module)) return `${alias.module}.${name}`;
  }
  return null;
}
function analyzeSource(file, source) {
  const kind = file.endsWith('x') ? ts.ScriptKind.TSX : file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const { aliases, imports } = collectBindings(sf);
  const findings = [];
  const add = (node, primitive, classification, evidence = {}) => {
    const statement = enclosingStatement(node);
    const sourceSpan = span(sf, node);
    const statementText = normalize(statement.getText(sf));
    const symbol = primitive;
    const id = hash(`${file}|${node.kind}|${symbol}|${sourceSpan.startLine}:${sourceSpan.startColumn}-${sourceSpan.endLine}:${sourceSpan.endColumn}`);
    findings.push({ id, path: file, sourceSpan, lineFingerprint: hash(statementText), primitiveOrImport: primitive, classification, destinationClass: destinationClass(node.getText(sf)), baselineDisposition: dispositionFor(file, primitive), ownerPlan: ownerFor(file, primitive, statementText), evidence: { binding: evidence.binding || primitive, destinationFingerprint: hash(normalize(node.getText(sf))) } });
  };
  for (const item of imports) if (!item.typeOnly && SDK_PACKAGES.test(item.module)) add(item.node, item.module, 'sdk_runtime', { binding: item.module });
  const directSinkFunctions = new Map();
  const callSites = [];
  const visit = (node, functionStack = []) => {
    let stack = functionStack;
    if (ts.isFunctionLike(node)) stack = [...functionStack, node];
    if (ts.isCallExpression(node)) {
      callSites.push({ node, stack });
      const primitive = primitiveForCall(node, aliases);
      if (primitive) {
        add(node, primitive, 'outbound_sink');
        for (const fn of stack.slice(-1)) directSinkFunctions.set(fn, primitive);
      }
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0]) && SDK_PACKAGES.test(node.arguments[0].text)) add(node, node.arguments[0].text, 'sdk_runtime');
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require' && ts.isStringLiteral(node.arguments[0]) && SDK_PACKAGES.test(node.arguments[0].text)) add(node, node.arguments[0].text, 'sdk_runtime');
      if (ts.isIdentifier(node.expression)) {
        const alias = aliases.get(node.expression.text);
        if (alias && SDK_PACKAGES.test(alias.module)) add(node, `${alias.module}:${alias.imported}`, 'sdk_runtime');
      }
    }
    if (ts.isNewExpression(node)) {
      const name = node.expression.getText(sf);
      if (name === 'WebSocket' || name === 'XMLHttpRequest') add(node, name, 'outbound_sink');
      const first = name.split('.')[0];
      const alias = aliases.get(first);
      if (alias && SDK_PACKAGES.test(alias.module)) add(node, `${alias.module}:${name}`, 'sdk_runtime');
    }
    ts.forEachChild(node, child => visit(child, stack));
  };
  visit(sf);
  const wrapperNames = new Map();
  for (const [fn, primitive] of directSinkFunctions) {
    const name = fn.name?.getText(sf) || '<anonymous>';
    add(fn, `wrapper:${name}->${primitive}`, 'wrapper_boundary', { binding: name });
    if (name !== '<anonymous>') wrapperNames.set(name, primitive);
  }
  for (const { node, stack } of callSites) {
    const expression = node.expression;
    const name = ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : null;
    if (!name || !wrapperNames.has(name) || stack.some(fn => fn.name?.getText(sf) === name)) continue;
    add(node, `wrapper-call:${name}->${wrapperNames.get(name)}`, 'wrapper_boundary', { binding: name });
  }
  const unique = new Map(findings.map(record => [record.id, record]));
  return [...unique.values()];
}
function analyzeTree(root, mode, ref) {
  const files = mode === 'baseline' ? baselineFiles(root, ref) : mode === 'index' ? indexFiles(root) : worktreeFiles(root);
  return assignOccurrences(files.flatMap(file => analyzeSource(file, sourceFor(root, mode, ref, file))).sort(compareRecords));
}
function compareRecords(a, b) { return a.path.localeCompare(b.path, 'en') || a.sourceSpan.startLine - b.sourceSpan.startLine || a.sourceSpan.startColumn - b.sourceSpan.startColumn || a.primitiveOrImport.localeCompare(b.primitiveOrImport, 'en'); }
function semanticKey(record) { return `${record.path}|${record.classification}|${record.primitiveOrImport}|${record.lineFingerprint}`; }
function occurrenceKey(record) { return `${semanticKey(record)}|${record.occurrenceIndex}`; }
function assignOccurrences(records) {
  const counts = new Map();
  return records.map(record => {
    const key = semanticKey(record);
    const occurrenceIndex = counts.get(key) || 0;
    counts.set(key, occurrenceIndex + 1);
    return { ...record, occurrenceIndex, occurrenceIdentity: hash(`${key}|${occurrenceIndex}`) };
  });
}
function stateMap(records) { return new Map(records.map(record => [occurrenceKey(record), record])); }
function withStates(record, states) {
  return { ...record, currentStatus: states.length ? 'present' : 'removed', evidence: { ...record.evidence, states } };
}
export function generateInventory({ root = process.cwd(), ref = '660e7fe' } = {}) {
  const baseline = analyzeTree(root, 'baseline', ref);
  const currentStates = { index: analyzeTree(root, 'index', ref), worktree: analyzeTree(root, 'worktree', ref) };
  const stateMaps = Object.fromEntries(Object.entries(currentStates).map(([state, records]) => [state, stateMap(records)]));
  const baselineKeys = new Set(baseline.map(occurrenceKey));
  const records = baseline.map(record => withStates({ ...record, origin: 'baseline' }, Object.keys(currentStates).filter(state => stateMaps[state].has(occurrenceKey(record)))));
  const additions = new Map();
  for (const [state, stateRecords] of Object.entries(currentStates)) {
    for (const record of stateRecords) {
      const key = occurrenceKey(record);
      if (baselineKeys.has(key)) continue;
      const existing = additions.get(key);
      if (existing) existing.evidence.states.push(state);
      else additions.set(key, withStates({ ...record, origin: 'reviewed_current_addition' }, [state]));
    }
  }
  records.push(...additions.values());
  records.sort(compareRecords);
  return { schemaVersion: 1, baselineRef: ref, productionRoots: ['src'], records, nonEgressEvidence: [] };
}
export function verifyCurrent({ root = process.cwd(), fixture }) {
  const expected = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  const actualStates = { index: analyzeTree(root, 'index', expected.baselineRef), worktree: analyzeTree(root, 'worktree', expected.baselineRef) };
  const errors = [];
  if (!Array.isArray(expected.records)) errors.push('fixture records must be an array');
  for (const r of expected.records || []) {
    if (/[*?]|\/$/.test(r.path) || !r.sourceSpan) errors.push(`${r.path}: wildcard/path allowlists are forbidden`);
    if (!/^0(?:16|17|18|20|21|22|23|26|26a|27|27a|30|31)$/.test(String(r.ownerPlan))) errors.push(`${r.path}:${r.sourceSpan?.startLine || 1}:${r.sourceSpan?.startColumn || 1} ${r.primitiveOrImport}: missing or invalid owner ${r.ownerPlan || '<none>'}`);
    if (r.baselineDisposition === 'approved_core' && !r.path.includes('PlatformRequestClient')) errors.push(`${r.path}:${r.sourceSpan.startLine}:${r.sourceSpan.startColumn} ${r.primitiveOrImport}: approved_core outside PlatformRequestClient`);
  }
  for (const [state, actual] of Object.entries(actualStates)) {
    const present = new Map((expected.records || []).filter(r => r.currentStatus === 'present' && r.evidence?.states?.includes(state)).map(r => [occurrenceKey(r), r]));
    const actualKeys = new Set(actual.map(occurrenceKey));
    for (const r of actual) {
      const key = occurrenceKey(r);
      if (!present.has(key)) errors.push(`${state} ${r.path}:${r.sourceSpan.startLine}:${r.sourceSpan.startColumn} ${r.primitiveOrImport} (${r.classification}, ${r.destinationClass}) occurrence ${r.occurrenceIndex}: unreviewed live primitive ${r.id}; nearest record: none; owner ${r.ownerPlan}`);
    }
    for (const [key, r] of present) if (!actualKeys.has(key)) errors.push(`${state} ${r.path}:${r.sourceSpan.startLine}:${r.sourceSpan.startColumn} ${r.primitiveOrImport} occurrence ${r.occurrenceIndex}: stale present record ${r.id}; owner ${r.ownerPlan}`);
  }
  const baselineApprovedIdentities = new Set((expected.records || []).filter(r => r.origin === 'baseline' && r.baselineDisposition === 'approved_core' && r.classification === 'outbound_sink').map(r => `${r.path}|${r.primitiveOrImport}`));
  const unreviewedApprovedSinks = (expected.records || []).filter(r => r.currentStatus === 'present' && r.origin === 'reviewed_current_addition' && r.baselineDisposition === 'approved_core' && r.classification === 'outbound_sink' && !baselineApprovedIdentities.has(`${r.path}|${r.primitiveOrImport}`));
  if (unreviewedApprovedSinks.length > 0) errors.push(`Plan 016 second approved-core sink detected: ${unreviewedApprovedSinks.map(r => `${r.path}:${r.sourceSpan.startLine}`).join(', ')}`);
  if (errors.length) throw new Error(errors.join('\n'));
  return { records: Object.values(actualStates).reduce((sum, records) => sum + records.length, 0) };
}
function stableJson(value) { return `${JSON.stringify(value, null, 2)}\n`; }
async function cli() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) return;
  const value = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const root = process.cwd();
  if (command === 'baseline') {
    const output = value('--output');
    if (!output) throw new Error('--output is required');
    fs.writeFileSync(output, stableJson(generateInventory({ root, ref: value('--ref') || '660e7fe' })));
  } else if (command === 'current') {
    const fixture = value('--fixture');
    verifyCurrent({ root, fixture });
    console.log('[egress] PASS: live production inventory matches reviewed fixture');
  } else if (command === 'verify') {
    const fixture = value('--fixture');
    const temp = path.join(os.tmpdir(), `egress-${process.pid}.json`);
    fs.writeFileSync(temp, stableJson(generateInventory({ root, ref: value('--ref') || '660e7fe' })));
    const actual = fs.readFileSync(temp);
    const expected = fs.readFileSync(fixture);
    fs.rmSync(temp, { force: true });
    if (!actual.equals(expected)) throw new Error(`baseline fixture drift: regenerate ${fixture}`);
    verifyCurrent({ root, fixture });
    console.log('[egress] PASS: baseline deterministic and current inventory reviewed');
  } else throw new Error(`unknown command: ${command}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) cli().catch(error => { console.error(`[egress] FAIL: ${error.message}`); process.exit(1); });
