#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_PATH = path.join(LOG_DIR, 'check.log');

fs.mkdirSync(LOG_DIR, { recursive: true });

const stream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

const levelWriters = {
  debug: (...args) => {
    if (process.env.CHECK_DEBUG === '1') {
      console.debug('[check:debug]', ...args);
    }
  },
  info: (...args) => console.log('[check]', ...args),
  warn: (...args) => console.warn('[check:warn]', ...args),
  error: (...args) => console.error('[check:error]', ...args),
};

export function log(level, message, context = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    context,
  };
  stream.write(`${JSON.stringify(entry)}\n`);

  const writer = levelWriters[level] || levelWriters.info;
  writer(message, Object.keys(context).length ? context : '');
}

export function logProblem(problem) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: 'problem',
    ...problem,
  };
  stream.write(`${JSON.stringify(entry)}\n`);
}

export function closeLogger() {
  stream.end();
}

export { LOG_PATH };
