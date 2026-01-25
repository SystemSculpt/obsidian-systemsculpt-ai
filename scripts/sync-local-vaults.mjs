#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const usage = () => {
  console.log(`Usage: node scripts/sync-local-vaults.mjs [--config <path>]

Copies the built plugin artifacts (main.js, manifest.json, styles.css, etc.) into
one or more local Obsidian plugin folders. All destinations are defined in the
configuration JSON. If --config is not supplied, the script looks for the path in
SYSTEMSCULPT_SYNC_CONFIG or defaults to ./systemsculpt-sync.config.json.`);
};

const args = process.argv.slice(2);
let configPathFromArgs = null;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if ((arg === '--config' || arg === '-c') && i + 1 < args.length) {
    configPathFromArgs = args[i + 1];
    i += 1;
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
];
const optionalFiles = ['README.md', 'LICENSE', 'versions.json'];

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
    console.warn('[sync] Skipping invalid target entry (missing path).');
    return;
  }
  const targetPath = resolvePath(target.path);
  ensureDir(targetPath);
  console.log(`[sync] Updating ${targetPath}`);
  requiredFiles.concat(optionalFiles).forEach(file => {
    try {
      copyFile(file, targetPath);
    } catch (error) {
      console.error(`[sync] Failed to copy ${file}:`, error.message || error);
      throw error;
    }
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
};

const pluginTargets = Array.isArray(config.pluginTargets) ? config.pluginTargets : [];
const mirrorTargets = Array.isArray(config.mirrorTargets) ? config.mirrorTargets : [];

if (pluginTargets.length === 0 && mirrorTargets.length === 0) {
  console.error('[sync] Config must define at least one pluginTargets or mirrorTargets entry.');
  process.exit(1);
}

try {
  pluginTargets.forEach(target => syncTarget(target));
  mirrorTargets.forEach(target => syncTarget(target));
  console.log('[sync] Completed successfully.');
} catch (error) {
  console.error('[sync] Failed:', error.message || error);
  process.exit(1);
}
