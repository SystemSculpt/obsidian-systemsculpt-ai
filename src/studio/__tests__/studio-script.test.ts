import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readStudioScript, STUDIO_SCRIPT_TEMPLATE } from '../StudioScript';
import { scriptNode } from '../nodes/scriptNode';
import { parseStudioNodeSource, readStudioNodeSource } from '../StudioNodeSource';
import { resolveNodeDefinitionPorts } from '../StudioNodePortResolution';
import type { StudioNodeExecutionContext, StudioNodeInstance } from '../types';

const node = (kind: string, config: StudioNodeInstance['config']): StudioNodeInstance => ({id:'script',kind,version:'1.0.0',title:'Script',position:{x:0,y:0},config});

describe('Studio script and source contract', () => {
  it('resolves typed ports directly from source', () => {
    const n = node('studio.script', {source:STUDIO_SCRIPT_TEMPLATE});
    const definition = resolveNodeDefinitionPorts(n, scriptNode);
    expect(definition.inputPorts).toContainEqual(expect.objectContaining({id:'value',type:'json',required:false}));
    expect(definition.outputPorts.map(p => p.id)).toEqual(expect.arrayContaining(['result','stdout','stderr','exit_code','timed_out']));
  });
  it.each([
    ['/* studio\noutputs: {stdout: text}\n*/\nexport default () => ({});', /Invalid script port/],
    ['/* studio\nenvironment: {STUDIO_INPUTS: wrong}\n*/\nexport default () => ({});', /cannot override/],
    ['/* studio\nunknown: true\n*/\nexport default () => ({});', /Unknown script metadata/],
    ['/* studio\noutputs: {x: json, x: text}\n*/\nexport default () => ({});', /Invalid script metadata/],
    ['export default async ({inputs}) => { return {result: ;};', /Invalid JavaScript/],
    ['x'.repeat(256 * 1024 + 1), /256 KiB/],
  ])('rejects invalid source before execution', (source, error) => { expect(() => readStudioScript(source)).toThrow(error); });
  it('round-trips JSON and Markdown without config wrappers', () => {
    const json = node('studio.json',{value:{hello:1},__studio_color:'purple'});
    expect(JSON.parse(readStudioNodeSource(json).text)).toEqual({hello:1});
    expect(parseStudioNodeSource(json,'{"hello":2}')).toEqual({value:{hello:2},__studio_color:'purple'});
    const text = node('studio.text',{value:'# Hello',fontSize:14});
    expect(parseStudioNodeSource(text,'# Changed')).toEqual({value:'# Changed',fontSize:14});
  });
  it('preserves the latest connector snapshot while applying presentation source', () => {
    const value = {source:{schema:'studio.source.v1'},items:[{id:1}]};
    const collection = node('studio.collection',{value,titleField:'title',__studio_color:'purple'});
    const source = readStudioNodeSource(collection);
    expect(source.externalData).toBe(true); expect(source.text).not.toContain('items:');
    collection.config.value = {...value,items:[{id:2}]};
    expect(parseStudioNodeSource(collection,'titleField: name\n')).toEqual({value:collection.config.value,titleField:'name',__studio_color:'purple'});
    expect(() => parseStudioNodeSource(collection,'value: {}')).toThrow('connector owns');
  });
  it.each(['foo: .inf','foo: &x [*x]','__proto__: {}','foo: 1\nfoo: 2'])('rejects unsafe or ambiguous YAML %s', source => {
    expect(() => parseStudioNodeSource(node('studio.value',{}),source)).toThrow();
  });
});

describe('actual Node module execution', () => {
  let directory: string;
  let count = 0;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(),'studio-script-test-')); count = 0; });
  afterEach(async () => { await rm(directory,{recursive:true,force:true}); });
  function context(source: string): StudioNodeExecutionContext {
    return {
      runId:'run_test',projectPath:'Test.systemsculpt',node:node('studio.script',{source}),inputs:{value:{n:4}},signal:new AbortController().signal,log:jest.fn(),reportProgress:jest.fn(),
      services:{
        api:{generateText:jest.fn(),generateImage:jest.fn(),transcribeAudio:jest.fn(),beginLocalCommit:jest.fn(),completeLocalCommit:jest.fn()},
        storeAsset:jest.fn(),readAsset:jest.fn(),readVaultText:jest.fn(),statVaultFileSize:jest.fn(),readVaultBinary:jest.fn(),statLocalFileSize:jest.fn(),
        resolveAbsolutePath: p => p === '.' ? directory : p,
        assertFilesystemPath:jest.fn(),
        writeTempFile:async (bytes, options) => { const file = join(directory,`${options?.prefix}-${count++}.${options?.extension}`); await writeFile(file,new Uint8Array(bytes)); return file; },
        deleteLocalFile:async file => { await rm(file,{force:true}); },
        readLocalFileBinary:async (file,limit) => { const bytes = await readFile(file); if (limit && bytes.byteLength > limit) throw new Error('File exceeds limit'); return Uint8Array.from(bytes).buffer; },
        runCli:async request => {
          expect(request.requireExactCommandGrant).toBe(true);
          try {
            const result = await promisify(execFile)(process.execPath,request.args!,{cwd:request.cwd,env:{...process.env,...request.env},timeout:request.timeoutMs,signal:request.signal});
            return {...result,exitCode:0,timedOut:false};
          } catch (error) {
            const failure = error as Error & {code?:number; killed?:boolean; stderr?:string};
            return {stdout:'',stderr:failure.stderr ?? failure.message,exitCode:failure.code ?? 1,timedOut:failure.killed ?? false,cancelled:request.signal?.aborted};
          }
        },
      },
    };
  }
  it('passes typed inputs into a real child process and cleans module files', async () => {
    const ctx = context(STUDIO_SCRIPT_TEMPLATE.replace('inputs.value ?? { message: "Hello from Studio" }','{ doubled: inputs.value.n * 2 }'));
    expect((await scriptNode.execute(ctx)).outputs.result).toEqual({doubled:8});
    expect((await readdir(directory)).filter(file => file.endsWith('.mjs'))).toEqual([]);
  });
  it('surfaces module failures and still cleans temporary source', async () => {
    await expect(scriptNode.execute(context('export default () => { throw new Error("module failed"); };'))).rejects.toThrow('module failed');
    expect((await readdir(directory)).filter(file => file.endsWith('.mjs'))).toEqual([]);
  });
  it('enforces timeout and cancellation through the process boundary', async () => {
    const source = '/* studio\ntimeoutMs: 100\n*/\nexport default async () => { await new Promise(r => setTimeout(r, 10000)); return {result: 1}; };';
    await expect(scriptNode.execute(context(source))).rejects.toThrow('timed out');
    const ctx = context(source), controller = new AbortController(); ctx.signal = controller.signal; controller.abort();
    await expect(scriptNode.execute(ctx)).rejects.toMatchObject({name:'AbortError'});
    expect((await readdir(directory)).filter(file => file.endsWith('.mjs'))).toEqual([]);
  });
});
