#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { collectPiRuntimePackageRoots } from './pi-runtime-package-set.mjs';

const usage = () => {
  console.log(`Usage: node scripts/sync-local-vaults.mjs [--config <path>]

Copies the built plugin artifacts (main.js, manifest.json, styles.css, etc.) into
one or more local Obsidian plugin folders. All destinations are defined in the
configuration JSON. If --config is not supplied, the script looks for the path in
SYSTEMSCULPT_SYNC_CONFIG or defaults to ./systemsculpt-sync.config.json.

Options:
  --config, -c <path>      Use a custom sync config JSON file.
  --allow-partial          Exit successfully when at least one target updates,
                           even if other targets fail. This is now the default.
  --strict                 Require every target to sync successfully.
  --help, -h               Show this help text.`);
};

const args = process.argv.slice(2);
let configPathFromArgs = null;
let allowPartial = true;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if ((arg === '--config' || arg === '-c') && i + 1 < args.length) {
    configPathFromArgs = args[i + 1];
    i += 1;
    continue;
  }
  if (arg === '--allow-partial') {
    allowPartial = true;
    continue;
  }
  if (arg === '--strict') {
    allowPartial = false;
    continue;
  }
  if (arg === '--help' || arg === '-h') {
    usage();
    process.exit(0);
  }
}

const defaultConfigPath = path.join(process.cwd(), 'systemsculpt-sync.config.json');
const configPath = configPathFromArgs
  || process.env.SYSTEMSCULPT_SYNC_CONFIG
  || defaultConfigPath;

if (!fs.existsSync(configPath)) {
  console.error(`[sync] Config file not found at ${configPath}. Create one or pass --config.`);
  process.exit(1);
}

const configRaw = fs.readFileSync(configPath, 'utf8');
let config;
try {
  config = JSON.parse(configRaw);
} catch (error) {
  console.error('[sync] Failed to parse config JSON:', error.message || error);
  process.exit(1);
}

const requiredFiles = [
  'manifest.json',
  'main.js',
  'styles.css',
  'studio-terminal-sidecar.cjs',
];
const optionalFiles = ['README.md', 'LICENSE', 'versions.json'];
const runtimePaths = [
  'node_modules/node-pty',
  ...collectPiRuntimePackageRoots({
    rootDir: process.cwd(),
  }).map((entry) => entry.relativePath),
];

const resolvePath = (maybeRelative) => (
  path.isAbsolute(maybeRelative)
    ? maybeRelative
    : path.resolve(process.cwd(), maybeRelative)
);

const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const clearDestinationPath = (targetPath) => {
  fs.rmSync(targetPath, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 150,
  });
};

const copyFile = (file, destDir) => {
  const sourcePath = path.join(process.cwd(), file);
  if (!fs.existsSync(sourcePath)) {
    if (requiredFiles.includes(file)) {
      throw new Error(`Required file missing: ${sourcePath}`);
    }
    return false;
  }
  ensureDir(destDir);
  const destPath = path.join(destDir, path.basename(file));
  fs.copyFileSync(sourcePath, destPath);
  return true;
};

const copyDirectory = (src, dest) => {
  if (!fs.existsSync(src)) {
    console.warn(`[sync] Source directory missing, skipping: ${src}`);
    return;
  }
  const stats = fs.statSync(src);
  if (!stats.isDirectory()) {
    throw new Error(`Expected directory, got file: ${src}`);
  }
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src);
  entries.forEach(entry => {
    if (entry === '.obsidian') {
      return;
    }
    const srcEntry = path.join(src, entry);
    const destEntry = path.join(dest, entry);
    const entryStats = fs.statSync(srcEntry);
    if (entryStats.isDirectory()) {
      copyDirectory(srcEntry, destEntry);
    } else {
      fs.copyFileSync(srcEntry, destEntry);
    }
  });
};

const syncTarget = (target) => {
  if (!target || typeof target.path !== 'string') {
    return {
      ok: false,
      path: '',
      error: new Error('Invalid target entry (missing path).'),
    };
  }
  const targetPath = resolvePath(target.path);
  try {
    ensureDir(targetPath);
    console.log(`[sync] Updating ${targetPath}`);
    requiredFiles.concat(optionalFiles).forEach(file => {
      copyFile(file, targetPath);
    });

    runtimePaths.forEach(relativeRuntimePath => {
      const sourcePath = path.join(process.cwd(), relativeRuntimePath);
      if (!fs.existsSync(sourcePath)) {
        throw new Error(`Runtime dependency missing: ${sourcePath}`);
      }
      const destinationPath = path.join(targetPath, relativeRuntimePath);
      console.log(`[sync]  └─ syncing runtime path ${relativeRuntimePath}`);
      clearDestinationPath(destinationPath);
      copyDirectory(sourcePath, destinationPath);
    });

    if (Array.isArray(target.extraCopies)) {
      target.extraCopies.forEach(extra => {
        if (!extra?.source || !extra?.destination) {
          return;
        }
        const sourcePath = resolvePath(extra.source);
        const destinationPath = path.join(targetPath, extra.destination);
        console.log(`[sync]  └─ copying ${sourcePath} -> ${destinationPath}`);
        if (fs.statSync(sourcePath).isDirectory()) {
          copyDirectory(sourcePath, destinationPath);
        } else {
          ensureDir(path.dirname(destinationPath));
          fs.copyFileSync(sourcePath, destinationPath);
        }
      });
    }

    return {
      ok: true,
      path: targetPath,
    };
  } catch (error) {
    console.error(`[sync] Failed target ${targetPath}:`, error.message || error);
    return {
      ok: false,
      path: targetPath,
      error,
    };
  }
};

const pluginTargets = Array.isArray(config.pluginTargets) ? config.pluginTargets : [];
const mirrorTargets = Array.isArray(config.mirrorTargets) ? config.mirrorTargets : [];

if (pluginTargets.length === 0 && mirrorTargets.length === 0) {
  console.error('[sync] Config must define at least one pluginTargets or mirrorTargets entry.');
  process.exit(1);
}

try {
  const results = pluginTargets.concat(mirrorTargets).map(target => syncTarget(target));
  const succeeded = results.filter(result => result.ok);
  const failed = results.filter(result => !result.ok);

  if (failed.length === 0) {
    console.log('[sync] Completed successfully.');
    process.exit(0);
  }

  const failureSummary = failed
    .map(result => result.path || '<invalid target>')
    .join(', ');
  if (succeeded.length > 0 && allowPartial) {
    console.warn(`[sync] Completed with warnings. Failed targets: ${failureSummary}`);
    process.exit(0);
  }

  console.error(`[sync] Failed targets: ${failureSummary}`);
  process.exit(1);
} catch (error) {
  console.error('[sync] Failed:', error.message || error);
  process.exit(1);
}
