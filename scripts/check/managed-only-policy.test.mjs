import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";

const FORBIDDEN_VENDOR_PACKAGES = [
  "openai",
  "@anthropic-ai/sdk",
  "@google/generative-ai",
];

const ALLOWED_NETWORK_HOSTNAMES = new Set([
  "systemsculpt.com",
  "api.systemsculpt.com",
]);

const forbiddenPatterns = [
  { concept: "custom providers", pattern: /\bcustomProviders\b|\bcustom_provider\b/i },
  { concept: "custom endpoint", pattern: /\bcustom_endpoint\b|\bcustomEndpoint\b/i },
  { concept: "provider authentication", pattern: /\b(providerAuth|providerOAuth|oauthToken)\b/i },
  { concept: "vendor model catalog", pattern: /\b(vendorModelCatalog|providerModelCatalog)\b/i },
  { concept: "custom transcription endpoint", pattern: /\bcustomTranscriptionEndpoint\b/i },
  { concept: "custom embedding endpoint", pattern: /\bembeddingsCustomEndpoint\b/i },
];

function isForbiddenVendorSpecifier(specifier) {
  return FORBIDDEN_VENDOR_PACKAGES.some((packageName) =>
    specifier === packageName || specifier.startsWith(`${packageName}/`));
}

function stringLiteralValue(node) {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

function findVendorImports(source) {
  const sourceFile = ts.createSourceFile(
    "managed-only-policy-input.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers = [];

  function record(node) {
    const specifier = stringLiteralValue(node);
    if (specifier !== null && isForbiddenVendorSpecifier(specifier)) specifiers.push(specifier);
  }

  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      record(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression) {
      record(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        record(node.arguments[0]);
      } else if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        record(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function rawAuthority(rawUrl) {
  return rawUrl.match(/^https?:\/\/([^/?#]*)/i)?.[1] ?? "";
}

function hasExplicitPort(rawUrl) {
  const authority = rawAuthority(rawUrl);
  const withoutUserInfo = authority.slice(authority.lastIndexOf("@") + 1);
  if (withoutUserInfo.startsWith("[")) return /\]:\d+$/.test(withoutUserInfo);
  return /:\d+$/.test(withoutUserInfo);
}

function findRejectedNetworkDestinations(source) {
  const candidates = source.match(/https?:\/\/[^\s"'`<>)}\]]+/gi) ?? [];
  return candidates.filter((candidate) => {
    try {
      const url = new URL(candidate);
      return url.protocol !== "https:"
        || url.username !== ""
        || url.password !== ""
        || rawAuthority(candidate).includes("%")
        || hasExplicitPort(candidate)
        || !ALLOWED_NETWORK_HOSTNAMES.has(url.hostname.toLowerCase());
    } catch {
      return true;
    }
  });
}

function scanTree(tree) {
  return tree.flatMap(({ path, source }) => {
    const findings = forbiddenPatterns
      .filter(({ pattern }) => pattern.test(source))
      .map(({ concept }) => ({ path, concept }));
    if (findVendorImports(source).length > 0) findings.push({ path, concept: "vendor SDK import" });
    if (findRejectedNetworkDestinations(source).length > 0) {
      findings.push({ path, concept: "direct non-SystemSculpt destination" });
    }
    return findings;
  });
}

test("accepts exact intended SystemSculpt HTTPS destinations", () => {
  assert.deepEqual(scanTree([
    { path: "src/root.ts", source: 'fetch("https://systemsculpt.com/resources")' },
    { path: "src/client.ts", source: 'fetch("https://api.systemsculpt.com/api/v1/chat/completions")' },
    { path: "src/aliases.ts", source: 'export const alias = "systemsculpt/chat";' },
  ]), []);
});

test("rejects deceptive, credentialed, encoded, insecure, port, and unapproved-subdomain URLs", () => {
  const rejectedUrls = [
    "https://systemsculpt.com.evil.example/v1",
    "https://systemsculpt.com@evil.example/v1",
    "https://user:pass@systemsculpt.com/v1",
    "https://%73ystemsculpt.com/v1",
    "https://systemsculpt.com:8443/v1",
    "http://systemsculpt.com/v1",
    "https://cdn.systemsculpt.com/v1",
    "https://legacy.invalid/v1",
  ];
  const findings = scanTree(rejectedUrls.map((url, index) => ({
    path: `src/network-${index}.ts`,
    source: `fetch("${url}")`,
  })));
  assert.equal(findings.length, rejectedUrls.length);
  assert.ok(findings.every(({ concept }) => concept === "direct non-SystemSculpt destination"));
});

test("detects syntax nodes for every forbidden vendor module-loading form and package subpath", () => {
  const sources = [
    'import "openai";',
    'import OpenAI from "openai/client";',
    'import { Anthropic } from "@anthropic-ai/sdk";',
    'import Anthropic = require("@anthropic-ai/sdk/resources/messages");',
    'const sdk = require("@anthropic-ai/sdk/resources/messages");',
    'const sdk = await import("@google/generative-ai/server");',
  ];
  const findings = scanTree(sources.map((source, index) => ({ path: `src/vendor-${index}.ts`, source })));
  assert.equal(findings.length, sources.length);
  assert.ok(findings.every(({ concept }) => concept === "vendor SDK import"));
});

test("ignores comments and multiline string/template prose containing module-looking examples", () => {
  assert.deepEqual(scanTree([
    {
      path: "src/comments.ts",
      source: '// import OpenAI from "openai";\n/*\nconst sdk = require("@anthropic-ai/sdk");\n*/',
    },
    {
      path: "src/static-import-prose.ts",
      source: 'const example = "first line\\nimport OpenAI from \\"openai\\";\\nlast line";',
    },
    {
      path: "src/require-prose.ts",
      source: 'const example = `first line\nconst sdk = require("@anthropic-ai/sdk");\nlast line`;',
    },
    {
      path: "src/dynamic-import-prose.ts",
      source: 'const example = `first line\nconst sdk = await import("@google/generative-ai");\nlast line`;',
    },
    {
      path: "src/safe.ts",
      source: 'import helper from "openai-compatible-helper"; const note = "require openai manually";',
    },
  ]), []);
});

test("rejects every forbidden production concept in a synthetic tree", () => {
  const rejected = scanTree([
    { path: "src/providers.ts", source: "const customProviders = []; const custom_endpoint = '';" },
    { path: "src/auth.ts", source: "const providerOAuth = oauthToken;" },
    { path: "src/vendor.ts", source: 'import Client from "@anthropic-ai/sdk"; const vendorModelCatalog = [];' },
    { path: "src/transcription.ts", source: "settings.customTranscriptionEndpoint" },
    { path: "src/embeddings.ts", source: "settings.embeddingsCustomEndpoint" },
    { path: "src/network.ts", source: 'fetch("https://legacy.invalid/v1")' },
  ]);
  assert.deepEqual(
    new Set(rejected.map(({ concept }) => concept)),
    new Set([...forbiddenPatterns.map(({ concept }) => concept), "vendor SDK import", "direct non-SystemSculpt destination"]),
  );
});
