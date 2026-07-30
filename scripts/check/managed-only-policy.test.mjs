import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { toRepositoryPath } from "../platform-portability.mjs";

const PRODUCTION_ROOTS = ["src"];
const NETWORK_OWNERSHIP_ROOTS = [
  "src/services/managed",
  "src/services/images",
  "src/services/transcription",
  "src/services/workflow/WorkflowEngineService.ts",
  "src/services/DocumentProcessingService.ts",
  "src/services/PostProcessingService.ts",
  "src/services/TitleGenerationService.ts",
];
const FORBIDDEN_PACKAGES = [
  "openai",
  "@anthropic-ai/sdk",
  "@google/generative-ai",
  "@openai/codex",
  "@ai-sdk",
  "@cloudflare/ai-chat",
  "@cloudflare/think",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@mariozechner/pi-ai",
  "@mariozechner/pi-agent-core",
  "@mariozechner/pi-coding-agent",
  "@openrouter/agent",
  "@openrouter/ai-sdk-provider",
  "@openrouter/sdk",
  "agents",
  "ai",
];
const THIN_CLIENT_IMPORT_ALLOWLIST = new Map([
  ["src/views/chatview/thin/ThinAgentConnection.ts", new Map([
    ["agents/client", new Set(["value:AgentClient"])],
    ["agents/chat", new Set(["value:MessageType"])],
    ["agents/chat/react", new Set(["value:WebSocketChatTransport"])],
    ["ai", new Set(["type:UIMessage", "value:safeValidateUIMessages"])],
  ])],
  ["src/views/chatview/thin/ThinAgentBridge.ts", new Map([
    ["agents/chat", new Set(["value:MessageType"])],
    ["agents/chat/react", new Set([
      "type:WebSocketChatTransport",
      "value:getToolApproval",
      "value:getToolCallId",
      "value:getToolInput",
      "value:getToolPartState",
    ])],
    ["ai", new Set([
      "type:UIMessage",
      "value:getToolName",
      "value:isToolUIPart",
    ])],
  ])],
  ["src/views/chatview/thin/ThinAgentHeadlessChat.ts", new Map([
    ["ai", new Set([
      "type:ChatInit",
      "type:ChatState",
      "type:ChatStatus",
      "type:UIMessage",
      "value:AbstractChat",
    ])],
  ])],
  ["src/views/chatview/thin/ThinAgentMessageAdapter.ts", new Map([
    ["ai", new Set(["type:UIMessage"])],
  ])],
  ["src/views/chatview/thin/ThinAgentProjection.ts", new Map([
    ["agents/chat/react", new Set([
      "value:getToolApproval",
      "value:getToolCallId",
      "value:getToolInput",
      "value:getToolOutput",
      "value:getToolPartState",
    ])],
    ["ai", new Set([
      "type:UIMessage",
      "value:getToolName",
      "value:isToolUIPart",
    ])],
  ])],
]);
const THIN_CLIENT_DEPENDENCIES = new Set(["@ai-sdk/react", "agents", "ai", "react"]);
const CHAT_AUTHORITY_ROOTS = [
  "src/services/chat/",
  "src/services/managed/",
  "src/views/chatview/",
];
const CUSTOM_PROVIDER = /\bCustomProvider\b|\bcustomProviders?\b|\bcustom[_-]?provider\b|\bcustomEndpoint\b|\bcustom_endpoint\b|\bproviderOAuth\b|\bproviderAuth\b/i;
const CLIENT_HARNESS_MARKER = /\bpi-client-v\d+\b|SYSTEMSCULPT_CHAT_HARNESS|__SYSTEMSCULPT_CHAT_HARNESS__|x-systemsculpt-agent-runtime/i;
const RETIRED_CLIENT_SURFACE = /\bWebResearchApiService\b|\bWebResearchCorpusService\b|\/api\/plugin\/web\/(?:search|fetch)\b/i;
const RETIRED_TOOL_ARCHITECTURE = /\bMCP(?:Service|FilesystemServer|YouTubeServer|ToolInfo)\b|\b(?:Filesystem|YouTube)Adapter\b|mcp-filesystem[_:]|mcp-youtube[_:]/;
const LEGACY_ALLOWLIST = new Set([
  "src/core/settings/migrations/SettingsMigrator.ts",
]);
const TOOL_COMPATIBILITY_ALLOWLIST = new Set([
  "src/tools/toolNames.ts",
]);
const RETIRED_CHAT_TOOL_PREFIX = /\bfilesystem_[a-z0-9_]+\b|\bmcp[-_:][a-z0-9_-]+/i;
const CLIENT_CONTINUATION_POLICY = /\bautoContinue\b/;

