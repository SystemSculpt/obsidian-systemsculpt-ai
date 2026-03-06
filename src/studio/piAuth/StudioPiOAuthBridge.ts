import { spawn } from "node:child_process";
import {
  appendStudioPiOutput,
  isLikelyMissingStudioPiExecutableError,
  mergeStudioPiCliPath,
} from "./StudioPiProcessUtils";
import type { StudioPiAuthPrompt, StudioPiOAuthLoginOptions } from "./StudioPiAuthStorage";
import { buildPiNodeChildEnv, resolvePiNodeCommandCandidates } from "../../services/pi/PiNodeRuntime";

const PI_OAUTH_BRIDGE_TIMEOUT_MS = 10 * 60_000;
const PI_OAUTH_ELECTRON_RUNTIME_MARKER = "SS_PI_OAUTH_ELECTRON_RUNTIME";
const PI_OAUTH_BRIDGE_SCRIPT = String.raw`
const sdkEntryPath = process.argv[1];
const providerId = process.argv[2];
const readline = require("node:readline");
const ELECTRON_RUNTIME_MARKER = "${PI_OAUTH_ELECTRON_RUNTIME_MARKER}";

const emit = (payload) => {
  try {
    process.stdout.write(JSON.stringify(payload) + "\n");
  } catch {}
};

const pending = new Map();
let nextId = 1;

const respondWithPrompt = (type, payload) => {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    emit(Object.assign({ type, id }, payload || {}));
  });
};

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg || msg.type !== "response" || typeof msg.id !== "number") {
    return;
  }
  const entry = pending.get(msg.id);
  if (!entry) {
    return;
  }
  pending.delete(msg.id);
  if (msg.cancelled) {
    const errorText = typeof msg.error === "string" && msg.error.trim()
      ? msg.error
      : "Authentication cancelled.";
    entry.reject(new Error(errorText));
    return;
  }
  if (typeof msg.value === "string") {
    entry.resolve(msg.value);
    return;
  }
  entry.resolve(String(msg.value ?? ""));
});

(async () => {
  try {
    if (process.versions && process.versions.electron) {
      emit({
        type: "error",
        message: ELECTRON_RUNTIME_MARKER + ": OAuth helper must run in a Node.js runtime.",
      });
      process.exit(86);
      return;
    }
    const sdkModule = require(sdkEntryPath);
    const storage = sdkModule.AuthStorage.create();
    await storage.login(providerId, {
      onAuth: (info) => {
        emit({
          type: "auth",
          url: String(info && info.url ? info.url : ""),
          instructions: String(info && info.instructions ? info.instructions : ""),
        });
      },
      onPrompt: async (prompt) => {
        return await respondWithPrompt("prompt", {
          message: String(prompt && prompt.message ? prompt.message : "Enter value:"),
          placeholder: String(prompt && prompt.placeholder ? prompt.placeholder : ""),
          allowEmpty: Boolean(prompt && prompt.allowEmpty),
        });
      },
      onProgress: (message) => {
        emit({
          type: "progress",
          message: String(message || ""),
        });
      },
      onManualCodeInput: async () => {
        return await respondWithPrompt("manual_code", {
          message: "Paste the authorization code or full redirect URL:",
          placeholder: "https://...",
          allowEmpty: false,
        });
      },
    });
    const storedCredential = storage.get(providerId);
    if (!storedCredential || storedCredential.type !== "oauth") {
      throw new Error("OAuth login completed but no OAuth credential was stored.");
    }
    emit({ type: "done" });
    process.exit(0);
  } catch (error) {
    emit({
      type: "error",
      message: error instanceof Error ? error.message : String(error || "OAuth login failed."),
    });
    process.exit(1);
  }
})();
`;

type StudioPiOAuthBridgeEvent =
  | {
      type: "auth";
      url?: unknown;
      instructions?: unknown;
    }
  | {
      type: "progress";
      message?: unknown;
    }
  | {
      type: "prompt" | "manual_code";
      id?: unknown;
      message?: unknown;
      placeholder?: unknown;
      allowEmpty?: unknown;
    }
  | {
      type: "error";
      message?: unknown;
    }
  | {
      type: "done";
    };

function isLikelyElectronRuntimeError(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message || "").trim();
  if (!message) {
    return false;
  }
  const normalized = message.toLowerCase();
  return (
    normalized.includes(PI_OAUTH_ELECTRON_RUNTIME_MARKER.toLowerCase()) ||
    normalized.includes("oauth helper must run in a node.js runtime")
  );
}

