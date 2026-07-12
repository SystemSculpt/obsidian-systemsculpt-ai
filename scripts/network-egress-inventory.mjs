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
  if (mode === 'baseline' || mode === 'source-ref') return git(root, ['show', `${ref}:${file}`]);
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
  const files = mode === 'baseline' || mode === 'source-ref' ? baselineFiles(root, ref) : mode === 'index' ? indexFiles(root) : worktreeFiles(root);
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
export function generateInventory({ root = process.cwd(), ref = '660e7fe', sourceRef } = {}) {
  const baseline = analyzeTree(root, 'baseline', ref);
  const currentStates = sourceRef
    ? { index: analyzeTree(root, 'source-ref', sourceRef), worktree: analyzeTree(root, 'source-ref', sourceRef) }
    : { index: analyzeTree(root, 'index', ref), worktree: analyzeTree(root, 'worktree', ref) };
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
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function canonicalHash(value) { return hash(canonical(value)); }
function printed(node, sf) {
  return normalize(ts.createPrinter({ removeComments: true }).printNode(ts.EmitHint.Unspecified, node, sf));
}
function containingSymbol(node, sf) {
  let current = node.parent;
  while (current) {
    if ((ts.isFunctionLike(current) || ts.isClassLike(current)) && current.name) return current.name.getText(sf);
    current = current.parent;
  }
  return '<module>';
}
function semanticOccurrences(file, source) {
  const kind = file.endsWith('x') ? ts.ScriptKind.TSX : file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  if (sf.parseDiagnostics.length) throw new Error(`${file}:1:1 resolution_ambiguous: parser recovery is forbidden`);
  const { aliases, imports } = collectBindings(sf);
  const occurrences = [];
  const direct = new Map();
  const calls = [];
  const ast = node => printed(node, sf);
  const importFor = primitive => {
    const module = primitive.startsWith('obsidian.') ? 'obsidian' : primitive.startsWith('node:') ? primitive.split('.').shift() : SDK_PACKAGES.test(primitive) ? primitive.split(':')[0] : null;
    const item = imports.find(entry => entry.module === module);
    if (!item) return [];
    return [{ fromPath: file, exportedName: module, importedName: primitive.split('.').at(-1), toPath: module, declarationFingerprint: canonicalHash({ kind: 'ImportDeclaration', text: ast(item.node) }) }];
  };
  const add = (node, primitive, classification, extra = {}) => {
    const expression = ts.isCallExpression(node) || ts.isNewExpression(node) ? node.expression : node;
    const args = ts.isCallExpression(node) || ts.isNewExpression(node) ? [...(node.arguments || [])] : [];
    const normalizedCallee = extra.wrapperEdge ? canonical(extra.wrapperEdge) : ast(expression);
    const normalizedArguments = extra.wrapperEdge ? [canonical(extra.wrapperEdge)] : args.map(ast);
    const exact = { astKind: ts.SyntaxKind[node.kind], localSymbol: extra.localSymbol || normalizedCallee, normalizedCallee, normalizedArguments };
    const occurrence = {
      astKind: exact.astKind,
      containingSymbol: containingSymbol(node, sf),
      localSymbol: exact.localSymbol,
      normalizedCallee,
      normalizedArguments,
      minimalOccurrenceFingerprint: canonicalHash(exact)
    };
    const chain = importFor(primitive.replace(/^wrapper(?:-call)?:[^>]+->/, ''));
    const binding = chain[0]?.declarationFingerprint || canonicalHash({ symbol: occurrence.localSymbol, declaration: normalizedCallee });
    const destination = canonicalHash({ arguments: normalizedArguments });
    const wrapperCallChain = extra.wrapperEdge ? [{ path: file, symbol: extra.localSymbol, callFingerprint: canonicalHash(extra.wrapperEdge) }] : [];
    const provenance = {
      bindingDeclarationFingerprint: binding,
      resolvedImportChain: chain,
      wrapperCallChain,
      destinationExpressionFingerprint: destination
    };
    provenance.semanticCallChainFingerprint = canonicalHash({ classification, primitive, occurrence: occurrence.minimalOccurrenceFingerprint, binding, importChain: chain, wrapperCallChain, destination });
    occurrences.push({ path: file, classification, primitiveOrImport: primitive, occurrence, provenance, sourceSpan: span(sf, node) });
  };
  for (const item of imports) if (!item.typeOnly && SDK_PACKAGES.test(item.module)) add(item.node, item.module, 'sdk_runtime', { localSymbol: item.module });
  const visit = (node, stack = []) => {
    let next = stack;
    if (ts.isFunctionLike(node)) next = [...stack, node];
    if (ts.isCallExpression(node)) {
      calls.push({ node, stack: next });
      const primitive = primitiveForCall(node, aliases);
      if (primitive) {
        add(node, primitive, 'outbound_sink');
        const fn = next.at(-1);
        if (fn) direct.set(fn, { primitive, call: node });
      }
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0]) && SDK_PACKAGES.test(node.arguments[0].text)) add(node, node.arguments[0].text, 'sdk_runtime');
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require' && ts.isStringLiteral(node.arguments[0]) && SDK_PACKAGES.test(node.arguments[0].text)) add(node, node.arguments[0].text, 'sdk_runtime');
      if (ts.isIdentifier(node.expression)) { const alias = aliases.get(node.expression.text); if (alias && SDK_PACKAGES.test(alias.module)) add(node, `${alias.module}:${alias.imported}`, 'sdk_runtime'); }
    }
    if (ts.isNewExpression(node)) {
      const name = node.expression.getText(sf);
      if (name === 'WebSocket' || name === 'XMLHttpRequest') add(node, name, 'outbound_sink');
      const alias = aliases.get(name.split('.')[0]);
      if (alias && SDK_PACKAGES.test(alias.module)) add(node, `${alias.module}:${name}`, 'sdk_runtime');
    }
    ts.forEachChild(node, child => visit(child, next));
  };
  visit(sf);
  const wrapperNames = new Map();
  for (const [fn, edge] of direct) {
    const name = fn.name?.getText(sf) || '<anonymous>';
    const signature = { kind: ts.SyntaxKind[fn.kind], name, parameters: fn.parameters.map(p => ast(p)), type: fn.type ? ast(fn.type) : null, edge: ast(edge.call) };
    add(fn, `wrapper:${name}->${edge.primitive}`, 'wrapper_boundary', { localSymbol: name, wrapperEdge: signature });
    if (name !== '<anonymous>') wrapperNames.set(name, edge.primitive);
  }
  for (const { node, stack } of calls) {
    const expression = node.expression;
    const name = ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : null;
    if (!name || !wrapperNames.has(name) || stack.some(fn => fn.name?.getText(sf) === name)) continue;
    add(node, `wrapper-call:${name}->${wrapperNames.get(name)}`, 'wrapper_boundary', { localSymbol: name, wrapperEdge: { caller: containingSymbol(node, sf), call: ast(node) } });
  }
  return occurrences.sort((a, b) => compareRecords(a, b));
}
function semanticTree(root, mode, ref) {
  const files = mode === 'source-ref' ? baselineFiles(root, ref) : worktreeFiles(root);
  return files.flatMap(file => semanticOccurrences(file, sourceFor(root, mode, ref, file))).sort(compareRecords);
}
function mappingKey(record) { return `${record.path}|${record.classification}|${record.primitiveOrImport}`; }
export function generateVerificationV2({ root = process.cwd(), fixture, sourceRef, historicalFixturePath } = {}) {
  const historicalBytes = fs.readFileSync(fixture);
  const historical = JSON.parse(historicalBytes);
  const present = historical.records.filter(record => record.currentStatus === 'present');
  const occurrences = semanticTree(root, sourceRef ? 'source-ref' : 'worktree', sourceRef);
  const groups = new Map();
  for (const occurrence of occurrences) { const key = mappingKey(occurrence); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(occurrence); }
  const used = new Map();
  const records = present.map(record => {
    const key = mappingKey(record);
    const ordinal = used.get(key) || 0;
    used.set(key, ordinal + 1);
    const candidates = groups.get(key) || [];
    if (ordinal >= candidates.length) throw new Error(`${record.path}:${record.sourceSpan.startLine}:${record.sourceSpan.startColumn} ${record.id} owner ${record.ownerPlan} occurrence_missing: no exact semantic occurrence; restore the approved source or update the v2 companion through review`);
    const match = candidates[ordinal];
    const mapped = { historicalRecordId: record.id, historicalOrigin: record.origin, historicalOccurrenceIdentity: record.occurrenceIdentity, path: record.path, classification: record.classification, primitiveOrImport: record.primitiveOrImport, occurrenceOrdinal: ordinal, occurrence: match.occurrence, provenance: match.provenance };
    return { ...mapped, v2OccurrenceId: hash(`network-egress-occurrence-v2\0${canonical(mapped)}`) };
  });
  for (const [key, candidates] of groups) if ((used.get(key) || 0) !== candidates.length) throw new Error(`${candidates[used.get(key) || 0]?.path || key}:1:1 occurrence_count_changed: unreviewed semantic occurrence; review and regenerate the companion`);
  return {
    schemaVersion: 2,
    analyzerVersion: 'network-egress-occurrence-v2',
    historicalFixture: { path: historicalFixturePath || path.relative(root, fixture).replaceAll(path.sep, '/'), gitBlob: git(root, ['hash-object', fixture]).trim(), sha256: hash(historicalBytes) },
    approvedSource: { commit: sourceRef || git(root, ['rev-parse', 'HEAD']).trim(), productionRoots: ['src'] },
    records
  };
}
function diagnosticCategory(expected, actual) {
  if (!actual) return 'occurrence_missing';
  if (expected.occurrence.normalizedCallee !== actual.occurrence.normalizedCallee) {
    if (expected.classification === 'wrapper_boundary') return 'wrapper_chain_changed';
    return /\[|\?\./.test(actual.occurrence.normalizedCallee) ? 'dynamic_or_computed_access' : 'callee_changed';
  }
  if (canonical(expected.occurrence.normalizedArguments) !== canonical(actual.occurrence.normalizedArguments)) return 'arguments_changed';
  if (expected.provenance.destinationExpressionFingerprint !== actual.provenance.destinationExpressionFingerprint) return 'destination_changed';
  if (canonical(expected.provenance.resolvedImportChain) !== canonical(actual.provenance.resolvedImportChain)) return 'import_chain_changed';
  if (canonical(expected.provenance.wrapperCallChain) !== canonical(actual.provenance.wrapperCallChain)) return 'wrapper_chain_changed';
  return 'occurrence_changed';
}
export function verifyVerificationV2({ root = process.cwd(), fixture, verificationArtifact, sourceRef } = {}) {
  const historicalBytes = fs.readFileSync(fixture);
  const artifact = JSON.parse(fs.readFileSync(verificationArtifact, 'utf8'));
  if (artifact.schemaVersion !== 2 || artifact.analyzerVersion !== 'network-egress-occurrence-v2') throw new Error('unsupported_analyzer_version: migrate the verification companion');
  if (artifact.historicalFixture.sha256 !== hash(historicalBytes) || artifact.historicalFixture.gitBlob !== git(root, ['hash-object', fixture]).trim()) throw new Error('history_tampered: restore the immutable v1 fixture bytes');
  const historical = JSON.parse(historicalBytes);
  const present = historical.records.filter(record => record.currentStatus === 'present');
  if (artifact.records.length !== present.length || new Set(artifact.records.map(r => r.historicalRecordId)).size !== artifact.records.length) throw new Error('mapping_count_mismatch: regenerate and review the complete v2 companion');
  const live = semanticTree(root, sourceRef ? 'source-ref' : 'worktree', sourceRef);
  const groups = new Map(); for (const item of live) { const key = mappingKey(item); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item); }
  const errors = [];
  for (const expected of artifact.records) {
    const history = present.find(r => r.id === expected.historicalRecordId && r.origin === expected.historicalOrigin);
    if (!history) { errors.push(`history_tampered ${expected.historicalRecordId}: mapping points to removed or unknown history; remove the fabricated mapping`); continue; }
    const candidates = groups.get(mappingKey(expected)) || [];
    let actual = candidates[expected.occurrenceOrdinal];
    let forcedCategory;
    if (!actual) {
      const sameLocation = live.filter(item => item.path === expected.path && item.classification === expected.classification);
      actual = sameLocation[expected.occurrenceOrdinal];
      if (actual) forcedCategory = 'callee_changed';
      else if (live.some(item => item.classification === expected.classification && item.primitiveOrImport === expected.primitiveOrImport)) forcedCategory = 'occurrence_moved';
    }
    const category = forcedCategory || diagnosticCategory(expected, actual);
    const actualId = actual ? hash(`network-egress-occurrence-v2\0${canonical({ ...expected, occurrence: actual.occurrence, provenance: actual.provenance, v2OccurrenceId: undefined })}`) : 'missing';
    if (!actual || expected.occurrence.minimalOccurrenceFingerprint !== actual.occurrence.minimalOccurrenceFingerprint || expected.provenance.semanticCallChainFingerprint !== actual.provenance.semanticCallChainFingerprint) errors.push(`${actual?.path || expected.path}:${actual?.sourceSpan.startLine || history.sourceSpan.startLine}:${actual?.sourceSpan.startColumn || history.sourceSpan.startColumn} ${expected.historicalRecordId} owner ${history.ownerPlan} ${expected.primitiveOrImport} (${expected.classification}) ${category}: observed ${String(actualId).slice(0, 12)} expected ${expected.v2OccurrenceId.slice(0, 12)}; restore the approved semantic occurrence or regenerate the companion through review`);
    if (candidates.length !== artifact.records.filter(r => mappingKey(r) === mappingKey(expected)).length && expected.occurrenceOrdinal === 0) errors.push(`${expected.path}:${history.sourceSpan.startLine}:${history.sourceSpan.startColumn} ${expected.historicalRecordId} owner ${history.ownerPlan} ${expected.primitiveOrImport} (${expected.classification}) occurrence_count_changed: observed ${candidates.length} expected ${artifact.records.filter(r => mappingKey(r) === mappingKey(expected)).length}; remove the duplicate or restore the missing occurrence`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return { records: artifact.records.length };
}
function stableJson(value) { return `${JSON.stringify(value, null, 2)}\n`; }
async function cli() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) return;
  const value = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const root = process.cwd();
  const fixture = value('--fixture');
  const analyzerVersion = value('--analyzer-version');
  const companion = value('--verification-artifact') || (fixture ? path.join(path.dirname(fixture), `egress-verification-v2-${path.basename(fixture).match(/egress-baseline-(.+)\.json$/)?.[1] || '660e7fe'}.json`) : undefined);
  if (command === 'baseline') {
    const output = value('--output');
    if (!output) throw new Error('--output is required');
    if (analyzerVersion && analyzerVersion !== '1') throw new Error('unsupported_analyzer_version: baseline archaeology supports analyzer version 1 only');
    fs.writeFileSync(output, stableJson(generateInventory({ root, ref: value('--ref') || '660e7fe', sourceRef: value('--source-ref') })));
  } else if (command === 'verification') {
    const output = value('--output') || companion;
    if (!fixture || !output) throw new Error('--fixture and --output are required');
    fs.writeFileSync(output, stableJson(generateVerificationV2({ root, fixture, sourceRef: value('--source-ref'), historicalFixturePath: path.relative(root, fixture).replaceAll(path.sep, '/') })));
  } else if (command === 'current') {
    if (analyzerVersion === '1') verifyCurrent({ root, fixture });
    else {
      if (!fs.existsSync(companion)) throw new Error(`verification_companion_missing: create ${companion}; refusing silent v1 fallback`);
      verifyVerificationV2({ root, fixture, verificationArtifact: companion, sourceRef: value('--source-ref') });
    }
    console.log('[egress] PASS: live production inventory matches reviewed fixture');
  } else if (command === 'verify') {
    if (analyzerVersion === '1') {
      const actual = Buffer.from(stableJson(generateInventory({ root, ref: value('--ref') || '660e7fe', sourceRef: value('--source-ref') })));
      const expected = fs.readFileSync(fixture);
      if (!actual.equals(expected)) throw new Error(`history_tampered: historical fixture differs from deterministic v1 regeneration; restore ${fixture}`);
      console.log('[egress] PASS: historical v1 fixture is byte-identical');
    } else {
      if (!fs.existsSync(companion)) throw new Error(`verification_companion_missing: create ${companion}; refusing silent v1 fallback`);
      const sourceRef = value('--source-ref') || JSON.parse(fs.readFileSync(companion, 'utf8')).approvedSource.commit;
      const actual = Buffer.from(stableJson(generateVerificationV2({ root, fixture, sourceRef, historicalFixturePath: path.relative(root, fixture).replaceAll(path.sep, '/') })));
      const expected = fs.readFileSync(companion);
      if (!actual.equals(expected)) throw new Error(`occurrence_changed: v2 companion differs from approved-source regeneration; review ${companion}`);
      verifyVerificationV2({ root, fixture, verificationArtifact: companion, sourceRef });
      console.log('[egress] PASS: historical v1 bytes and semantic v2 companion verified');
    }
  } else throw new Error(`unknown command: ${command}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) cli().catch(error => { console.error(`[egress] FAIL: ${error.message}`); process.exit(1); });
