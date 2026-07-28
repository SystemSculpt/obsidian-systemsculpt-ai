import "./globals";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import manifest from "../../manifest.json";
import fixture from "../../testing/fixtures/managed/managed-capabilities-v2.json";
import type { ChatMessage } from "../../src/types";
import { PlatformRequestClient, type PlatformRequestInput } from "../../src/services/PlatformRequestClient";
import { ManagedCapabilityClient } from "../../src/services/managed/ManagedCapabilityClient";
import { HostedTransportAdapter } from "../../src/services/managed/adapters/HostedTransportAdapter";
import { createAcceptedManagedChatRequestSnapshot } from "../../src/services/chat/AcceptedChatRequestSnapshot";
import type { AcceptedManagedChatOperation, ManagedAllowedLease } from "../../src/services/managed/ManagedTypes";
import type { AgentTranscriptSnapshot } from "../../src/views/chatview/AgentTranscriptRepository";
import {
  ManagedAgentController,
  type ManagedAgentControllerHost,
} from "../../src/views/chatview/ManagedAgentController";
import { ChatMarkdownSerializer } from "../../src/views/chatview/storage/ChatMarkdownSerializer";
import { ManagedChatRuntimeAdapter } from "../../src/views/chatview/turn/ManagedChatRuntimeAdapter";

// Live release smoke: drives the REAL controller, runtime adapter, capability
// client, and transport against production with server-side web search on,
// then sends a follow-up turn over the settled transcript. This exercises the
// three seams unit tests cannot: the true server wire shape, the adapter's
// pre-HTTP rejections, and the server's transcript validation of what this
// client actually sends. Requires a license key; never runs in CI.

const BASE_URL = "https://systemsculpt.com";
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) obsidian/1.9.1 Chrome/132.0.6834.196 Electron/34.3.0 Safari/537.36";
const DEFAULT_KEY_SOURCE = join(
  homedir(),
  ".codex",
  "qa-vaults",
  "systemsculpt-v6",
  ".obsidian",
  "plugins",
  "systemsculpt-ai",
  "data.json",
);

function licenseKey(): string {
  const fromEnvironment = process.env.SYSTEMSCULPT_LICENSE_KEY?.trim();
  if (fromEnvironment) return fromEnvironment;
  try {
    const data = JSON.parse(readFileSync(DEFAULT_KEY_SOURCE, "utf8")) as { licenseKey?: string };
    if (data.licenseKey) return data.licenseKey;
  } catch {
    // fall through to the error below
  }
  console.error("[smoke] FAIL: no license key. Set SYSTEMSCULPT_LICENSE_KEY or provide a QA vault data.json.");
  process.exit(3);
}

class NodeRequestClient extends PlatformRequestClient {
  public override async request(input: PlatformRequestInput): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: input.stream ? "text/event-stream" : "application/json",
      "User-Agent": BROWSER_UA,
      ...(input.licenseKey ? { "x-license-key": input.licenseKey } : {}),
      ...(input.headers || {}),
    };
    return fetch(input.url, {
      method: input.method,
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }
}

