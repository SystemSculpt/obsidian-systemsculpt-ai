#!/usr/bin/env node

/**
 * Unified, quiet checker for the Obsidian plugin.
 * - TypeScript typecheck (noEmit)
 * - In-memory esbuild bundle resolution of src/main.ts
 * - Jest unit tests
 * Prints concise summary on success; details only on failure or --verbose.
 */

import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import builtins from "builtin-modules";

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const summary = args.includes('--summary') || args.includes('--quiet');
const skipTests = args.includes('--skip-tests');
const fast = args.includes('--fast');

const defaultTimeoutMs = Number(process.env.SYSTEMSCULPT_CHECK_TIMEOUT_MS || '') || 20 * 60 * 1000;

const root = process.cwd();

function run(cmd, opts = {}) {
  try {
    const started = Date.now();
    const { timeoutMs = defaultTimeoutMs, ...restOpts } = opts;
    const out = execSync(cmd, { encoding: 'utf8', stdio: summary ? 'pipe' : 'pipe', timeout: timeoutMs, ...restOpts });
    return { ok: true, ms: Date.now() - started, stdout: out };
  } catch (e) {
    return { ok: false, ms: 0, stdout: e.stdout?.toString?.() || '', stderr: e.stderr?.toString?.() || '', error: e };
  }
}

function listChangedFiles() {
  const commands = [
    'git diff --name-only --cached --diff-filter=ACMRT',
    'git diff --name-only --diff-filter=ACMRT',
  ];

  for (const cmd of commands) {
    try {
      const out = execSync(cmd, { encoding: 'utf8', stdio: 'pipe', timeout: 10_000 });
      const files = out
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
      if (files.length > 0) return files;
    } catch (_) {
      // Ignore: not in a git repo, or git unavailable, etc.
    }
  }
  return [];
}

async function checkBundle() {
  const entry = path.join(root, 'src', 'main.ts');
  if (!fs.existsSync(entry)) {
    return { ok: true, ms: 0, note: 'no-entry' };
  }
  const started = Date.now();
  const esbuild = await import('esbuild');
  try {
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: 'cjs',
      platform: 'browser',
      target: 'es2018',
      write: false,
      logLevel: 'silent',
      external: [
        'obsidian',
        'electron',
        '@codemirror/autocomplete',
        '@codemirror/collab',
        '@codemirror/commands',
        '@codemirror/language',
        '@codemirror/lint',
        '@codemirror/search',
        '@codemirror/state',
        '@codemirror/view',
        '@lezer/common',
        '@lezer/highlight',
        '@lezer/lr',
        ...builtins,
      ],
      loader: { '.wasm': 'dataurl' },
      treeShaking: true,
    });
    return { ok: true, ms: Date.now() - started };
  } catch (error) {
    const message = error?.message || String(error);
    return { ok: false, ms: Date.now() - started, message };
  }
}

async function main() {
  const results = [];
  const checks = ['tsc', 'bundle'];

  const tsc = run('npx tsc --noEmit --skipLibCheck');
  results.push({ name: 'tsc', ...tsc });

  const bundle = await checkBundle();
  results.push({ name: 'bundle', ...bundle });

  if (!skipTests) {
    checks.push('tests');
    let tests;
    if (fast) {
      const changedFiles = listChangedFiles().filter(file => file.startsWith('src/'));
      if (changedFiles.length === 0) {
        tests = { ok: true, ms: 0, stdout: '' };
      } else {
        const quotedFiles = changedFiles.map(file => JSON.stringify(file)).join(' ');
        const testCmd = `npx jest --config jest.config.cjs --findRelatedTests ${quotedFiles} --passWithNoTests`;
        tests = run(testCmd);
      }
    } else {
      tests = run('npx jest --config jest.config.cjs --runInBand --passWithNoTests');
    }
    results.push({ name: 'tests', ...tests });
  }

  const failed = results.filter(r => !r.ok);

  if (failed.length === 0) {
    const totalMs = results.reduce((s, r) => s + (r.ms || 0), 0);
    const mode = fast ? ' [fast]' : '';
    console.log(`[plugin] PASS${mode}: ${checks.join(', ')} (${Math.round(totalMs/100)/10}s)`);
    process.exit(0);
  }

  for (const r of failed) {
    if (r.name === 'tsc') {
      console.error('[plugin] FAIL: TypeScript errors found');
      if (verbose) {
        console.error(r.stdout || r.stderr || '');
      }
    } else if (r.name === 'bundle') {
      console.error('[plugin] FAIL: Bundle/build check failed');
      if (verbose) {
        console.error(r.message || '');
      }
    } else if (r.name === 'tests') {
      console.error('[plugin] FAIL: Unit tests failed');
      if (verbose) {
        console.error(r.stdout || r.stderr || '');
      }
    }
  }
  process.exit(1);
}

main().catch((e) => {
  console.error('[plugin] FAIL: Unexpected checker error');
  if (verbose) console.error(e);
  process.exit(1);
});