async function runStudioPiOAuthBridgeWithNodeCommand(
  nodeCommand: string,
  sdkEntryPath: string,
  providerId: string,
  options: StudioPiOAuthLoginOptions
): Promise<void> {
  const cwd = typeof process?.cwd === "function" ? String(process.cwd() || "").trim() || "/" : "/";
  const mergedEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };
  mergedEnv.PATH = mergeStudioPiCliPath(String(mergedEnv.PATH || ""));
  const childEnv = buildPiNodeChildEnv({
    baseEnv: mergedEnv,
    runtimeCommand: nodeCommand,
  }) as Record<string, string>;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let doneReceived = false;
    let sawAuthInteraction = false;
    let timedOut = false;
    let stdoutBuffer = "";
    let stderr = "";
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const writeQueue: Promise<void>[] = [];

    const child = spawn(nodeCommand, ["-e", PI_OAUTH_BRIDGE_SCRIPT, sdkEntryPath, providerId], {
      cwd,
      env: childEnv,
      shell: false,
    });

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (typeof options.signal?.removeEventListener === "function") {
        options.signal.removeEventListener("abort", onAbort);
      }
      Promise.allSettled(writeQueue).then(() => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    };

    const sendResponse = (payload: { id: number; value?: string; cancelled?: boolean; error?: string }) => {
      if (settled) {
        return;
      }
      const line = JSON.stringify({
        type: "response",
        id: payload.id,
        value: payload.value ?? "",
        cancelled: Boolean(payload.cancelled),
        error: payload.error || "",
      });
      const writePromise = new Promise<void>((resolveWrite) => {
        try {
          child.stdin.write(`${line}\n`, () => resolveWrite());
        } catch {
          resolveWrite();
        }
      });
      writeQueue.push(writePromise);
    };

    const handlePrompt = (event: Extract<StudioPiOAuthBridgeEvent, { type: "prompt" | "manual_code" }>) => {
      const id = Number(event.id);
      if (!Number.isFinite(id)) {
        return;
      }
      sawAuthInteraction = true;
      const prompt: StudioPiAuthPrompt = {
        message: String(event.message || "Enter value:"),
        placeholder: String(event.placeholder || "").trim() || undefined,
        allowEmpty: Boolean(event.allowEmpty),
      };
      const runPrompt = async () => {
        if (event.type === "manual_code") {
          if (typeof options.onManualCodeInput === "function") {
            return await options.onManualCodeInput();
          }
          return await options.onPrompt(prompt);
        }
        return await options.onPrompt(prompt);
      };
      void runPrompt()
        .then((value) => {
          sendResponse({
            id,
            value: String(value || ""),
          });
        })
        .catch((error) => {
          sendResponse({
            id,
            cancelled: true,
            error: error instanceof Error ? error.message : String(error || "Authentication cancelled."),
          });
        });
    };

    const handleBridgeLine = (line: string) => {
      const trimmed = String(line || "").trim();
      if (!trimmed) {
        return;
      }
      let event: StudioPiOAuthBridgeEvent;
      try {
        event = JSON.parse(trimmed) as StudioPiOAuthBridgeEvent;
      } catch {
        return;
      }

      switch (event.type) {
        case "auth":
          sawAuthInteraction = true;
          options.onAuth({
            url: String(event.url || "").trim(),
            instructions: String(event.instructions || "").trim() || undefined,
          });
          return;
        case "progress":
          sawAuthInteraction = true;
          if (typeof options.onProgress === "function") {
            options.onProgress(String(event.message || "").trim());
          }
          return;
        case "prompt":
        case "manual_code":
          handlePrompt(event);
          return;
        case "error":
          finish(new Error(String(event.message || "OAuth login failed.")));
          return;
        case "done":
          doneReceived = true;
          return;
        default:
          return;
      }
    };

    const flushStdoutBuffer = () => {
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        handleBridgeLine(line);
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    };

    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore kill failures.
      }
      finish(new Error("Authentication cancelled."));
    };

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    if (typeof options.signal?.addEventListener === "function") {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore kill failures.
      }
    }, PI_OAUTH_BRIDGE_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutBuffer += chunk.toString();
      flushStdoutBuffer();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = appendStudioPiOutput(stderr, chunk);
    });

    child.on("error", (error) => {
      finish(error instanceof Error ? error : new Error(String(error || "Failed to launch OAuth helper process.")));
    });

    child.on("close", (code) => {
      flushStdoutBuffer();
      if (settled) {
        return;
      }
      if (timedOut) {
        finish(new Error("Timed out while completing Pi OAuth login."));
        return;
      }
      if (typeof code === "number" && code !== 0) {
        const stderrSummary = String(stderr || "").trim();
        const reason = stderrSummary || `OAuth helper process exited with code ${code}.`;
        finish(new Error(reason));
        return;
      }
      if (!doneReceived) {
        const stderrSummary = String(stderr || "").trim();
        const reason = stderrSummary || "OAuth helper exited before signaling completion.";
        finish(new Error(reason));
        return;
      }
      if (!sawAuthInteraction) {
        const stderrSummary = String(stderr || "").trim();
        const reason = stderrSummary || "OAuth helper completed without any authentication events.";
        finish(new Error(reason));
        return;
      }
      finish();
    });
  });
}

export async function loginStudioPiProviderOAuthThroughNode(
  providerId: string,
  sdkEntryPath: string,
  options: StudioPiOAuthLoginOptions
): Promise<void> {
  const nodeCommandCandidates = resolvePiNodeCommandCandidates({
    baseEnv: process.env,
  });
  let lastMissingExecutableError: unknown = null;
  let lastElectronRuntimeError: unknown = null;

  for (const nodeCommand of nodeCommandCandidates) {
    try {
      await runStudioPiOAuthBridgeWithNodeCommand(nodeCommand, sdkEntryPath, providerId, options);
      return;
    } catch (error) {
      if (isLikelyMissingStudioPiExecutableError(error, ["node", "pi"])) {
        lastMissingExecutableError = error;
        continue;
      }
      if (isLikelyElectronRuntimeError(error)) {
        lastElectronRuntimeError = error;
        continue;
      }
      throw error;
    }
  }

  if (lastMissingExecutableError || lastElectronRuntimeError) {
    throw new Error(
      "Unable to launch the bundled Node.js runtime for Pi OAuth login. Reopen Obsidian and retry after bootstrap completes."
    );
  }
  throw new Error("Unable to launch the bundled Node.js runtime for Pi OAuth login.");
}
