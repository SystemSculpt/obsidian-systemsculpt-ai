export type DataStreamLike = {
  on: (event: "data", listener: (chunk: unknown) => void) => void;
};

export type ChildProcessLike = {
  pid?: number;
  stdin?: {
    write?: (chunk: string) => boolean;
  };
  stdout?: DataStreamLike;
  stderr?: DataStreamLike;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  once: (event: "error" | "close", listener: (...args: any[]) => void) => void;
};

export type SpawnOptionsLike = {
  stdio?: Array<"pipe" | "ignore" | "inherit">;
};

export type SpawnFn = (command: string, args?: string[], options?: SpawnOptionsLike) => ChildProcessLike;
export type ExecFileSyncFn = (
  command: string,
  args?: string[],
  options?: { encoding?: string; timeout?: number }
) => string | Buffer;

type RuntimeRequireFn = (moduleName: string) => unknown;

const getRuntimeRequireCandidates = (): RuntimeRequireFn[] => {
  const candidates = [
    (globalThis as any)?.require,
    (globalThis as any)?.window?.require,
  ];
  return candidates.filter((candidate): candidate is RuntimeRequireFn => typeof candidate === "function");
};

const withRuntimeRequire = <T>(reader: (runtimeRequire: RuntimeRequireFn) => T): T | null => {
  for (const runtimeRequire of getRuntimeRequireCandidates()) {
    try {
      return reader(runtimeRequire);
    } catch {
      // try next runtime require candidate
    }
  }
  return null;
};

export const resolveSpawnFromRuntime = (): SpawnFn => {
  const resolved = withRuntimeRequire((runtimeRequire) => {
    const childProcess = runtimeRequire("child_process") as { spawn?: SpawnFn };
    if (typeof childProcess?.spawn !== "function") {
      throw new Error("spawn unavailable");
    }
    return childProcess.spawn.bind(childProcess);
  });

  if (!resolved) {
    throw new Error("Unable to resolve child_process.spawn in this runtime.");
  }

  return resolved;
};

export const resolveExecFileSyncFromRuntime = (): ExecFileSyncFn | null => {
  return withRuntimeRequire((runtimeRequire) => {
    const childProcess = runtimeRequire("child_process") as { execFileSync?: ExecFileSyncFn };
    if (typeof childProcess?.execFileSync !== "function") {
      throw new Error("execFileSync unavailable");
    }
    return childProcess.execFileSync.bind(childProcess);
  });
};

type ElectronLike<TSystemPreferences = unknown> = {
  systemPreferences?: TSystemPreferences;
};

export const resolveElectronFromRuntime = <TSystemPreferences = unknown>(): ElectronLike<TSystemPreferences> | null => {
  return withRuntimeRequire((runtimeRequire) => runtimeRequire("electron") as ElectronLike<TSystemPreferences>);
};

const toArrayBuffer = (value: unknown): ArrayBuffer | null => {
  if (value instanceof ArrayBuffer) {
    return value;
  }

  const asAny = value as any;
  if (!asAny || typeof asAny.byteLength !== "number") {
    return null;
  }

  if (asAny.buffer instanceof ArrayBuffer) {
    const byteOffset = typeof asAny.byteOffset === "number" ? asAny.byteOffset : 0;
    return asAny.buffer.slice(byteOffset, byteOffset + asAny.byteLength);
  }

  if (typeof asAny.slice !== "function") {
    return null;
  }

  const sliced = asAny.slice(0, asAny.byteLength);
  if (!(sliced?.buffer instanceof ArrayBuffer)) {
    return null;
  }

  const byteOffset = typeof sliced.byteOffset === "number" ? sliced.byteOffset : 0;
  return sliced.buffer.slice(byteOffset, byteOffset + sliced.byteLength);
};

export const readAbsoluteOutputBytesViaFs = async (path: string): Promise<ArrayBuffer | null> => {
  return withRuntimeRequire(async (runtimeRequire) => {
    const fs = runtimeRequire("fs") as {
      promises?: { readFile?: (targetPath: string) => Promise<unknown> };
      readFileSync?: (targetPath: string) => unknown;
    };

    if (typeof fs?.promises?.readFile === "function") {
      const output = await fs.promises.readFile(path);
      const normalized = toArrayBuffer(output);
      return normalized && normalized.byteLength > 0 ? normalized : null;
    }

    if (typeof fs?.readFileSync === "function") {
      const output = fs.readFileSync(path);
      const normalized = toArrayBuffer(output);
      return normalized && normalized.byteLength > 0 ? normalized : null;
    }

    throw new Error("readFile unavailable");
  }) ?? null;
};

export const readAbsoluteOutputSizeViaFs = async (path: string): Promise<number> => {
  return withRuntimeRequire(async (runtimeRequire) => {
    const fs = runtimeRequire("fs") as {
      promises?: { stat?: (targetPath: string) => Promise<{ size?: number } | null | undefined> };
      statSync?: (targetPath: string) => { size?: number } | null | undefined;
    };

    if (typeof fs?.promises?.stat === "function") {
      const stat = await fs.promises.stat(path);
      if (stat && typeof stat.size === "number" && Number.isFinite(stat.size) && stat.size > 0) {
        return stat.size;
      }
      return 0;
    }

    if (typeof fs?.statSync === "function") {
      const stat = fs.statSync(path);
      if (stat && typeof stat.size === "number" && Number.isFinite(stat.size) && stat.size > 0) {
        return stat.size;
      }
      return 0;
    }

    throw new Error("stat unavailable");
  }) ?? 0;
};
