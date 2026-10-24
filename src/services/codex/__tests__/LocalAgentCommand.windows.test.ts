import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { desktopHost } from '../../../platform/desktopOnly';
import { resolveLocalAgentCommand } from '../LocalAgentLaunch';
jest.mock('../../../platform/desktopOnly', () => ({ desktopHost: { fs: jest.fn(), os: jest.fn(), path: jest.fn() } }));

const exec = promisify(execFile);
const windows = process.platform === 'win32' ? describe : describe.skip;

windows('real Windows npm shims (credential-free)', () => {
  let root: string, prefix: string, cwd: string, environment: NodeJS.ProcessEnv;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'systemsculpt-npm-'));
    prefix = path.join(root, 'npm & %T545_EXPAND% !test! (native)');
    cwd = path.join(root, 'vault & %T545_EXPAND% !test!');
    const fixture = path.join(root, 'fixture');
    await fs.mkdir(fixture); await fs.mkdir(cwd);
    await fs.writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name: 'systemsculpt-local-cli-fixture', version: '1.0.0', bin: { claude: 'cli.js', codex: 'cli.js', 'native-claude': 'native.exe' } }));
    await fs.writeFile(path.join(fixture, 'native.exe'), 'no-shebang native installer placeholder');
    await fs.writeFile(path.join(fixture, 'cli.js'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'wait') { process.stdout.write('ready'); setInterval(() => {}, 1000); }
else if (args[0] === 'stdio') { let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ args, input, cwd: process.cwd(), home: process.env.CODEX_HOME }))); }
else process.stdout.write(JSON.stringify({ args, cwd: process.cwd(), home: process.env.CLAUDE_CONFIG_DIR }));
`);
    // Generate the actual npm version's .cmd and extensionless companion, with no downloads or install scripts.
    const npm = process.env.npm_execpath;
    if (!npm) throw new Error('Run this suite through npm so its CLI path is available.');
    await exec(process.execPath, [npm, 'install', '--global', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', fixture], { cwd: root, windowsHide: true });
    await fs.copyFile(process.execPath, path.join(fixture, 'native.exe'));
    environment = { ...process.env, PATH: `${prefix};${path.dirname(process.execPath)}`, T545_EXPAND: 'must-not-expand', CODEX_HOME: path.join(root, 'native codex'), CLAUDE_CONFIG_DIR: path.join(root, 'native claude') };
    for (const key of Object.keys(environment)) if (key !== 'PATH' && key.toUpperCase() === 'PATH') delete environment[key];
    jest.mocked(desktopHost.fs).mockResolvedValue(fs);
    jest.mocked(desktopHost.os).mockResolvedValue(os);
    jest.mocked(desktopHost.path).mockResolvedValue(path);
  }, 30_000);
  beforeEach(async () => { await fs.rm(path.join(prefix, 'node.exe'), { force: true }); });
  afterAll(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

  it('reproduces direct .cmd execFile failure and launches the same npm install through Node', async () => {
    await expect(exec(path.join(prefix, 'claude.cmd'), ['auth', 'status', '--json'], { cwd, env: environment, shell: false })).rejects.toThrow();
    const args = ['auth', 'status', '--json', '', 'a "quote" \\', '%T545_EXPAND%', '!test!', 'a\nb', '& echo injected>marker', '| echo injected', '^caret', '(group)', '雪'];
    const command = await resolveLocalAgentCommand('claude', args, environment, cwd);
    expect(command.binary.toLowerCase()).toBe(process.execPath.toLowerCase());
    const { stdout } = await exec(command.binary, command.args, { cwd, env: environment, shell: false, windowsHide: true });
    expect(JSON.parse(stdout)).toEqual({ args, cwd, home: environment.CLAUDE_CONFIG_DIR });
    await expect(fs.stat(path.join(cwd, 'marker'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('executes npm\'s no-shebang native shim, as used by current Claude Code packages', async () => {
    const args = [path.join(root, 'fixture', 'cli.js'), 'auth', 'status', '%T545_EXPAND%', '" & echo injected>marker'];
    const command = await resolveLocalAgentCommand('native-claude', args, environment, cwd);
    expect(command.binary).toBe(path.join(prefix, 'node_modules', 'systemsculpt-local-cli-fixture', 'native.exe'));
    expect(command.args).toEqual(args);
    const { stdout } = await exec(command.binary, command.args, { cwd, env: environment, shell: false, windowsHide: true });
    expect(JSON.parse(stdout)).toEqual({ args: args.slice(1), cwd, home: environment.CLAUDE_CONFIG_DIR });
    await expect(fs.stat(path.join(cwd, 'marker'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('streams stdio with a colocated node.exe and literal paths and arguments', async () => {
    const localNode = path.join(prefix, 'node.exe');
    await fs.copyFile(process.execPath, localNode);
    const args = ['stdio', 'app-server', '" & echo injected>marker', '%T545_EXPAND%', 'trailing\\'];
    const command = await resolveLocalAgentCommand(path.join(prefix, 'codex.cmd'), args, environment, cwd);
    expect(command.binary).toBe(localNode);
    const child = spawn(command.binary, command.args, { cwd, env: environment, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; });
    const closed = once(child, 'close');
    const input = '{"prompt":"literal & %T545_EXPAND% !test!"}\n';
    child.stdin.end(input);
    expect(await closed).toEqual([0, null]);
    expect(JSON.parse(output)).toEqual({ args, input, cwd, home: environment.CODEX_HOME });
    await expect(fs.stat(path.join(cwd, 'marker'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('kills the actual Node status process when the existing probe abort signal fires', async () => {
    const command = await resolveLocalAgentCommand('codex', ['wait'], environment, cwd);
    const controller = new AbortController();
    const child = execFile(command.binary, command.args, { cwd, env: environment, signal: controller.signal, timeout: 3000, killSignal: 'SIGKILL', shell: false, windowsHide: true });
    child.on('error', () => {}); // AbortError is expected; wait for close separately.
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    try {
      await once(child.stdout!, 'data');
      controller.abort();
      await closed;
      expect(child.killed).toBe(true);
      expect(() => process.kill(child.pid!, 0)).toThrow();
    } finally { child.kill('SIGKILL'); await closed; }
  });
});
