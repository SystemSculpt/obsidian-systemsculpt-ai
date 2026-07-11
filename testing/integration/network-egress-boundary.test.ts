import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.resolve(__dirname, '../..');
const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('network egress boundary runtime supplement', () => {
  it('records computed egress, permits the approved client path, and never mutates production artifacts', async () => {
    const artifacts = ['main.js', 'styles.css', 'manifest.json'].map(name => path.join(root, name)).filter(fs.existsSync);
    const before = new Map(artifacts.map(file => [file, { hash: hash(file), mtime: fs.statSync(file).mtimeMs }]));
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-runtime-'));
    const entry = path.join(temp, 'entry.ts');
    fs.writeFileSync(entry, `
      import { runComputedEgressFixture } from ${JSON.stringify(path.join(root, 'testing/fixtures/managed/computed-egress-fixture.ts'))};
      import { PlatformRequestClient } from ${JSON.stringify(path.join(root, 'src/services/PlatformRequestClient.ts'))};
      export async function run() {
        let computedError = '';
        try { await runComputedEgressFixture(); } catch (error) { computedError = String(error); }
        const response = await new PlatformRequestClient().request({ url: 'https://api.systemsculpt.com/control', method: 'GET' });
        return { computedError, status: response.status };
      }
    `);
    const runner = path.join(temp, 'build.mjs');
    const outputFile = path.join(temp, 'output.json');
    fs.writeFileSync(runner, `
      import * as esbuild from ${JSON.stringify(path.join(root, 'node_modules/esbuild/lib/main.js'))};
      import { createPluginBuildOptions } from ${JSON.stringify(path.join(root, 'scripts/plugin-build-options.mjs'))};
      import fs from 'node:fs';
      const result = await esbuild.build(createPluginBuildOptions({
        entryPoint: ${JSON.stringify(entry)}, outfile: ${JSON.stringify(path.join(temp, 'synthetic.js'))},
        write: false, production: true, overrides: { metafile: true, platform: 'node', external: ['obsidian'] }, buildStamp: 'test'
      }));
      fs.writeFileSync(${JSON.stringify(outputFile)}, JSON.stringify({ code: result.outputFiles[0].text, metafile: result.metafile }));
    `);
    execFileSync(process.execPath, [runner], { cwd: root, stdio: 'pipe' });
    const result = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    const code = result.code as string;
    expect(code).toContain('SYSTEMSCULPT_COMPUTED_EGRESS_FIXTURE');
    expect(code).toMatch(/module\.exports|exports\.run/);

    const calls: string[] = [];
    const fetchStub = jest.fn(async (url: string) => {
      calls.push(String(url));
      if (String(url).includes('computed-egress.invalid')) throw new Error('blocked computed egress');
      return new Response('{}', { status: 200 });
    });
    const requestUrl = jest.fn(() => { throw new Error('unexpected requestUrl path'); });
    const sandbox: any = { module: { exports: {} }, exports: {}, require: (id: string) => id === 'obsidian' ? { requestUrl, Platform: { isMobile: false, isDesktopApp: true } } : require(id), fetch: fetchStub, Response, Headers, Request, URL, DOMException, AbortController, console, process, setTimeout, clearTimeout };
    sandbox.exports = sandbox.module.exports;
    vm.runInNewContext(code, sandbox, { filename: 'synthetic.js' });
    const output = await sandbox.module.exports.run();
    expect(output).toEqual({ computedError: 'Error: blocked computed egress', status: 200 });
    expect(calls).toEqual(['https://computed-egress.invalid/path', 'https://api.systemsculpt.com/control']);
    expect(requestUrl).not.toHaveBeenCalled();

    const productionBundle = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    expect(productionBundle).not.toContain('SYSTEMSCULPT_COMPUTED_EGRESS_FIXTURE');
    expect(productionBundle).not.toContain('computed-egress.invalid');
    expect(Object.keys(result.metafile.inputs)).not.toContain(expect.stringContaining('src/main.ts'));
    for (const [file, state] of before) expect({ hash: hash(file), mtime: fs.statSync(file).mtimeMs }).toEqual(state);
  });
});
