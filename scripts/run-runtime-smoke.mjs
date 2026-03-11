#!/usr/bin/env node
import fs from "node:fs/promises";
import process from "node:process";
import { spawnSync } from "node:child_process";

const DEFAULT_DESKTOP_PORT = 9222;
const DEFAULT_ANDROID_FORWARD_PORT = 9333;
const DEFAULT_TARGET_HINT = "Obsidian";
const DEFAULT_FIXTURE_DIR = "SystemSculpt/QA/CrossDevice/20260311-194643";
const DEFAULT_ANDROID_SERIAL = "emulator-5554";
const DEFAULT_ANDROID_PACKAGE = "md.obsidian";
const DEFAULT_REPEAT = 1;
const DEFAULT_PAUSE_MS = 1000;
const DEFAULT_WEB_FETCH_URL = "https://www.wikipedia.org/";
const DEFAULT_YOUTUBE_URL = "https://www.youtube.com/watch?v=nDLb8_wgX50";
const CORE_CASES = ["chat-exact", "file-read", "file-write", "embeddings", "transcribe", "web-fetch"];
const EXTENDED_CASES = [...CORE_CASES, "youtube-transcript"];

function usage() {
  console.log(`Usage: node scripts/run-runtime-smoke.mjs [options]

Run the live hosted SystemSculpt runtime smoke matrix through an inspectable
Obsidian runtime. This is intended for native desktop, Android WebView, and the
iOS WebKit adapter once the target is reachable.

Options:
  --mode <desktop|android|json>   Transport mode. Default: desktop
  --case <name|all|extended>      Smoke case: chat-exact, file-read, file-write, embeddings, transcribe, web-fetch, youtube-transcript, all, or extended. Default: all
  --desktop-port <n>              Desktop DevTools port. Default: 9222
  --android-serial <id>           adb serial for Android mode. Default: emulator-5554
  --android-package <id>          Android package id. Default: md.obsidian
  --android-forward-port <n>      Local forward port for Android WebView. Default: 9333
  --json-url <url>                Explicit /json or /json/list target endpoint for json mode
  --target-hint <text>            Prefer targets whose title/url includes this hint. Default: Obsidian
  --fixture-dir <path>            Vault-relative fixture directory. Default: SystemSculpt/QA/CrossDevice/20260311-194643
  --repeat <n>                    Repeat the selected case list this many times. Default: 1
  --pause-ms <n>                  Delay between iterations. Default: 1000
  --web-fetch-url <url>           URL for the web-fetch hosted service smoke. Default: https://www.wikipedia.org/
  --youtube-url <url>             URL for the YouTube transcript hosted service smoke. Default: https://www.youtube.com/watch?v=nDLb8_wgX50
  --json-output <path>            Write the final JSON report to this path as well as stdout
  --help, -h                      Show this help.
`);
}

