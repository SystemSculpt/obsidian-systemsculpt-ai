import { spawn, spawnSync } from "node:child_process";

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = String(result.stderr || result.stdout || `exit ${result.status}`).trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${details}`);
  }
  return String(result.stdout || "").trim();
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return await response.json();
}

async function waitForJsonEndpoint(url, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await fetchJson(url);
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function startIosAdapter(port) {
  const child = spawn("remotedebug_ios_webkit_adapter", [`--port=${port}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let bufferedOutput = "";
  const appendOutput = (chunk) => {
    const text = String(chunk || "");
    bufferedOutput = `${bufferedOutput}${text}`.slice(-8000);
  };

  child.stdout?.on("data", appendOutput);
  child.stderr?.on("data", appendOutput);

  return {
    child,
    getOutput() {
      return bufferedOutput.trim();
    },
  };
}

export function adbArgs(serial, extraArgs) {
  return serial ? ["-s", serial, ...extraArgs] : extraArgs;
}

export function selectTarget(targets, targetHint) {
  const list = Array.isArray(targets) ? targets : [];
  const hint = String(targetHint || "").trim().toLowerCase();
  const hinted = list.find((target) => {
    const title = String(target?.title || "").toLowerCase();
    const url = String(target?.url || "").toLowerCase();
    return hint && (title.includes(hint) || url.includes(hint));
  });
  if (hinted?.webSocketDebuggerUrl) return hinted;
  const page = list.find((target) => target?.type === "page" && target?.webSocketDebuggerUrl);
  if (page) return page;
  const firstInspectable = list.find((target) => target?.webSocketDebuggerUrl);
  return firstInspectable || null;
}

async function waitForInspectableTarget(jsonUrl, targetHint, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const targets = await fetchJson(jsonUrl);
    const target = selectTarget(targets, targetHint);
    if (target?.webSocketDebuggerUrl) {
      return { targets, target };
    }
    await sleep(500);
  }

  throw new Error(`No inspectable target matched "${targetHint}" at ${jsonUrl}.`);
}

export async function ensureJsonUrl(options) {
  if (options.mode === "desktop") {
    return {
      jsonUrl: `http://127.0.0.1:${options.desktopPort}/json/list`,
      async close() {},
    };
  }

  if (options.mode === "android") {
    const pid = run("adb", adbArgs(options.androidSerial, ["shell", "pidof", options.androidPackage]))
      .split(/\s+/)
      .filter(Boolean)[0];
    if (!pid) {
      throw new Error(`Could not find a running Android pid for ${options.androidPackage}.`);
    }

    spawnSync("adb", adbArgs(options.androidSerial, ["forward", "--remove", `tcp:${options.androidForwardPort}`]), {
      encoding: "utf8",
    });
    run("adb", adbArgs(options.androidSerial, [
      "forward",
      `tcp:${options.androidForwardPort}`,
      `localabstract:webview_devtools_remote_${pid}`,
    ]));
    return {
      jsonUrl: `http://127.0.0.1:${options.androidForwardPort}/json/list`,
      async close() {},
    };
  }

  if (options.mode === "ios") {
    const baseUrl = `http://${options.iosAdapterHost}:${options.iosAdapterPort}`;
    const jsonUrl = `${baseUrl}/json`;
    let adapter = null;

    try {
      await fetchJson(jsonUrl);
    } catch (initialError) {
      if (!options.startIosAdapter) {
        throw new Error(`Adapter is not reachable at ${baseUrl}: ${initialError.message}`);
      }

      adapter = startIosAdapter(options.iosAdapterPort);
      try {
        await waitForJsonEndpoint(jsonUrl);
      } catch (waitError) {
        adapter.child.kill("SIGTERM");
        throw new Error(
          `Adapter failed to start on ${baseUrl}: ${waitError.message}\n${adapter.getOutput()}`.trim()
        );
      }
    }

    return {
      jsonUrl,
      async close() {
        if (!adapter) {
          return;
        }
        adapter.child.kill("SIGTERM");
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 1000);
          adapter.child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
    };
  }

  if (options.mode === "json") {
    if (!options.jsonUrl) {
      throw new Error("--json-url is required in json mode.");
    }
    return {
      jsonUrl: options.jsonUrl,
      async close() {},
    };
  }

  throw new Error(`Unsupported mode: ${options.mode}`);
}