const CHAT_AUTHORITY_CONCEPTS = [
  {
    label: "client-owned model routing",
    matches(words) {
      return hasAny(words, ["model", "models"])
        && hasAny(words, [
          "available",
          "catalog",
          "choose",
          "default",
          "fallback",
          "preferred",
          "registry",
          "resolve",
          "route",
          "router",
          "routing",
          "select",
          "selection",
          "selector",
        ]);
    },
  },
  {
    label: "client-owned prompt orchestration",
    matches(words) {
      return hasAny(words, ["instruction", "instructions", "prompt", "prompts"])
        && hasAny(words, [
          "assemble",
          "assembly",
          "build",
          "builder",
          "compose",
          "composer",
          "inject",
          "merge",
          "orchestrate",
          "orchestrator",
          "select",
          "selector",
          "system",
          "template",
        ]);
    },
  },
  {
    label: "client-owned provider retry",
    matches(words) {
      return hasAny(words, ["provider", "providers"])
        && hasAny(words, [
          "attempt",
          "attempts",
          "backoff",
          "fallback",
          "recover",
          "recovery",
          "retries",
          "retry",
        ]);
    },
  },
  {
    label: "client-owned conversation compaction",
    matches(words) {
      return hasAny(words, [
        "compact",
        "compaction",
        "compactor",
        "summarize",
        "summarizer",
        "summary",
      ]) && hasAny(words, [
        "context",
        "conversation",
        "history",
        "message",
        "messages",
        "transcript",
      ]);
    },
  },
  {
    label: "client-owned continuation budget",
    matches(words) {
      const hasConstraint = hasAny(words, [
        "budget",
        "budgets",
        "count",
        "counter",
        "depth",
        "limit",
        "limits",
        "max",
        "maximum",
      ]);
      const hasRoundOrStep = hasAny(words, [
        "round",
        "rounds",
        "step",
        "steps",
      ]);
      return (
        hasAny(words, ["continuation", "continuations"])
        && (hasConstraint || hasRoundOrStep)
      ) || (
        hasAny(words, ["agent", "model", "tool", "tools"])
        && hasRoundOrStep
        && hasConstraint
      );
    },
  },
];

function productionFiles(entry) {
  const absolute = path.resolve(entry);
  if (!fs.existsSync(absolute)) return [];
  if (fs.statSync(absolute).isFile()) return [absolute];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((item) => {
    if (item.name === "__tests__") return [];
    return productionFiles(path.join(absolute, item.name));
  }).filter((file) => file.endsWith(".ts"));
}