function fail(message) {
  console.error(`[runtime-smoke] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    mode: "desktop",
    caseName: "all",
    desktopPort: DEFAULT_DESKTOP_PORT,
    androidSerial: DEFAULT_ANDROID_SERIAL,
    androidPackage: DEFAULT_ANDROID_PACKAGE,
    androidForwardPort: DEFAULT_ANDROID_FORWARD_PORT,
    jsonUrl: "",
    targetHint: DEFAULT_TARGET_HINT,
    fixtureDir: DEFAULT_FIXTURE_DIR,
    repeat: DEFAULT_REPEAT,
    pauseMs: DEFAULT_PAUSE_MS,
    webFetchUrl: DEFAULT_WEB_FETCH_URL,
    youtubeUrl: DEFAULT_YOUTUBE_URL,
    jsonOutput: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode") {
      options.mode = String(argv[index + 1] || "").trim() || options.mode;
      index += 1;
      continue;
    }
    if (arg === "--case") {
      options.caseName = String(argv[index + 1] || "").trim() || options.caseName;
      index += 1;
      continue;
    }
    if (arg === "--desktop-port") {
      options.desktopPort = Number.parseInt(String(argv[index + 1] || ""), 10) || options.desktopPort;
      index += 1;
      continue;
    }
    if (arg === "--android-serial") {
      options.androidSerial = String(argv[index + 1] || "").trim() || options.androidSerial;
      index += 1;
      continue;
    }
    if (arg === "--android-package") {
      options.androidPackage = String(argv[index + 1] || "").trim() || options.androidPackage;
      index += 1;
      continue;
    }
    if (arg === "--android-forward-port") {
      options.androidForwardPort =
        Number.parseInt(String(argv[index + 1] || ""), 10) || options.androidForwardPort;
      index += 1;
      continue;
    }
    if (arg === "--json-url") {
      options.jsonUrl = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--target-hint") {
      options.targetHint = String(argv[index + 1] || "").trim() || options.targetHint;
      index += 1;
      continue;
    }
    if (arg === "--fixture-dir") {
      options.fixtureDir = String(argv[index + 1] || "").trim() || options.fixtureDir;
      index += 1;
      continue;
    }
    if (arg === "--repeat") {
      options.repeat = Math.max(1, Number.parseInt(String(argv[index + 1] || ""), 10) || options.repeat);
      index += 1;
      continue;
    }
    if (arg === "--pause-ms") {
      options.pauseMs = Math.max(0, Number.parseInt(String(argv[index + 1] || ""), 10) || options.pauseMs);
      index += 1;
      continue;
    }
    if (arg === "--web-fetch-url") {
      options.webFetchUrl = String(argv[index + 1] || "").trim() || options.webFetchUrl;
      index += 1;
      continue;
    }
    if (arg === "--youtube-url") {
      options.youtubeUrl = String(argv[index + 1] || "").trim() || options.youtubeUrl;
      index += 1;
      continue;
    }
    if (arg === "--json-output") {
      options.jsonOutput = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }

    fail(`Unknown argument: ${arg}`);
  }

  return options;
}

function run(command, args) {
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

function adbArgs(serial, extraArgs) {
  return serial ? ["-s", serial, ...extraArgs] : extraArgs;
}

function selectTarget(targets, targetHint) {
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

async function ensureJsonUrl(options) {
  if (options.mode === "desktop") {
    return `http://127.0.0.1:${options.desktopPort}/json/list`;
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
    return `http://127.0.0.1:${options.androidForwardPort}/json/list`;
  }

  if (options.mode === "json") {
    if (!options.jsonUrl) {
      throw new Error("--json-url is required in json mode.");
    }
    return options.jsonUrl;
  }

  throw new Error(`Unsupported mode: ${options.mode}`);
}

