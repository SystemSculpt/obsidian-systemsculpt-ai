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
const IMMUTABLE_BASELINE_REF = '660e7fe';
const IMMUTABLE_HISTORY_BLOB = 'cb3ee69ab4f7b42cef1f2aa8546e830a3fefa664';
const IMMUTABLE_HISTORY_SHA256 = 'f2d8a626080e6e474852fa6951a2e0c76d4ef8dd1798eaf5809ac089db6c1b1f';
const FROZEN_APPROVED_SOURCE_COMMIT = 'c4f81ebc35aa836f787f198b8341d9496bc367ba';
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
function semanticOccurrences(file, source, checker, programSourceFile, semanticBindings = new Map()) {
  const kind = file.endsWith('x') ? ts.ScriptKind.TSX : file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = programSourceFile || ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  if (sf.parseDiagnostics.length) throw new Error(`${file}:1:1 resolution_ambiguous: parser recovery is forbidden`);
  const { aliases, imports } = collectBindings(sf);
  const occurrences = [];
  const hazards = [];
  const direct = new Map();
  const calls = [];
  const ast = node => printed(node, sf);
  const portablePath = name => { const normalized = name.replaceAll(path.sep, '/'); const marker = normalized.lastIndexOf('/src/'); return marker >= 0 ? normalized.slice(marker + 1) : normalized; };
  const resolveSymbol = (node, strict = true) => {
    if (!checker) return { symbol: undefined, chain: [] };
    let symbol = checker.getSymbolAtLocation(node);
    const chain = [];
    const seen = new Set();
    while (symbol && (symbol.flags & ts.SymbolFlags.Alias)) {
      if (seen.has(symbol)) throw new Error(`${file}:1:1 resolution_ambiguous: cyclic alias resolution; remove the cycle`);
      seen.add(symbol);
      const declaration = symbol.declarations?.[0];
      if (!declaration) throw new Error(`${file}:1:1 resolution_ambiguous: alias has no declaration; use a static import`);
      const declarationFile = portablePath(declaration.getSourceFile().fileName);
      const moduleNode = declaration.parent?.parent?.parent?.moduleSpecifier || declaration.parent?.parent?.moduleSpecifier || declaration.parent?.moduleSpecifier;
      const moduleName = ts.isStringLiteralLike(moduleNode) ? moduleNode.text : declarationFile;
      chain.push({ fromPath: declarationFile, exportedName: symbol.name, importedName: declaration.propertyName?.text || declaration.name?.text || symbol.name, toPath: moduleName, declarationFingerprint: canonicalHash({ kind: ts.SyntaxKind[declaration.kind], text: printed(declaration, declaration.getSourceFile()) }) });
      symbol = checker.getAliasedSymbol(symbol);
      if (chain.length > 64) throw new Error(`${file}:1:1 resolution_ambiguous: import chain truncated; simplify the chain`);
    }
    return { symbol, chain };
  };
  const importFor = node => resolveSymbol(node).chain;
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
    const resolutionNode = ts.isCallExpression(node) || ts.isNewExpression(node) ? (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression) ? node.expression.name || node.expression.argumentExpression : node.expression) : node.name || node;
    const resolved = resolveSymbol(resolutionNode);
    const chain = importFor(resolutionNode);
    const declarations = resolved.symbol?.declarations || [];
    const declarationShape = d => {
      if (ts.isFunctionLike(d)) return { name: d.name?.getText(d.getSourceFile()) || '<anonymous>', parameters: d.parameters.map(p => printed(p, d.getSourceFile())), type: d.type ? printed(d.type, d.getSourceFile()) : null };
      return { text: printed(d, d.getSourceFile()) };
    };
    const binding = declarations.length ? canonicalHash(declarations.map(d => ({ path: portablePath(d.getSourceFile().fileName), kind: ts.SyntaxKind[d.kind], ...declarationShape(d) }))) : chain[0]?.declarationFingerprint || canonicalHash({ symbol: occurrence.localSymbol, declaration: normalizedCallee });
    const dependencySeen = new Set();
    const dependencies = [];
    const collectDependency = (dependencyNode, depth = 0) => {
      if (!checker || depth > 32) { if (depth > 32) throw new Error(`${file}:1:1 resolution_ambiguous: destination dependency graph truncated; simplify the expression`); return; }
      if (ts.isIdentifier(dependencyNode)) {
        const symbol = checker.getSymbolAtLocation(dependencyNode);
        for (const declaration of symbol?.declarations || []) {
          const key = `${portablePath(declaration.getSourceFile().fileName)}:${declaration.pos}:${declaration.end}`;
          if (dependencySeen.has(key)) continue;
          dependencySeen.add(key);
          if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
            dependencies.push({ path: portablePath(declaration.getSourceFile().fileName), symbol: dependencyNode.text, expression: printed(declaration.initializer, declaration.getSourceFile()) });
            ts.forEachChild(declaration.initializer, child => collectDependency(child, depth + 1));
          }
          if (ts.isPropertyDeclaration(declaration) && declaration.initializer) dependencies.push({ path: portablePath(declaration.getSourceFile().fileName), symbol: dependencyNode.text, expression: printed(declaration.initializer, declaration.getSourceFile()) });
        }
      }
      ts.forEachChild(dependencyNode, child => collectDependency(child, depth + 1));
    };
    for (const argument of args) collectDependency(argument);
    dependencies.sort((a, b) => canonical(a).localeCompare(canonical(b), 'en'));
    const destination = canonicalHash({ arguments: normalizedArguments, dependencies });
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
  const transportNames = new Set(['fetch', 'requestUrl', 'httpRequest', 'request', 'get', 'connect', 'WebSocket', 'XMLHttpRequest']);
  const unmistakableTransportNames = new Set(['fetch', 'requestUrl', 'httpRequest', 'WebSocket', 'XMLHttpRequest']);
  const hazard = (node, reason) => { const lc = lineColumn(sf, node.getStart(sf)); hazards.push(`${file}:${lc.line}:${lc.column} dynamic_or_computed_access: ${reason}; replace it with a statically resolved transport binding`); };
  const constantString = (node, seen = new Set()) => {
    if (!node) return undefined;
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isParenthesizedExpression(node)) return constantString(node.expression, seen);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = constantString(node.left, seen); const right = constantString(node.right, seen);
      return left === undefined || right === undefined ? undefined : left + right;
    }
    if (ts.isTemplateExpression(node)) {
      let value = node.head.text;
      for (const span of node.templateSpans) { const expression = constantString(span.expression, seen); if (expression === undefined) return undefined; value += expression + span.literal.text; }
      return value;
    }
    if (ts.isIdentifier(node) && checker) {
      const symbol = checker.getSymbolAtLocation(node);
      if (!symbol || seen.has(symbol)) return undefined;
      const next = new Set(seen); next.add(symbol);
      const declaration = [...(symbol.declarations || []), ...(symbol.valueDeclaration ? [symbol.valueDeclaration] : [])].find(d => ts.isVariableDeclaration(d) && d.initializer);
      return declaration ? constantString(declaration.initializer, next) : undefined;
    }
    return undefined;
  };
  const visit = (node, stack = []) => {
    let next = stack;
    if (ts.isElementAccessExpression(node)) {
      const key = ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : '<computed>';
      const base = node.expression.getText(sf);
      const baseAlias = ts.isIdentifier(node.expression) ? aliases.get(node.expression.text) : undefined;
      const foldedKey = constantString(node.argumentExpression);
      const computedTransport = foldedKey !== undefined && transportNames.has(foldedKey);
      const receiverSymbol = ts.isIdentifier(node.expression) ? checker?.getSymbolAtLocation(node.expression) : undefined;
      const receiverIsLocallyDeclared = receiverSymbol?.declarations?.some(declaration => declaration.getSourceFile() === sf);
      const globalReceiver = /^(?:globalThis|window|self|global)$/.test(base) && !receiverIsLocallyDeclared;
      const networkReceiver = baseAlias && (SDK_PACKAGES.test(baseAlias.module) || NODE_NETWORK.has(baseAlias.module));
      if (unmistakableTransportNames.has(key) || (globalReceiver && (!ts.isStringLiteralLike(node.argumentExpression) || computedTransport)) || (networkReceiver && (!ts.isStringLiteralLike(node.argumentExpression) || transportNames.has(key)))) hazard(node, `computed transport member ${base}[${foldedKey || key}]`);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && (!node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0]))) hazard(node, 'dynamic import specifier');
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require' && (!node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0]))) hazard(node, 'dynamic require specifier');
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['eval', 'Function'].includes(node.expression.text)) hazard(node, `${node.expression.text} dispatch`);
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') hazard(node, 'Function constructor dispatch');

    if (ts.isFunctionLike(node)) next = [...stack, node];
    if (ts.isCallExpression(node)) {
      const expressionText = node.expression.getText(sf);
      if (ts.isElementAccessExpression(node.expression) || (ts.isCallExpression(node.expression) && ts.isElementAccessExpression(node.expression.expression))) {
        const base = ts.isElementAccessExpression(node.expression) ? node.expression.expression : node.expression.expression.expression;
        const symbol = checker?.getSymbolAtLocation(base);
        const registry = symbol?.declarations?.find(d => ts.isVariableDeclaration(d) && d.initializer && ts.isObjectLiteralExpression(d.initializer));
        if (registry?.initializer.properties.some(property => /\b(?:fetch|requestUrl|httpRequest|WebSocket|XMLHttpRequest)\b/.test(property.getText(registry.getSourceFile())))) hazard(node, `registry transport dispatch ${expressionText}`);
      }
      if (ts.isIdentifier(node.expression) && checker) {
        const symbol = checker.getSymbolAtLocation(node.expression);
        const binding = symbol?.declarations?.find(d => ts.isBindingElement(d));
        const bindingInitializer = binding?.parent?.parent?.initializer;
        if (bindingInitializer && ts.isObjectLiteralExpression(bindingInitializer) && /\b(?:fetch|requestUrl|httpRequest|WebSocket|XMLHttpRequest)\b/.test(bindingInitializer.getText(bindingInitializer.getSourceFile()))) hazard(node, `destructured registry transport dispatch ${expressionText}`);
        if (symbol?.declarations?.some(d => ts.isParameter(d))) {
          const parameter = symbol.declarations.find(d => ts.isParameter(d));
          const fn = parameter.parent;
          const fnName = fn.name && ts.isIdentifier(fn.name) ? fn.name.text : null;
          if (fnName && new RegExp(`\\b${fnName}\\s*\\(\\s*(?:fetch|requestUrl|httpRequest)\\b`).test(source)) throw new Error(`${file}:${lineColumn(sf, node.getStart(sf)).line}:${lineColumn(sf, node.getStart(sf)).column} resolution_ambiguous: unresolved higher-order transport parameter; call a statically resolved transport`);
        }
      }
      if (ts.isCallExpression(node.expression)) {
        const factoryLookup = ts.isPropertyAccessExpression(node.expression.expression) ? node.expression.expression.name : node.expression.expression;
        const factorySymbol = checker?.getSymbolAtLocation(factoryLookup);
        const returnsTransport = factorySymbol?.declarations?.some(declaration => {
          let found = false;
          const inspect = child => { if (ts.isReturnStatement(child) && child.expression && /\b(?:fetch|requestUrl|httpRequest)\b/.test(child.expression.getText(child.getSourceFile()))) found = true; ts.forEachChild(child, inspect); };
          inspect(declaration); return found;
        });
        if (returnsTransport) throw new Error(`${file}:${lineColumn(sf, node.getStart(sf)).line}:${lineColumn(sf, node.getStart(sf)).column} resolution_ambiguous: returned factory transport dispatch; bind a statically resolved transport`);
      }
      calls.push({ node, stack: next });
      if (ts.isIdentifier(node.expression)) {
        const invokedAlias = aliases.get(node.expression.text);
        if (node.expression.text !== invokedAlias?.imported && invokedAlias?.module === 'globalThis' && invokedAlias.imported === 'fetch') hazard(node, 'aliased global fetch invocation');
      }
      let primitive = primitiveForCall(node, aliases);
      if (!primitive && checker) {
        const lookup = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
        const resolvedCall = resolveSymbol(lookup, false);
        const modules = resolvedCall.chain.map(hop => hop.toPath);
        const resolvedName = resolvedCall.symbol?.name || (ts.isIdentifier(lookup) ? lookup.text : lookup.getText(sf));
        const semanticBinding = semanticBindings.get(`${file}|${ts.isIdentifier(lookup) ? lookup.text : resolvedName}`);
        if ((resolvedName === 'requestUrl' && modules.includes('obsidian')) || (semanticBinding?.module === 'obsidian' && semanticBinding.imported === 'requestUrl')) primitive = 'obsidian.requestUrl';
        else if (resolvedName === 'fetch' && modules.some(module => /globalThis|lib\.dom/.test(module))) primitive = 'fetch';
        else {
          const networkModule = modules.find(module => NODE_NETWORK.has(module));
          if (networkModule && transportNames.has(resolvedName)) primitive = `${networkModule}.${resolvedName}`;
        }
      }
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
  if (hazards.length) throw new Error(hazards.join('\n'));
  return occurrences.sort((a, b) => compareRecords(a, b));
}
function semanticTree(root, mode, ref) {
  const files = mode === 'source-ref' ? baselineFiles(root, ref) : mode === 'index' ? indexFiles(root) : worktreeFiles(root);
  const sources = new Map(files.map(file => [path.resolve(root, file), sourceFor(root, mode, ref, file)]));
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true, skipLibCheck: true, noResolve: false };
  const base = ts.createCompilerHost(options, true);
  const host = {
    ...base,
    fileExists(name) {
      const resolved = path.resolve(name);
      if (resolved.startsWith(`${path.resolve(root, 'src')}${path.sep}`)) return sources.has(resolved);
      return sources.has(resolved) || base.fileExists(name);
    },
    readFile(name) {
      const resolved = path.resolve(name);
      if (resolved.startsWith(`${path.resolve(root, 'src')}${path.sep}`)) return sources.get(resolved);
      return sources.get(resolved) ?? base.readFile(name);
    },
    getSourceFile(name, languageVersion) {
      const resolved = path.resolve(name);
      const text = sources.get(resolved);
      if (text !== undefined) return ts.createSourceFile(resolved, text, languageVersion, true, name.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      if (resolved.startsWith(`${path.resolve(root, 'src')}${path.sep}`)) return undefined;
      return base.getSourceFile(name, languageVersion);
    },
    writeFile() {}
  };
  const program = ts.createProgram([...sources.keys()], options, host);
  const syntactic = program.getSyntacticDiagnostics().filter(d => sources.has(path.resolve(d.file?.fileName || '')));
  if (syntactic.length) {
    const d = syntactic[0]; const sf = d.file; const lc = sf && d.start !== undefined ? lineColumn(sf, d.start) : { line: 1, column: 1 };
    throw new Error(`${sf?.fileName || '<source>'}:${lc.line}:${lc.column} resolution_ambiguous: parser recovery is forbidden; fix the syntax`);
  }
  const checker = program.getTypeChecker();
  const rawBindings = new Map();
  const resolveModulePath = (fromFile, specifier) => {
    if (!specifier.startsWith('.')) return specifier;
    const basePath = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
    return files.find(candidate => candidate === basePath || candidate === `${basePath}.ts` || candidate === `${basePath}.tsx` || candidate === `${basePath}/index.ts`) || specifier;
  };
  for (const file of files) {
    const sf = program.getSourceFile(path.resolve(root, file));
    for (const statement of sf.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
        for (const element of statement.importClause.namedBindings.elements) rawBindings.set(`${file}|${element.name.text}`, { module: resolveModulePath(file, statement.moduleSpecifier.text), imported: element.propertyName?.text || element.name.text });
      }
      if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) rawBindings.set(`${file}|${element.name.text}`, { module: resolveModulePath(file, statement.moduleSpecifier.text), imported: element.propertyName?.text || element.name.text });
      }
    }
  }
  const semanticBindings = new Map();
  const resolveBinding = (file, name, trail = new Set()) => {
    const key = `${file}|${name}`;
    if (trail.has(key)) throw new Error(`${file}:1:1 resolution_ambiguous: cyclic import/re-export chain; remove the cycle`);
    const binding = rawBindings.get(key);
    if (!binding) return undefined;
    if (!binding.module.startsWith('src/')) return binding;
    const nextTrail = new Set(trail); nextTrail.add(key);
    return resolveBinding(binding.module, binding.imported, nextTrail) || binding;
  };
  for (const key of rawBindings.keys()) { const separator = key.lastIndexOf('|'); const resolved = resolveBinding(key.slice(0, separator), key.slice(separator + 1)); if (resolved) semanticBindings.set(key, resolved); }
  const occurrences = files.flatMap(file => {
    const absolute = path.resolve(root, file);
    return semanticOccurrences(file, sources.get(absolute), checker, program.getSourceFile(absolute), semanticBindings);
  }).sort(compareRecords);
  const portable = name => { const normalized = name.replaceAll(path.sep, '/'); const marker = normalized.lastIndexOf('/src/'); return marker >= 0 ? normalized.slice(marker + 1) : normalized; };
  const resolvedSymbol = node => {
    let symbol = checker.getSymbolAtLocation(node);
    const seen = new Set();
    while (symbol && (symbol.flags & ts.SymbolFlags.Alias)) {
      if (seen.has(symbol)) throw new Error(`${portable(node.getSourceFile().fileName)}:1:1 resolution_ambiguous: cyclic call alias; remove the cycle`);
      seen.add(symbol); symbol = checker.getAliasedSymbol(symbol);
    }
    return symbol;
  };
  const declarationKey = declaration => {
    let owner = declaration.parent;
    while (owner && !ts.isClassLike(owner) && !ts.isFunctionLike(owner)) owner = owner.parent;
    const ownerName = ts.isClassLike(owner) ? owner.name?.getText(owner.getSourceFile()) || '<anonymous-class>' : '<module>';
    const declaredName = declaration.name?.getText(declaration.getSourceFile()) || declaration.parent?.name?.getText?.(declaration.getSourceFile()) || '<anonymous>';
    return `${portable(declaration.getSourceFile().fileName)}|${ownerName}.${declaredName}`;
  };
  const callers = new Map();
  for (const file of files) {
    const sf = program.getSourceFile(path.resolve(root, file));
    const visit = node => {
      if (ts.isCallExpression(node)) {
        const lookup = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
        const symbol = resolvedSymbol(lookup);
        for (const declaration of symbol?.declarations || []) {
          if (!ts.isFunctionLike(declaration)) continue;
          const key = declarationKey(declaration);
          let parent = node.parent; while (parent && !ts.isFunctionLike(parent)) parent = parent.parent;
          const caller = parent && ts.isFunctionLike(parent) ? declarationKey(parent) : `${file}|<module>`;
          const edge = { path: file, symbol: caller, callFingerprint: canonicalHash({ target: key, call: printed(node, sf) }) };
          if (!callers.has(key)) callers.set(key, []);
          callers.get(key).push(edge);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  for (const occurrence of occurrences) {
    if (occurrence.classification !== 'wrapper_boundary' || !occurrence.primitiveOrImport.startsWith('wrapper:')) continue;
    const sf = program.getSourceFile(path.resolve(root, occurrence.path));
    const declarations = [];
    const find = node => {
      if (ts.isFunctionLike(node)) {
        const declaredName = node.name?.getText(sf) || node.parent?.name?.getText?.(sf) || '<anonymous>';
        if (declaredName === occurrence.occurrence.localSymbol || (occurrence.occurrence.localSymbol === '<anonymous>' && lineColumn(sf, node.getStart(sf)).line === occurrence.sourceSpan.startLine)) declarations.push(node);
      }
      ts.forEachChild(node, find);
    };
    find(sf);
    const declaration = declarations.find(item => lineColumn(sf, item.getStart(sf)).line === occurrence.sourceSpan.startLine);
    if (!declaration) throw new Error(`${occurrence.path}:1:1 resolution_ambiguous: wrapper declaration ${occurrence.occurrence.localSymbol}@${occurrence.sourceSpan.startLine} is unresolved; use an exact static wrapper`);
    const key = declarationKey(declaration);
    const walk = (key, trail = new Set()) => {
      if (trail.has(key)) return [];
      if (trail.size > 64) throw new Error(`${occurrence.path}:1:1 resolution_ambiguous: wrapper call graph truncated; simplify the chain`);
      const edges = (callers.get(key) || []).sort((a, b) => canonical(a).localeCompare(canonical(b), 'en'));
      if (!edges.length) return [[]];
      const nextTrail = new Set(trail); nextTrail.add(key);
      const chains = edges.flatMap(edge => edge.symbol.endsWith('|<module>') ? [[edge]] : walk(edge.symbol, nextTrail).map(rest => [edge, ...rest]));
      if (!chains.length) return [];
      const shortest = Math.min(...chains.map(chain => chain.length));
      return chains.filter(chain => chain.length === shortest).sort((a, b) => canonical(a).localeCompare(canonical(b), 'en'));
    };
    const shortestChains = walk(key);
    if (!shortestChains.length && (callers.get(key) || []).length) throw new Error(`${occurrence.path}:1:1 resolution_ambiguous: cyclic wrapper call graph has no exact terminating chain; break the cycle`);
    occurrence.provenance.wrapperCallChain = [...occurrence.provenance.wrapperCallChain, ...shortestChains.flat()];
    occurrence.provenance.semanticCallChainFingerprint = canonicalHash({ classification: occurrence.classification, primitive: occurrence.primitiveOrImport, occurrence: occurrence.occurrence.minimalOccurrenceFingerprint, binding: occurrence.provenance.bindingDeclarationFingerprint, importChain: occurrence.provenance.resolvedImportChain, wrapperCallChain: occurrence.provenance.wrapperCallChain, destination: occurrence.provenance.destinationExpressionFingerprint });
  }
  return occurrences;
}
function mappingKey(record) { return `${record.path}|${record.classification}|${record.primitiveOrImport}`; }
export function defaultDispositionLedgerPath(fixturePath) {
  const suffix = path.basename(fixturePath).match(/^egress-baseline-(.+)\.json$/)?.[1] || IMMUTABLE_BASELINE_REF;
  return path.join(path.dirname(fixturePath), `egress-dispositions-v1-${suffix}.json`);
}
function artifactPath(root, file) { return path.relative(root, path.resolve(file)).replaceAll(path.sep, '/'); }
function exactKeys(value, expected, category, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || canonical(Object.keys(value).sort()) !== canonical([...expected].sort())) throw new Error(`${category}: ${label} has malformed fields; restore the reviewed disposition ledger`);
}
export function loadAndValidateDispositionLedger({ dispositionLedger } = {}) {
  let ledger;
  try { ledger = JSON.parse(fs.readFileSync(dispositionLedger, 'utf8')); }
  catch { throw new Error(`disposition_history_tampered: ${dispositionLedger} is missing or malformed JSON; restore the reviewed disposition ledger`); }
  exactKeys(ledger, ['schemaVersion', 'ledgerVersion', 'historicalFixture', 'semanticCatalog', 'transitions'], 'disposition_history_tampered', 'ledger');
  exactKeys(ledger.historicalFixture, ['path', 'gitBlob', 'sha256'], 'disposition_history_tampered', 'historicalFixture');
  exactKeys(ledger.semanticCatalog, ['path', 'gitBlob', 'sha256', 'mappingCount', 'mappingSha256'], 'disposition_history_tampered', 'semanticCatalog');
  if (ledger.schemaVersion !== 1 || ledger.ledgerVersion !== 'network-egress-dispositions-v1') throw new Error('disposition_history_tampered: unsupported disposition schemaVersion or ledgerVersion; restore the version 1 ledger');
  if (!Array.isArray(ledger.transitions)) throw new Error('disposition_history_tampered: transitions must be an array; restore the reviewed disposition ledger');
  if (ledger.transitions.length) throw new Error('disposition_transition_unsupported: this Plan025b core checkpoint accepts only an empty transition ledger; use the reviewed transition-generator checkpoint');
  return ledger;
}
export function validateDispositionAnchors({ root = process.cwd(), fixture, verificationArtifact, ledger }) {
  const historicalBytes = fs.readFileSync(fixture);
  const catalogBytes = fs.readFileSync(verificationArtifact);
  const catalog = JSON.parse(catalogBytes);
  const expectedHistorical = { path: artifactPath(root, fixture), gitBlob: git(root, ['hash-object', fixture]).trim(), sha256: hash(historicalBytes) };
  const expectedCatalog = { path: artifactPath(root, verificationArtifact), gitBlob: git(root, ['hash-object', verificationArtifact]).trim(), sha256: hash(catalogBytes), mappingCount: catalog.records?.length, mappingSha256: canonicalHash(catalog.records) };
  if (canonical(ledger.historicalFixture) !== canonical(expectedHistorical)) throw new Error(`disposition_anchor_mismatch: historical fixture anchor differs from ${expectedHistorical.path}; restore the reviewed ledger`);
  if (canonical(ledger.semanticCatalog) !== canonical(expectedCatalog)) throw new Error(`disposition_anchor_mismatch: semantic catalog anchor differs from ${expectedCatalog.path}; restore the reviewed ledger`);
  return { historical: JSON.parse(historicalBytes), catalog };
}
export function buildEffectiveDispositionMap({ historical, catalog, ledger }) {
  if (ledger.transitions.length) throw new Error('disposition_transition_unsupported: this Plan025b core checkpoint accepts only an empty transition ledger; use the reviewed transition-generator checkpoint');
  const identity = record => `${record.id || record.historicalRecordId}|${record.origin || record.historicalOrigin}|${record.occurrenceIdentity || record.historicalOccurrenceIdentity}`;
  const mappings = new Map();
  for (const mapped of catalog.records || []) {
    const key = identity(mapped);
    if (mappings.has(key)) throw new Error(`disposition_mapping_mismatch: duplicate v2 mapping for ${mapped.historicalRecordId}; restore the reviewed semantic catalog`);
    mappings.set(key, mapped);
  }
  const records = (historical.records || []).map(record => {
    const key = identity(record);
    const mapped = mappings.get(key);
    if (record.currentStatus === 'removed') {
      if (mapped) throw new Error(`disposition_mapping_mismatch: historical removed record ${record.id} has a v2 mapping; restore the reviewed artifacts`);
      return { historicalRecordId: record.id, historicalOccurrenceIdentity: record.occurrenceIdentity, ownerPlan: record.ownerPlan, effectiveStatus: 'historical_removed' };
    }
    if (record.currentStatus !== 'present' || !mapped) throw new Error(`disposition_mapping_mismatch: present historical record ${record.id} requires exactly one v2 mapping; restore the reviewed artifacts`);
    mappings.delete(key);
    return { historicalRecordId: record.id, historicalOccurrenceIdentity: record.occurrenceIdentity, v2OccurrenceId: mapped.v2OccurrenceId, ownerPlan: record.ownerPlan, effectiveStatus: 'present' };
  });
  if (mappings.size) throw new Error(`disposition_mapping_mismatch: semantic catalog contains ${mappings.size} unknown historical mappings; restore the reviewed artifacts`);
  return new Map(records.map(record => [`${record.historicalRecordId}|${record.historicalOccurrenceIdentity}`, record]));
}
export function verifyDispositionLedger({ root = process.cwd(), fixture, verificationArtifact, dispositionLedger = defaultDispositionLedgerPath(fixture) } = {}) {
  const ledger = loadAndValidateDispositionLedger({ dispositionLedger });
  const { historical, catalog } = validateDispositionAnchors({ root, fixture, verificationArtifact, ledger });
  const effective = buildEffectiveDispositionMap({ historical, catalog, ledger });
  return { transitions: ledger.transitions.length, records: effective.size, effective };
}
export function effectiveDisposition({ root = process.cwd(), fixture, verificationArtifact, dispositionLedger = defaultDispositionLedgerPath(fixture), sourceRef } = {}) {
  verifyVerificationV2({ root, fixture, verificationArtifact, sourceRef });
  const result = verifyDispositionLedger({ root, fixture, verificationArtifact, dispositionLedger });
  return { records: [...result.effective.values()] };
}
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
  const historyById = new Map(present.map(record => [record.id, record]));
  for (const mapped of artifact.records) {
    const record = historyById.get(mapped.historicalRecordId);
    if (!record || mapped.historicalOrigin !== record.origin || mapped.historicalOccurrenceIdentity !== record.occurrenceIdentity || mapped.path !== record.path || mapped.classification !== record.classification || mapped.primitiveOrImport !== record.primitiveOrImport) throw new Error(`history_tampered: ${mapped.historicalRecordId} companion mapping disagrees with immutable historical identity; restore the reviewed companion`);
  }
  if (artifact.records.length !== present.length || new Set(artifact.records.map(r => r.historicalRecordId)).size !== artifact.records.length) throw new Error('mapping_count_mismatch: regenerate and review the complete v2 companion');
  const errors = [];
  const states = sourceRef ? [['source-ref', semanticTree(root, 'source-ref', sourceRef)]] : [['index', semanticTree(root, 'index')], ['worktree', semanticTree(root, 'worktree')]];
  for (const [state, live] of states) {
    const groups = new Map(); for (const item of live) { const key = mappingKey(item); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item); }
    const approvedKeys = new Set(artifact.records.map(mappingKey));
    for (const item of live) if (!approvedKeys.has(mappingKey(item))) errors.push(`${state} ${item.path}:${item.sourceSpan.startLine}:${item.sourceSpan.startColumn} unreviewed_occurrence ${item.primitiveOrImport} (${item.classification}): semantic occurrence is absent from the companion; remove it or review a new historical mapping`);
    for (const expected of artifact.records) {
      const history = present.find(r => r.id === expected.historicalRecordId && r.origin === expected.historicalOrigin);
      if (!history) { errors.push(`${state} history_tampered ${expected.historicalRecordId}: mapping points to removed or unknown history; remove the fabricated mapping`); continue; }
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
      if (!actual || expected.occurrence.minimalOccurrenceFingerprint !== actual.occurrence.minimalOccurrenceFingerprint || expected.provenance.semanticCallChainFingerprint !== actual.provenance.semanticCallChainFingerprint) errors.push(`${state} ${actual?.path || expected.path}:${actual?.sourceSpan.startLine || history.sourceSpan.startLine}:${actual?.sourceSpan.startColumn || history.sourceSpan.startColumn} ${expected.historicalRecordId} owner ${history.ownerPlan} ${expected.primitiveOrImport} (${expected.classification}) ${category}: observed ${String(actualId).slice(0, 12)} expected ${expected.v2OccurrenceId.slice(0, 12)}; restore the approved semantic occurrence or regenerate the companion through review`);
      const expectedCount = artifact.records.filter(r => mappingKey(r) === mappingKey(expected)).length;
      if (candidates.length !== expectedCount && expected.occurrenceOrdinal === 0) errors.push(`${state} ${expected.path}:${history.sourceSpan.startLine}:${history.sourceSpan.startColumn} ${expected.historicalRecordId} owner ${history.ownerPlan} ${expected.primitiveOrImport} (${expected.classification}) occurrence_count_changed: observed ${candidates.length} expected ${expectedCount}; remove the duplicate or restore the missing occurrence`);
    }
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
  const companion = value('--verification-artifact') || (fixture ? path.join(path.dirname(fixture), `egress-verification-v2-${path.basename(fixture).match(/egress-baseline-(.+)\.json$/)?.[1] || IMMUTABLE_BASELINE_REF}.json`) : undefined);
  const dispositionLedger = value('--disposition-ledger') || (fixture ? defaultDispositionLedgerPath(fixture) : undefined);
  const assertDefaultTrustBoundary = () => {
    if (value('--ref') && value('--ref') !== IMMUTABLE_BASELINE_REF) throw new Error(`history_tampered: default verification pins --ref ${IMMUTABLE_BASELINE_REF}; use --analyzer-version 1 for archaeology`);
    const bytes = fs.readFileSync(fixture);
    if (hash(bytes) !== IMMUTABLE_HISTORY_SHA256 || git(root, ['hash-object', fixture]).trim() !== IMMUTABLE_HISTORY_BLOB) throw new Error('history_tampered: restore the immutable Plan 025 fixture bytes');
  };
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
      assertDefaultTrustBoundary();
      if (!fs.existsSync(companion)) throw new Error(`verification_companion_missing: create ${companion}; refusing silent v1 fallback`);
      if (!fs.existsSync(dispositionLedger)) throw new Error(`disposition_history_tampered: create ${dispositionLedger}; refusing silent disposition fallback`);
      effectiveDisposition({ root, fixture, verificationArtifact: companion, dispositionLedger, sourceRef: value('--source-ref') });
    }
    console.log('[egress] PASS: live production inventory matches reviewed fixture');
  } else if (command === 'verify') {
    if (analyzerVersion === '1') {
      const actual = Buffer.from(stableJson(generateInventory({ root, ref: value('--ref') || '660e7fe', sourceRef: value('--source-ref') })));
      const expected = fs.readFileSync(fixture);
      if (!actual.equals(expected)) throw new Error(`history_tampered: historical fixture differs from deterministic v1 regeneration; restore ${fixture}`);
      console.log('[egress] PASS: historical v1 fixture is byte-identical');
    } else {
      assertDefaultTrustBoundary();
      if (value('--source-ref') && value('--source-ref') !== FROZEN_APPROVED_SOURCE_COMMIT) throw new Error('history_tampered: default verify rejects caller source-ref overrides; use --analyzer-version 1 for archaeology');
      const historicalRegeneration = Buffer.from(stableJson(generateInventory({ root, ref: IMMUTABLE_BASELINE_REF, sourceRef: '98a67bf8a2778248f4b76262448b1a3a23c649f2' })));
      if (!historicalRegeneration.equals(fs.readFileSync(fixture))) throw new Error(`history_tampered: v1 fixture is not the deterministic Plan 025 record; restore ${fixture}`);
      if (!fs.existsSync(companion)) throw new Error(`verification_companion_missing: create ${companion}; refusing silent v1 fallback`);
      const artifact = JSON.parse(fs.readFileSync(companion, 'utf8'));
      if (artifact.approvedSource?.commit !== FROZEN_APPROVED_SOURCE_COMMIT) throw new Error(`history_tampered: companion approvedSource.commit must be ${FROZEN_APPROVED_SOURCE_COMMIT}; restore the reviewed companion`);
      const sourceRef = FROZEN_APPROVED_SOURCE_COMMIT;
      const actual = Buffer.from(stableJson(generateVerificationV2({ root, fixture, sourceRef, historicalFixturePath: path.relative(root, fixture).replaceAll(path.sep, '/') })));
      const expected = fs.readFileSync(companion);
      if (!actual.equals(expected)) throw new Error(`occurrence_changed: v2 companion differs from approved-source regeneration; review ${companion}`);
      verifyVerificationV2({ root, fixture, verificationArtifact: companion, sourceRef });
      if (!fs.existsSync(dispositionLedger)) throw new Error(`disposition_history_tampered: create ${dispositionLedger}; refusing silent disposition fallback`);
      verifyDispositionLedger({ root, fixture, verificationArtifact: companion, dispositionLedger });
      console.log('[egress] PASS: historical v1 bytes, semantic v2 companion, and empty disposition ledger verified');
    }
  } else throw new Error(`unknown command: ${command}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) cli().catch(error => { console.error(`[egress] FAIL: ${error.message}`); process.exit(1); });