export async function connectToRuntime(jsonUrl, targetHint) {
  let target = null;
  let socket = null;
  let nextId = 1;
  const pending = new Map();
  let usePolledEvaluate = false;

  const closeSocket = async () => {
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      socket.addEventListener(
        "close",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
      socket.close();
    });
  };

  const connectOnce = async () => {
    const selected = await waitForInspectableTarget(jsonUrl, targetHint);
    target = selected.target;
    usePolledEvaluate =
      Boolean(target?.metadata?.deviceId) ||
      String(target?.webSocketDebuggerUrl || "").includes("/ios_");

    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket connect timeout")), 10000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
      socket.addEventListener(
        "error",
        (event) => {
          clearTimeout(timer);
          reject(new Error(String(event?.message || "WebSocket error")));
        },
        { once: true }
      );
    });

    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(String(event.data));
      if (!payload.id || !pending.has(payload.id)) {
        return;
      }
      const entry = pending.get(payload.id);
      pending.delete(payload.id);
      if (payload.error) {
        entry.reject(new Error(`${entry.method} failed: ${JSON.stringify(payload.error)}`));
        return;
      }
      entry.resolve(payload.result);
    });
  };

  async function send(method, params = {}, timeoutMs = 240000) {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      pending.set(id, {
        method,
        resolve(value) {
          clearTimeout(timeout);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  function unwrapEvaluation(result, method) {
    if (result?.exceptionDetails) {
      const description =
        result?.result?.description ||
        result?.exceptionDetails?.text ||
        `Remote evaluation failed during ${method}.`;
      throw new Error(String(description));
    }
    return result?.result?.value;
  }

  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await connectOnce();
      await send("Runtime.enable", {}, 15000);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      pending.clear();
      await closeSocket();
      socket = null;
      if (attempt < 4) {
        await sleep(1000);
      }
    }
  }

  if (lastError) {
    throw lastError;
  }

  async function evaluate(expression, timeoutMs = 240000) {
    if (!usePolledEvaluate) {
      const result = await send(
        "Runtime.evaluate",
        {
          expression,
          awaitPromise: true,
          returnByValue: true,
        },
        timeoutMs
      );
      return unwrapEvaluation(result, "Runtime.evaluate");
    }

    const jobId = `runtime-smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const kickoffExpression = `(() => {
      const key = ${JSON.stringify(jobId)};
      const store = globalThis.__systemsculptRuntimeSmokeEval = globalThis.__systemsculptRuntimeSmokeEval || {};
      store[key] = { status: 'pending' };
      Promise.resolve()
        .then(() => ${expression})
        .then(
          (value) => {
            store[key] = {
              status: 'fulfilled',
              payload: JSON.stringify({ value }),
            };
          },
          (error) => {
            store[key] = {
              status: 'rejected',
              message: String(error?.message || error),
              stack: String(error?.stack || ''),
            };
          }
        );
      return key;
    })()`;

    const kickoff = await send(
      "Runtime.evaluate",
      {
        expression: kickoffExpression,
        returnByValue: true,
      },
      15000
    );
    const startedJobId = unwrapEvaluation(kickoff, "Runtime.evaluate kickoff");
    if (startedJobId !== jobId) {
      throw new Error("Runtime smoke evaluation did not start correctly.");
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const poll = await send(
        "Runtime.evaluate",
        {
          expression: `(() => {
            const store = globalThis.__systemsculptRuntimeSmokeEval || {};
            const entry = store[${JSON.stringify(jobId)}] || null;
            if (!entry) return null;
            if (entry.status !== 'pending') {
              delete store[${JSON.stringify(jobId)}];
            }
            return JSON.stringify(entry);
          })()`,
          returnByValue: true,
        },
        15000
      );
      const raw = unwrapEvaluation(poll, "Runtime.evaluate poll");
      if (!raw) {
        await sleep(250);
        continue;
      }

      const entry = JSON.parse(String(raw));
      if (entry?.status === "pending") {
        await sleep(250);
        continue;
      }
      if (entry?.status === "rejected") {
        const details = entry?.stack ? `${entry.message}\n${entry.stack}` : entry?.message || "Remote evaluation failed.";
        throw new Error(String(details));
      }
      if (entry?.status === "fulfilled") {
        const payload = JSON.parse(String(entry?.payload || "{}"));
        return payload?.value;
      }

      throw new Error(`Unknown runtime smoke evaluation state: ${JSON.stringify(entry)}`);
    }

    await send(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const store = globalThis.__systemsculptRuntimeSmokeEval || {};
          delete store[${JSON.stringify(jobId)}];
          return true;
        })()`,
        returnByValue: true,
      },
      15000
    ).catch(() => {});
    throw new Error("Timed out waiting for runtime smoke evaluation result.");
  }

  async function close() {
    await closeSocket();
  }

  return {
    target,
    evaluate,
    close,
  };
}