function sourceFiles(entry) {
  const absolute = path.resolve(entry);
  if (!fs.existsSync(absolute)) return [];
  if (fs.statSync(absolute).isFile()) return absolute.endsWith(".ts") ? [absolute] : [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((item) =>
    sourceFiles(path.join(absolute, item.name)));
}

function isForbiddenPackageSpecifier(specifier) {
  return FORBIDDEN_PACKAGES.some(
    (name) => specifier === name || specifier.startsWith(`${name}/`),
  );
}

function importedBindings(source, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const bindings = new Map();
  const add = (specifier, binding) => {
    bindings.set(`${specifier}\0${binding}`, { specifier, binding });
  };
  const moduleSpecifier = (node) =>
    node && ts.isStringLiteralLike(node) ? node.text : null;

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const specifier = moduleSpecifier(node.moduleSpecifier);
      if (specifier) {
        const clause = node.importClause;
        if (!clause) {
          add(specifier, "side-effect:*");
        } else {
          if (clause.name) {
            add(specifier, `${clause.isTypeOnly ? "type" : "value"}:default`);
          }
          const named = clause.namedBindings;
          if (named && ts.isNamespaceImport(named)) {
            add(specifier, `${clause.isTypeOnly ? "type" : "value"}:*`);
          } else if (named && ts.isNamedImports(named)) {
            for (const item of named.elements) {
              const importedName = (item.propertyName ?? item.name).text;
              add(
                specifier,
                `${clause.isTypeOnly || item.isTypeOnly ? "type" : "value"}:${importedName}`,
              );
            }
          }
        }
      }
    } else if (ts.isExportDeclaration(node)) {
      const specifier = moduleSpecifier(node.moduleSpecifier);
      if (specifier) {
        if (!node.exportClause) {
          add(specifier, "re-export:*");
        } else if (ts.isNamespaceExport(node.exportClause)) {
          add(specifier, "re-export:*");
        } else {
          for (const item of node.exportClause.elements) {
            add(specifier, `re-export:${(item.propertyName ?? item.name).text}`);
          }
        }
      }
    } else if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
    ) {
      const specifier = moduleSpecifier(node.moduleReference.expression);
      if (specifier) add(specifier, "import-equals:*");
    } else if (ts.isImportTypeNode(node)) {
      const argument = ts.isLiteralTypeNode(node.argument)
        ? moduleSpecifier(node.argument.literal)
        : null;
      if (argument) {
        add(argument, `import-type:${node.qualifier?.getText(sourceFile) ?? "*"}`);
      }
    } else if (
      ts.isCallExpression(node)
      && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0])
      && (
        node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require")
      )
    ) {
      add(node.arguments[0].text, "dynamic:*");
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return Array.from(bindings.values());
}

function vendorImportViolations(source, relative) {
  const allowedModules = THIN_CLIENT_IMPORT_ALLOWLIST.get(relative) ?? new Map();
  return importedBindings(source, relative).flatMap(({ specifier, binding }) => {
    if (!isForbiddenPackageSpecifier(specifier)) return [];
    const allowedBindings = allowedModules.get(specifier) ?? new Set();
    return allowedBindings.has(binding)
      ? []
      : [`${relative}: vendor import ${specifier} (${binding})`];
  });
}