async function connectToRuntime(jsonUrl, targetHint) {
  const response = await fetch(jsonUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${jsonUrl}: HTTP ${response.status}`);
  }
  const targets = await response.json();
  const target = selectTarget(targets, targetHint);
  if (!target?.webSocketDebuggerUrl) {
    throw new Error(`No inspectable target matched "${targetHint}" at ${jsonUrl}.`);
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket connect timeout")), 10000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", (event) => {
      clearTimeout(timer);
      reject(new Error(String(event?.message || "WebSocket error")));
    }, { once: true });
  });

  let nextId = 1;
  const pending = new Map();

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

  async function send(method, params = {}, timeoutMs = 240000) {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
    });
  }

  await send("Runtime.enable");

  async function evaluate(expression, timeoutMs = 240000) {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, timeoutMs);
    return result?.result?.value;
  }

  async function close() {
    if (socket.readyState === WebSocket.CLOSED) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      socket.addEventListener("close", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.close();
    });
  }

  return {
    target,
    evaluate,
    close,
  };
}

function chatSetupSnippet(promptLiteral) {
  return `
    const plugin = app?.plugins?.getPlugin?.('systemsculpt-ai') || app?.plugins?.plugins?.['systemsculpt-ai'];
    if (!plugin) throw new Error('SystemSculpt plugin missing');
    const selectedModelId = plugin?.settings?.selectedModelId || 'systemsculpt@@systemsculpt/ai-agent';
    const existingLeaves = app.workspace.getLeavesOfType('systemsculpt-chat-view') || [];
    for (const existing of existingLeaves) {
      if (existing?.view) existing.view.__systemsculptSmokeActive = false;
    }
    const leaf = app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: 'systemsculpt-chat-view', state: { chatId: '', selectedModelId } });
    app.workspace.setActiveLeaf(leaf, { focus: true });
    if (leaf?.view) leaf.view.__systemsculptSmokeActive = true;
    const view = leaf?.view;
    const handler = view?.inputHandler;
    const input = handler?.input || handler?.inputElement || handler?.textarea;
    if (!view || !handler || !input) throw new Error('Chat runtime unavailable');
    input.value = ${promptLiteral};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const readyFn = handler.isChatReady ?? handler['isChatReady'];
    const isReady = () => typeof readyFn === 'function' ? !!readyFn.call(handler) : true;
    const readyDeadline = Date.now() + 30000;
    while (!isReady() && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!isReady()) throw new Error('Chat did not become ready');
    const sendFn = handler.handleSendMessage ?? handler['handleSendMessage'];
    if (typeof sendFn !== 'function') throw new Error('Chat send handler missing');
    const initialMessageCount = Array.isArray(view.messages) ? view.messages.length : 0;
    let turnSettled = false;
    let turnError = null;
    const sendPromise = Promise.resolve(sendFn.call(handler)).then(
      () => {
        turnSettled = true;
      },
      (error) => {
        turnSettled = true;
        turnError = error;
      }
    );
  `;
}

function chatCompletionLoopSnippet() {
  return `
    const clickApprove = () => {
      const directButtons = Array.from(document.querySelectorAll('.systemsculpt-popup [data-button-text="Approve"]'));
      const directButton = directButtons[directButtons.length - 1] || null;
      if (directButton) {
        directButton.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        directButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        directButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        directButton.click();
        return true;
      }
      const fallbackButtons = Array.from(document.querySelectorAll('button, [role="button"]'))
        .filter((element) => /approve/i.test((element.textContent || '').trim()));
      const fallbackButton = fallbackButtons[fallbackButtons.length - 1] || null;
      if (!fallbackButton) return false;
      fallbackButton.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      fallbackButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      fallbackButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      fallbackButton.click();
      return true;
    };
    const toText = (content) => {
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content.map((part) => typeof part === 'string' ? part : (part?.text || part?.content || part?.value || '')).join('');
      }
      if (content && typeof content === 'object') {
        return content.text || content.content || JSON.stringify(content);
      }
      return String(content ?? '');
    };
    const terminalStates = new Set(['completed', 'failed', 'denied']);
    const seenToolCalls = [];
    const seenToolCallIds = new Set();
    let sawChatActivity = false;
    let approvalClicks = 0;
    let timeoutState = null;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const messages = Array.isArray(view.messages) ? view.messages : [];
      const toolCalls = messages.flatMap((message) => Array.isArray(message?.tool_calls) ? message.tool_calls : []);
      for (const call of toolCalls) {
        if (!call?.id || seenToolCallIds.has(call.id)) continue;
        seenToolCallIds.add(call.id);
        seenToolCalls.push({
          id: call.id,
          name: call.request?.function?.name ?? '',
          state: call.state ?? '',
        });
      }
      if (clickApprove()) {
        approvalClicks += 1;
      }
      const popupVisible = !!document.querySelector('.systemsculpt-popup, .ss-approval-card, .ss-approval-deck');
      const messageCount = messages.length;
      const activeToolCalls = toolCalls.filter((entry) => !terminalStates.has(entry?.state)).length;
      sawChatActivity = sawChatActivity || view.isGenerating || popupVisible || activeToolCalls > 0 || messageCount > initialMessageCount;
      const lastAssistant = [...messages].reverse().find((message) => message?.role === 'assistant') || null;
      const lastAssistantText = toText(lastAssistant?.content).trim();
      if (
        sawChatActivity &&
        !view.isGenerating &&
        turnSettled &&
        activeToolCalls === 0 &&
        !popupVisible &&
        lastAssistantText.length > 0
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (!turnSettled || Date.now() >= deadline) {
      const messages = Array.isArray(view.messages) ? view.messages : [];
      const toolCalls = messages.flatMap((message) => Array.isArray(message?.tool_calls) ? message.tool_calls : []);
      timeoutState = {
        turnSettled,
        popupVisible: !!document.querySelector('.systemsculpt-popup, .ss-approval-card, .ss-approval-deck'),
        isGenerating: !!view.isGenerating,
        messageCount: messages.length,
        toolCalls: toolCalls.map((call) => ({
          id: call?.id ?? null,
          name: call?.request?.function?.name ?? '',
          state: call?.state ?? '',
        })),
      };
      throw new Error('Runtime smoke turn timed out: ' + JSON.stringify(timeoutState));
    }
    if (turnError) {
      throw turnError;
    }
    await sendPromise;
    const messages = Array.isArray(view.messages) ? view.messages.map((message) => ({
      role: message.role,
      content: message.content,
      tool_calls: message.tool_calls,
    })) : [];
    const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
  `;
}

function buildChatExactExpression(token) {
  return `(async () => {
    ${chatSetupSnippet(JSON.stringify(`Reply with exactly ${token}`))}
    ${chatCompletionLoopSnippet()}
    return {
      token: ${JSON.stringify(token)},
      selectedModelId,
      lastAssistant: toText(lastAssistant?.content).trim(),
      messageCount: messages.length,
      seenToolCalls,
      approvalClicks,
    };
  })()`;
}

function buildFileReadExpression(fixtureDir) {
  const prompt =
    `Use your filesystem tools to read ${fixtureDir}/alpha.md and ${fixtureDir}/beta.md. ` +
    "Then reply with exactly: ALPHA=ALPHA_20260311-194643; BETA=BETA_20260311-194643; SHARED=GAMMA_20260311-194643";
  return `(async () => {
    ${chatSetupSnippet(JSON.stringify(prompt))}
    ${chatCompletionLoopSnippet()}
    return {
      lastAssistant: toText(lastAssistant?.content).trim(),
      messageCount: messages.length,
      seenToolCalls,
      approvalClicks,
    };
  })()`;
}

function buildFileWriteExpression(fixtureDir, outputFileName) {
  const outputPath = `${fixtureDir}/${outputFileName}`;
  const prompt =
    `Use your filesystem tools to read ${fixtureDir}/alpha.md and ${fixtureDir}/beta.md, ` +
    `write a file at ${outputPath} containing the three lines ` +
    "ALPHA=ALPHA_20260311-194643, BETA=BETA_20260311-194643, SHARED=GAMMA_20260311-194643, " +
    "then read that file back and reply with exactly: Confirmed: ALPHA=ALPHA_20260311-194643 BETA=BETA_20260311-194643 SHARED=GAMMA_20260311-194643";
  return `(async () => {
    ${chatSetupSnippet(JSON.stringify(prompt))}
    ${chatCompletionLoopSnippet()}
    const outputPath = ${JSON.stringify(outputPath)};
    const outputFile = app.vault.getAbstractFileByPath(outputPath);
    const outputContents = outputFile ? await app.vault.read(outputFile) : null;
    return {
      outputPath,
      outputExists: !!outputFile,
      outputContents,
      lastAssistant: toText(lastAssistant?.content).trim(),
      messageCount: messages.length,
      seenToolCalls,
      approvalClicks,
    };
  })()`;
}

function buildEmbeddingsExpression(fixtureDir) {
  return `(async () => {
    const plugin = app?.plugins?.plugins?.['systemsculpt-ai'];
    if (!plugin) throw new Error('SystemSculpt plugin missing');
    const manager = await plugin.getOrCreateEmbeddingsManager();
    await manager.initialize?.();
    const alphaPath = ${JSON.stringify(`${fixtureDir}/alpha.md`)};
    const betaPath = ${JSON.stringify(`${fixtureDir}/beta.md`)};
    const alpha = app.vault.getAbstractFileByPath(alphaPath);
    const beta = app.vault.getAbstractFileByPath(betaPath);
    if (!alpha || !beta) throw new Error('Embedding fixture missing');
    await manager.processFileIfNeeded?.(alpha, 'manual');
    await manager.processFileIfNeeded?.(beta, 'manual');
    const similar = await manager.findSimilar(alphaPath, 5);
    return {
      count: Array.isArray(similar) ? similar.length : null,
      top: Array.isArray(similar) ? similar.slice(0, 5).map((item) => ({ path: item.path, score: item.score })) : similar,
    };
  })()`;
}

function buildTranscribeExpression(fixtureDir) {
  return `(async () => {
    const plugin = app?.plugins?.plugins?.['systemsculpt-ai'];
    if (!plugin) throw new Error('SystemSculpt plugin missing');
    const service = plugin.getTranscriptionService?.();
    if (!service) throw new Error('Transcription service unavailable');
    const filePath = ${JSON.stringify(`${fixtureDir}/audio-phrases.m4a`)};
    const file = app.vault.getAbstractFileByPath(filePath);
    if (!file) throw new Error('Audio fixture missing');
    const progress = [];
    const raw = await service.transcribeFile(file, {
      onProgress: (stage, message, details) => {
        progress.push({ stage, message, details });
      }
    });
    const text = typeof raw === 'string' ? raw : raw?.text ?? null;
    return {
      text,
      resultType: typeof raw,
      progress,
    };
  })()`;
}

function buildWebFetchExpression(url) {
  return `(async () => {
    const plugin = app?.plugins?.plugins?.['systemsculpt-ai'];
    if (!plugin) throw new Error('SystemSculpt plugin missing');
    const api = plugin.getWebResearchApiService?.();
    const corpus = plugin.getWebResearchCorpusService?.();
    if (!api) throw new Error('Web research API service unavailable');
    if (!corpus) throw new Error('Web research corpus service unavailable');
    const response = await api.fetch({ url: ${JSON.stringify(url)}, maxChars: 5000 });
    const chatId = 'runtime-smoke-web-' + Date.now();
    const written = await corpus.writeFetchRun({ chatId, url: ${JSON.stringify(url)}, fetch: response });
    const indexFile = app.vault.getAbstractFileByPath(written.indexPath);
    const fetchedFile = app.vault.getAbstractFileByPath(written.filePath);
    return {
      requestedUrl: ${JSON.stringify(url)},
      responseUrl: response.url,
      finalUrl: response.finalUrl,
      title: response.title,
      contentType: response.contentType,
      markdownPreview: String(response.markdown || '').slice(0, 500),
      indexPath: written.indexPath,
      filePath: written.filePath,
      indexExists: !!indexFile,
      fetchedExists: !!fetchedFile,
      indexPreview: indexFile ? String(await app.vault.read(indexFile)).slice(0, 500) : null,
    };
  })()`;
}

function buildYouTubeTranscriptExpression(url) {
  return `(async () => {
    const plugin = app?.plugins?.plugins?.['systemsculpt-ai'];
    if (!plugin) throw new Error('SystemSculpt plugin missing');
    const service = plugin.getYouTubeTranscriptService?.();
    if (!service) throw new Error('YouTube transcript service unavailable');
    const result = await service.getTranscript(${JSON.stringify(url)});
    return {
      url: ${JSON.stringify(url)},
      lang: result?.lang ?? null,
      textLength: String(result?.text || '').length,
      excerpt: String(result?.text || '').slice(0, 500),
      metadata: result?.metadata ?? null,
    };
  })()`;
}

async function runCase(runtime, options, caseName) {
  switch (caseName) {
    case "chat-exact": {
      return await runtime.evaluate(buildChatExactExpression("RUNTIME_SMOKE_OK_20260311"));
    }
    case "file-read": {
      return await runtime.evaluate(buildFileReadExpression(options.fixtureDir));
    }
    case "file-write": {
      return await runtime.evaluate(buildFileWriteExpression(
        options.fixtureDir,
        options.mode === "android" ? "android-output-write.md" : "runtime-output-write.md",
      ));
    }
    case "embeddings": {
      return await runtime.evaluate(buildEmbeddingsExpression(options.fixtureDir));
    }
    case "transcribe": {
      return await runtime.evaluate(buildTranscribeExpression(options.fixtureDir));
    }
    case "web-fetch": {
      return await runtime.evaluate(buildWebFetchExpression(options.webFetchUrl));
    }
    case "youtube-transcript": {
      return await runtime.evaluate(buildYouTubeTranscriptExpression(options.youtubeUrl), 480000);
    }
    default:
      throw new Error(`Unsupported case: ${caseName}`);
  }
}

function caseList(caseName) {
  if (caseName === "all") {
    return CORE_CASES;
  }
  if (caseName === "extended") {
    return EXTENDED_CASES;
  }
  return [caseName];
}

function assertCaseResult(caseName, options, result) {
  if (!result || typeof result !== "object") {
    throw new Error(`${caseName} returned no result payload.`);
  }

  if (caseName === "chat-exact") {
    const expected = "RUNTIME_SMOKE_OK_20260311";
    if (result.lastAssistant !== expected) {
      throw new Error(`${caseName} expected "${expected}" but got "${result.lastAssistant || ""}".`);
    }
    return;
  }

  if (caseName === "file-read") {
    const expected =
      "ALPHA=ALPHA_20260311-194643; BETA=BETA_20260311-194643; SHARED=GAMMA_20260311-194643";
    if (result.lastAssistant !== expected) {
      throw new Error(`${caseName} expected exact fixture echo but got "${result.lastAssistant || ""}".`);
    }
    return;
  }

  if (caseName === "file-write") {
    const expectedAssistant =
      "Confirmed: ALPHA=ALPHA_20260311-194643 BETA=BETA_20260311-194643 SHARED=GAMMA_20260311-194643";
    const expectedLines = [
      "ALPHA=ALPHA_20260311-194643",
      "BETA=BETA_20260311-194643",
      "SHARED=GAMMA_20260311-194643",
    ];
    if (result.lastAssistant !== expectedAssistant) {
      throw new Error(`${caseName} expected confirmed echo but got "${result.lastAssistant || ""}".`);
    }
    if (!result.outputExists) {
      throw new Error(`${caseName} did not create ${result.outputPath || "the output file"}.`);
    }
    const outputContents = String(result.outputContents || "");
    for (const line of expectedLines) {
      if (!outputContents.includes(line)) {
        throw new Error(`${caseName} output file is missing "${line}".`);
      }
    }
    return;
  }

  if (caseName === "embeddings") {
    const topPath = String(result?.top?.[0]?.path || "");
    if (!topPath.endsWith("/beta.md") && !topPath.endsWith("beta.md")) {
      throw new Error(`${caseName} expected beta.md as the closest match but got "${topPath}".`);
    }
    return;
  }

  if (caseName === "transcribe") {
    const text = String(result.text || "");
    const requiredPhrases = [
      "Crimson Harbor",
      "Silver Cactus",
      "Golden Lantern",
    ];
    for (const phrase of requiredPhrases) {
      if (!text.includes(phrase)) {
        throw new Error(`${caseName} is missing transcription phrase "${phrase}".`);
      }
    }
    return;
  }

  if (caseName === "web-fetch") {
    const markdownPreview = String(result.markdownPreview || "");
    const normalizeHost = (value) => {
      if (!value) return "";
      try {
        return new URL(String(value)).host.replace(/^www\./, "").toLowerCase();
      } catch {
        return "";
      }
    };
    const expectedHost = normalizeHost(options.webFetchUrl);
    const actualUrl = String(result.finalUrl || result.responseUrl || result.requestedUrl || "");
    const actualHost = normalizeHost(actualUrl);
    if (!expectedHost || actualHost !== expectedHost) {
      throw new Error(`${caseName} expected host "${expectedHost}" but got "${actualHost}" from "${actualUrl}".`);
    }
    if (markdownPreview.trim().length < 80) {
      throw new Error(`${caseName} did not return enough fetched content.`);
    }
    if (!result.indexExists || !result.fetchedExists) {
      throw new Error(`${caseName} did not write the fetched corpus artifacts to the vault.`);
    }
    return;
  }

  if (caseName === "youtube-transcript") {
    const textLength = Number(result.textLength || 0);
    if (!Number.isFinite(textLength) || textLength < 1000) {
      throw new Error(`${caseName} expected a substantial transcript but got length ${result.textLength || 0}.`);
    }
    return;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const jsonUrl = await ensureJsonUrl(options);
  const runtime = await connectToRuntime(jsonUrl, options.targetHint);
  const iterations = [];

  try {
    for (let iteration = 0; iteration < options.repeat; iteration += 1) {
      const results = {};
      for (const caseName of caseList(options.caseName)) {
        console.log(
          `[runtime-smoke] Running ${caseName} via ${options.mode} (iteration ${iteration + 1}/${options.repeat})`
        );
        results[caseName] = await runCase(runtime, options, caseName);
        assertCaseResult(caseName, options, results[caseName]);
      }
      iterations.push({
        iteration: iteration + 1,
        results,
      });
      if (iteration + 1 < options.repeat && options.pauseMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.pauseMs));
      }
    }
  } finally {
    await runtime.close();
  }

  const payload = {
    mode: options.mode,
    jsonUrl,
    targetTitle: runtime.target?.title || "",
    targetUrl: runtime.target?.url || "",
    fixtureDir: options.fixtureDir,
    webFetchUrl: options.webFetchUrl,
    youtubeUrl: options.youtubeUrl,
    repeat: options.repeat,
    iterations,
  };

  if (options.jsonOutput) {
    await fs.writeFile(options.jsonOutput, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