function createLiveHarness(key: string, initialMessages: readonly ChatMessage[] = []) {
  const descriptor = fixture.capabilities.find((entry) => entry.alias === "systemsculpt/chat")!;
  const requestContract = descriptor.request_contracts.find(
    (entry) => entry.capability === "chat_turn",
  )!;
  const lease = Object.freeze({ outcome: "allowed", descriptor, requestContract }) as ManagedAllowedLease;

  const transport = new HostedTransportAdapter({
    baseUrl: BASE_URL,
    pluginVersion: manifest.version,
    licenseKey: () => key,
    requestClient: new NodeRequestClient(),
  });
  const client = new ManagedCapabilityClient({ admission: null as never, transport });
  const adapter = new ManagedChatRuntimeAdapter(client, {
    get: () => undefined,
    invalidate: async () => undefined,
  });

  let version = initialMessages.length;
  let messages = JSON.parse(JSON.stringify(initialMessages)) as ChatMessage[];
  const snapshot = (): AgentTranscriptSnapshot => Object.freeze({
    chatId: "live-smoke",
    title: "Live smoke",
    version,
    backend: "systemsculpt",
    messages: Object.freeze(JSON.parse(JSON.stringify(messages)) as ChatMessage[]),
  });
  const upsert = (message: ChatMessage) => {
    const index = messages.findIndex((candidate) => candidate.message_id === message.message_id);
    if (index < 0) messages.push(JSON.parse(JSON.stringify(message)) as ChatMessage);
    else messages[index] = JSON.parse(JSON.stringify(message)) as ChatMessage;
    version += 1;
    return snapshot();
  };

  const host: ManagedAgentControllerHost = {
    acquireChatTurnLease: async () => ({ outcome: "allowed" as const, lease }),
    commitUser: async (input) => {
      messages.push(JSON.parse(JSON.stringify(input.message)) as ChatMessage);
      version += 1;
      return snapshot();
    },
    claimUser: () => true,
    prepareAcceptedRequest: async (operation: AcceptedManagedChatOperation) =>
      createAcceptedManagedChatRequestSnapshot({
        operation,
        policy: {
          contextCount: 0,
          imageContextIncluded: false,
          documentContextIncluded: false,
          tools: "normalized" as const,
        },
        managedMessages: operation.initialDurableSnapshot.messages,
        managedTools: [],
        webSearch: true,
      }),
    persistAssistant: async (message) => upsert(message),
    persistAssistantWithSession: async (message) => upsert(message),
    clearSessionCheckpoint: async () => undefined,
    snapshot,
    executeLocalTool: async () => ({
      success: false,
      error: { code: "SMOKE_NO_VAULT", message: "Vault tools are unavailable in the live smoke." },
    }),
    refreshCredits: () => undefined,
    reportError: (error) => console.error("[smoke] controller reported:", error),
  };

  const startTurn = (content: string) => new ManagedAgentController({ host, runtime: adapter }).start({
    commit: {
      kind: "append",
      message: {
        role: "user",
        content,
        message_id: `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      },
    },
  });

  return { startTurn, transcript: snapshot };
}

async function main(): Promise<void> {
  const key = licenseKey();
  const harness = createLiveHarness(key);

  console.log("[smoke] turn 1: forcing a server-side web search…");
  const first = await harness.startTurn(
    "Use web search to find one AI news headline from this week, then answer in one short sentence.",
  );
  if (first.kind !== "completed") {
    console.error(`[smoke] FAIL: search turn ended ${first.kind}`, JSON.stringify((first as { error?: unknown }).error ?? null));
    process.exit(1);
  }
  const assistant = harness.transcript().messages.at(-1);
  const serverCalls = (assistant?.tool_calls ?? []).filter((call) => call.executedOn === "server");
  console.log(`[smoke] turn 1 completed; server-executed calls settled: ${serverCalls.length}`);
  if (serverCalls.length === 0) {
    console.error("[smoke] FAIL: the model did not use server-side web search, so the incident path was not exercised. Re-run.");
    process.exit(2);
  }
  if (serverCalls.some((call) => call.state !== "completed" && call.state !== "failed")) {
    console.error("[smoke] FAIL: a server-executed call did not settle.");
    process.exit(1);
  }

  const firstSnapshot = harness.transcript();
  const serialized = ChatMarkdownSerializer.serializeMessages([...firstSnapshot.messages]);
  const now = new Date().toISOString();
  const reloaded = ChatMarkdownSerializer.parseMarkdown([
    "---",
    "id: live-smoke",
    `created: ${now}`,
    `lastModified: ${now}`,
    "title: Live smoke",
    "version: 1",
    "---",
    "",
    serialized,
  ].join("\n"));
  if (!reloaded || reloaded.messages.length !== firstSnapshot.messages.length) {
    console.error("[smoke] FAIL: the settled search transcript did not survive save/reload.");
    process.exit(1);
  }

  const legacyReload = JSON.parse(JSON.stringify(reloaded.messages)) as ChatMessage[];
  for (const message of legacyReload) {
    for (const call of message.tool_calls ?? []) {
      if (call.executedOn === "server") {
        delete (call as { executedOn?: string }).executedOn;
      }
    }
  }
  const reloadedHarness = createLiveHarness(key, legacyReload);
  console.log("[smoke] turn 2: follow-up after save/reload over legacy server-tool history…");
  const second = await reloadedHarness.startTurn(
    "Thanks — now answer in one short sentence: why does that headline matter?",
  );
  if (second.kind !== "completed") {
    console.error(`[smoke] FAIL: follow-up after search ended ${second.kind}`, JSON.stringify((second as { error?: unknown }).error ?? null));
    process.exit(1);
  }
  console.log("[smoke] OK: search turn and follow-up both completed against production.");
}

void main().catch((error) => {
  console.error("[smoke] FAIL:", error);
  process.exit(1);
});