function normalizedWords(value) {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function hasAny(words, candidates) {
  return candidates.some((candidate) => words.includes(candidate));
}

function chatAuthorityConceptViolations(source, relative) {
  if (!CHAT_AUTHORITY_ROOTS.some((root) => relative.startsWith(root))) return [];
  const sourceFile = ts.createSourceFile(
    relative,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const identifiers = new Set([path.basename(relative, path.extname(relative))]);
  const visit = (node) => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      identifiers.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return CHAT_AUTHORITY_CONCEPTS.flatMap(({ label, matches }) => {
    const identifier = Array.from(identifiers).find((value) =>
      matches(normalizedWords(value)));
    return identifier ? [`${relative}: ${label} (${identifier})`] : [];
  });
}

function authorityViolations(file) {
  const source = fs.readFileSync(file, "utf8");
  const relative = toRepositoryPath(path.relative(process.cwd(), file));
  const findings = [
    ...vendorImportViolations(source, relative),
    ...chatAuthorityConceptViolations(source, relative),
  ];
  if (!LEGACY_ALLOWLIST.has(relative) && CUSTOM_PROVIDER.test(source)) {
    findings.push(`${relative}: custom-provider concept`);
  }
  if (RETIRED_CLIENT_SURFACE.test(source)) findings.push(`${relative}: retired client surface`);
  if (CLIENT_HARNESS_MARKER.test(source)) findings.push(`${relative}: client harness marker`);
  if (!TOOL_COMPATIBILITY_ALLOWLIST.has(relative) && RETIRED_TOOL_ARCHITECTURE.test(source)) {
    findings.push(`${relative}: retired tool architecture`);
  }
  if (relative.startsWith("src/views/chatview/") && CLIENT_CONTINUATION_POLICY.test(source)) {
    findings.push(`${relative}: client-owned continuation policy`);
  }
  return findings;
}

function networkViolations(file) {
  const source = fs.readFileSync(file, "utf8");
  const relative = toRepositoryPath(path.relative(process.cwd(), file));
  const findings = [];
  for (const [raw] of source.matchAll(/https?:\/\/[^\s"'\`<>)}\]]+/g)) {
    try {
      const url = new URL(raw);
      const host = url.hostname.toLowerCase();
      if (url.protocol !== "https:" || (host !== "systemsculpt.com" && !host.endsWith(".systemsculpt.com"))) {
        findings.push(`${relative}: non-SystemSculpt destination ${raw}`);
      }
    } catch {
      findings.push(`${relative}: malformed absolute destination ${raw}`);
    }
  }
  return findings;
}

test("thin protocol SDK imports match the exact file, entrypoint, symbol, and import kind", () => {
  for (const [relative, allowedModules] of THIN_CLIENT_IMPORT_ALLOWLIST) {
    const absolute = path.resolve(relative);
    assert.equal(fs.existsSync(absolute), true, `${relative} is missing`);
    const actual = importedBindings(fs.readFileSync(absolute, "utf8"), relative)
      .filter(({ specifier }) => isForbiddenPackageSpecifier(specifier))
      .map(({ specifier, binding }) => `${specifier}:${binding}`)
      .sort();
    const expected = Array.from(allowedModules.entries())
      .flatMap(([specifier, bindings]) =>
        Array.from(bindings, (binding) => `${specifier}:${binding}`))
      .sort();
    assert.deepEqual(actual, expected, `${relative} import authority changed`);
  }
});

test("thin protocol import policy rejects authority-expanding import mutations", () => {
  const relative = "src/views/chatview/thin/ThinAgentConnection.ts";
  const mutations = [
    {
      label: "extra named symbol",
      source: 'import { AgentClient, Agent } from "agents/client";',
      expected: /value:Agent/u,
    },
    {
      label: "aliased authority symbol",
      source: 'import { useChat as AgentClient } from "agents/client";',
      expected: /value:useChat/u,
    },
    {
      label: "value import of a type-only symbol",
      source: 'import { UIMessage } from "ai";',
      expected: /value:UIMessage/u,
    },
    {
      label: "namespace import",
      source: 'import * as AgentSdk from "agents/client";',
      expected: /value:\*/u,
    },
    {
      label: "default import",
      source: 'import AgentSdk from "agents/client";',
      expected: /value:default/u,
    },
    {
      label: "dynamic import",
      source: 'const sdk = await import("agents/client");',
      expected: /dynamic:\*/u,
    },
    {
      label: "CommonJS import",
      source: 'const sdk = require("agents/client");',
      expected: /dynamic:\*/u,
    },
    {
      label: "re-export",
      source: 'export { AgentClient } from "agents/client";',
      expected: /re-export:AgentClient/u,
    },
    {
      label: "type query",
      source: 'type Client = import("agents/client").AgentClient;',
      expected: /import-type:AgentClient/u,
    },
  ];

  for (const mutation of mutations) {
    const findings = vendorImportViolations(mutation.source, relative);
    assert.ok(findings.length > 0, `${mutation.label} was not rejected`);
    assert.match(findings.join("\n"), mutation.expected, mutation.label);
  }
});

test("chat authority policy rejects renamed client-owned orchestration mutations", () => {
  const mutations = [
    {
      label: "client-owned model routing",
      source: "class ChatModelRouter {}",
    },
    {
      label: "client-owned prompt orchestration",
      source: "function composeSystemPrompt() { return ''; }",
    },
    {
      label: "client-owned provider retry",
      source: "const providerRetryBackoff = 250;",
    },
    {
      label: "client-owned conversation compaction",
      source: "function compactConversationHistory() { return []; }",
    },
    {
      label: "client-owned continuation budget",
      source: "const MAX_TOOL_ROUNDS = 8;",
    },
  ];

  for (const mutation of mutations) {
    const findings = chatAuthorityConceptViolations(
      mutation.source,
      "src/views/chatview/FutureChatRuntime.ts",
    );
    assert.ok(findings.length > 0, `${mutation.label} was not rejected`);
    assert.match(findings.join("\n"), new RegExp(mutation.label, "u"));
  }
});

test("managed production modules have only SystemSculpt network ownership", () => {
  const productionFilesToCheck = PRODUCTION_ROOTS.flatMap(productionFiles);
  assert.ok(productionFilesToCheck.length > 0, "production tree is empty");
  assert.deepEqual(productionFilesToCheck.flatMap(authorityViolations), []);

  const files = NETWORK_OWNERSHIP_ROOTS.flatMap(productionFiles);
  assert.ok(files.length > 0, "managed production tree is empty");
  assert.deepEqual(files.flatMap(networkViolations), []);

  const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
  const dependencies = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.optionalDependencies ?? {}),
  };
  assert.deepEqual(
    Object.keys(dependencies).filter((specifier) =>
      !THIN_CLIENT_DEPENDENCIES.has(specifier)
      && FORBIDDEN_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`)),
    ),
    [],
  );
});

test("first-party tools have no retired server or adapter tree", () => {
  for (const retiredPath of ["src/mcp", "src/mcp-tools", "src/types/mcp.ts"]) {
    const absolute = path.resolve(retiredPath);
    const hasProductionFiles = fs.existsSync(absolute)
      && (fs.statSync(absolute).isFile() || productionFiles(absolute).length > 0);
    assert.equal(hasProductionFiles, false, `${retiredPath} still contains active production code`);
  }
});

test("thin Chat has no legacy client loop or generic managed-chat authority", () => {
  for (const retiredPath of [
    "src/views/chatview/ManagedAgentController.ts",
    "src/views/chatview/turn/ManagedChatRuntimeAdapter.ts",
    "src/services/chat/AcceptedChatRequestSnapshot.ts",
    "src/services/chat/ChatRequestPreparationService.ts",
    "src/services/chat/ManagedToolResult.ts",
    "src/services/managed/ManagedChatInputLimits.ts",
    "src/services/managed/ManagedChatSessionBudget.ts",
  ]) {
    assert.equal(
      fs.existsSync(path.resolve(retiredPath)),
      false,
      `${retiredPath} restores client-owned chat authority`,
    );
  }

  const managedClient = fs.readFileSync(
    path.resolve("src/services/managed/ManagedCapabilityClient.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    managedClient,
    /^\s*(?:public\s+)?(?:async\s+)?(?:request|stream|job|acquireChatTurnLease)\s*\(/mu,
  );
  const hostedTransport = fs.readFileSync(
    path.resolve("src/services/managed/adapters/HostedTransportAdapter.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    hostedTransport,
    /^\s*(?:public\s+)?(?:async\s+)?stream\s*\(/mu,
  );
  const managedTypes = fs.readFileSync(
    path.resolve("src/services/managed/ManagedTypes.ts"),
    "utf8",
  );
  assert.doesNotMatch(managedTypes, /\bManagedChatLeaseResult\b/u);
});

test("current chat code and fixtures use only canonical first-party tool names", () => {
  const findings = sourceFiles("src/views/chatview").flatMap((file) => {
    const source = fs.readFileSync(file, "utf8");
    const match = source.match(RETIRED_CHAT_TOOL_PREFIX);
    const relative = toRepositoryPath(path.relative(process.cwd(), file));
    return match ? [`${relative}: ${match[0]}`] : [];
  });
  assert.deepEqual(findings, []);
});
