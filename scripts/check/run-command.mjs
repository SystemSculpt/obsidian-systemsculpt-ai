import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import { log } from './logger.mjs';

export function runCommand({
  id,
  command,
  args = [],
  cwd = process.cwd(),
  env = {},
  timeoutMs = 0,
}) {
  return new Promise((resolve) => {
    const started = performance.now();
    log('info', `Starting ${id}`, { command, args, cwd });

    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      log('debug', `${id} stdout chunk`, { length: text.length });
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      log('debug', `${id} stderr chunk`, { length: text.length });
    });

    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        log('warn', `Timing out ${id}`, { timeoutMs });
        child.kill('SIGKILL');
      }, timeoutMs);
    }

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      const durationMs = Math.round(performance.now() - started);
      log('info', `Completed ${id}`, { code, signal, durationMs });
      resolve({ code: code ?? 0, signal, durationMs, stdout, stderr });
    });
  });
}
