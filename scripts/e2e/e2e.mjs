#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { DriverSession, resolvePluginTarget, runSteps } from "./driver-session.mjs";

/**
 * SystemSculpt E2E CLI.
 *
 * Drives the real Obsidian GUI through the in-plugin test driver: every verb
 * becomes a synthesized user interaction (click, type, key press, file
 * attach, scroll) on the live DOM. Requires Obsidian running with a
 * development, staging, or local-agent build of the plugin.
 *
 *   npm run e2e -- status
 *   npm run e2e -- open-chat
 *   npm run e2e -- click chat.header.new
 *   npm run e2e -- type "Hello from the CLI" --submit
 *   npm run e2e -- press Enter
 *   npm run e2e -- attach ./notes/diagram.png
 *   npm run e2e -- scroll top
 *   npm run e2e -- snapshot chat
 *   npm run e2e -- wait chat.composer.send enabled
 *   npm run e2e -- settings --tab Chat
 *   npm run e2e -- query "css:.systemsculpt-agent-turn"
 *   npm run e2e -- command systemsculpt-ai:open-chat
 *   npm run e2e -- script testing/e2e/scenarios/chat-composer-journey.mjs
 *
 * Targets are canonical data-testid values (list them with
 * `npm run e2e -- targets`), plus css:, chat:, label:, setting:, and
 * settings.tab: prefixes. See src/testing/driver/locators.ts.
 */

const MIME_BY_EXTENSION = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
};

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const valueFlags = new Set([
      "plugin-dir", "vault", "target", "text", "mime", "name", "via",
      "timeout", "connect-timeout", "tab", "evidence", "mode", "limit",
      "pattern", "level", "since",
    ]);
    if (valueFlags.has(key)) {
      flags[key] = argv[index + 1];
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { positional, flags };
}

function stepsForVerb(positional, flags) {
  const [verb, ...rest] = positional;
  const target = flags.target;
  switch (verb) {
    case "status":
      return [{ action: "status" }];
    case "open-chat":
      return [{ action: "chat.open" }];
    case "click": {
      if (!rest[0]) throw new Error("click requires a target, e.g. click chat.header.new");
      return [{ action: "click", params: { target: rest[0] } }];
    }
    case "type": {
      if (rest.length === 0) throw new Error('type requires text, e.g. type "Hello"');
      return [{
        action: "type",
        params: {
          text: rest.join(" "),
          target,
          mode: flags.append ? "append" : "replace",
          submit: flags.submit === true,
        },
      }];
    }
    case "press": {
      if (!rest[0]) throw new Error("press requires a key, e.g. press Enter");
      return [{
        action: "press",
        params: {
          key: rest[0],
          target,
          shift: flags.shift === true,
          ctrl: flags.ctrl === true,
          alt: flags.alt === true,
          meta: flags.meta === true,
        },
      }];
    }
    case "attach": {
      if (!rest[0]) throw new Error("attach requires a file path, e.g. attach ./image.png");
      const filePath = path.resolve(rest[0]);
      const data = fs.readFileSync(filePath);
      const extension = path.extname(filePath).toLowerCase();
      return [{
        action: "attach",
        params: {
          name: flags.name ?? path.basename(filePath),
          mimeType: flags.mime ?? MIME_BY_EXTENSION[extension] ?? "application/octet-stream",
          dataBase64: data.toString("base64"),
          via: flags.via === "drop" ? "drop" : "picker",
        },
      }];
    }
    case "scroll": {
      const to = rest[0] ?? "bottom";
      const params = { target };
      if (to === "top" || to === "bottom") params.to = to;
      else params.deltaY = Number(to);
      return [{ action: "scroll", params }];
    }
    case "read": {
      if (!rest[0]) throw new Error("read requires a target.");
      return [{ action: "read", params: { target: rest[0] } }];
    }
    case "query": {
      if (!rest[0]) throw new Error("query requires a css selector.");
      const css = rest[0].startsWith("css:") ? rest[0].slice(4) : rest[0];
      return [{ action: "query", params: { css, limit: flags.limit ? Number(flags.limit) : undefined } }];
    }
    case "snapshot":
      return [{ action: "snapshot", params: { scope: rest[0] ?? "chat" } }];
    case "wait": {
      if (!rest[0] || !rest[1]) {
        throw new Error("wait requires a target and state, e.g. wait chat.composer.send enabled");
      }
      return [{
        action: "waitFor",
        params: {
          target: rest[0],
          state: rest[1],
          text: flags.text,
          timeoutMs: flags.timeout ? Number(flags.timeout) : undefined,
        },
      }];
    }
    case "command": {
      if (!rest[0]) throw new Error("command requires an Obsidian command id.");
      return [{ action: "command", params: { id: rest[0] } }];
    }
    case "settings":
      return [{ action: "settings.open", params: { tab: flags.tab } }];
    case "settings-close":
      return [{ action: "settings.close" }];
    case "targets":
      return [{ action: "catalog" }];
    case "logs":
      return [{ action: "logs", params: {
        level: flags.level,
        pattern: flags.pattern,
        sinceSeq: flags.since ? Number(flags.since) : undefined,
        limit: flags.limit ? Number(flags.limit) : undefined,
      } }];
    case "notices":
      return [{ action: "notices", params: {
        sinceSeq: flags.since ? Number(flags.since) : undefined,
        limit: flags.limit ? Number(flags.limit) : undefined,
      } }];
    case "select": {
      if (!rest[0] || rest[1] === undefined) {
        throw new Error('select requires a target and value, e.g. select chat.composer.approval-mode full-access');
      }
      return [{ action: "select", params: { target: rest[0], value: rest[1] } }];
    }
    default:
      throw new Error(
        `Unknown verb "${verb ?? ""}". Verbs: status, open-chat, click, type, press, attach, ` +
          "scroll, select, read, query, logs, notices, snapshot, wait, command, settings, " +
          "settings-close, targets, script.",
      );
  }
}

async function loadScriptSteps(scriptPath) {
  const resolved = path.resolve(scriptPath);
  if (resolved.endsWith(".json")) {
    const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
    const steps = Array.isArray(parsed) ? parsed : parsed?.steps;
    if (!Array.isArray(steps)) {
      throw new Error("A JSON scenario must be an array of steps or {steps: [...]}.");
    }
    return steps;
  }
  const module = await import(pathToFileURL(resolved).href);
  const exported = module.default ?? module.steps;
  const steps = typeof exported === "function" ? await exported() : exported;
  if (!Array.isArray(steps)) {
    throw new Error("A scenario module must default-export an array of steps or a function returning one.");
  }
  return steps;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (positional.length === 0 || flags.help) {
    console.log("Usage: npm run e2e -- <verb> [args] [--vault name] [--plugin-dir path] [--json]");
    console.log("Verbs: status, open-chat, click, type, press, attach, scroll, select, read,");
    console.log("       query, logs, notices, snapshot, wait, command, settings,");
    console.log("       settings-close, targets [--live], script <file>");
    console.log("Targets are data-testid values (npm run e2e -- targets), plus css:, chat:,");
    console.log("label:, setting:, and settings.tab: prefixes.");
    process.exit(positional.length === 0 ? 1 : 0);
  }

  if (positional[0] === "targets" && !flags.live) {
    const catalogPath = path.resolve("testing/e2e/testid-catalog.json");
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    console.log(JSON.stringify(catalog, null, flags.json ? 0 : 2));
    process.exit(0);
  }

  if (positional[0] === "script" && !positional[1]) {
    throw new Error("script requires a file path.");
  }
  const steps = positional[0] === "script"
    ? await loadScriptSteps(positional[1])
    : stepsForVerb(positional, flags);

  const targetInfo = resolvePluginTarget({
    explicitPath: flags["plugin-dir"] ?? "",
    vaultName: flags.vault ?? "",
  });
  const session = new DriverSession({
    pluginDir: targetInfo.path,
    connectTimeoutMs: flags["connect-timeout"] ? Number(flags["connect-timeout"]) : 20000,
    actionTimeoutMs: flags.timeout ? Number(flags.timeout) : 60000,
  });

  let outcome;
  try {
    const hello = await session.connect();
    if (!flags.json) {
      console.error(
        `[e2e] Connected: vault "${hello.vault}", plugin ${hello.pluginVersion} (${hello.buildStamp})`,
      );
    }
    outcome = await runSteps(session, steps);
  } finally {
    session.close();
  }

  const report = { vault: targetInfo.vault, ...outcome };
  if (flags.evidence) {
    fs.mkdirSync(path.dirname(path.resolve(flags.evidence)), { recursive: true });
    fs.writeFileSync(path.resolve(flags.evidence), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report, null, flags.json ? 0 : 2));
  process.exit(outcome.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(`[e2e] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
