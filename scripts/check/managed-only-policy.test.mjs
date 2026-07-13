import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

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
  "@mariozechner/pi-ai",
  "@mariozechner/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
];
const CUSTOM_PROVIDER = /\bCustomProvider\b|\bcustomProviders?\b|\bcustom[_-]?provider\b|\bcustomEndpoint\b|\bcustom_endpoint\b|\bproviderOAuth\b|\bproviderAuth\b/i;
const RETIRED_CLIENT_SURFACE = /\bWebResearchApiService\b|\bWebResearchCorpusService\b|\/api\/plugin\/web\/(?:search|fetch)\b/i;
const RETIRED_TOOL_ARCHITECTURE = /\bMCP(?:Service|FilesystemServer|YouTubeServer|ToolInfo)\b|\b(?:Filesystem|YouTube)Adapter\b|mcp-filesystem[_:]|mcp-youtube[_:]/;
const LEGACY_ALLOWLIST = new Set([
  "src/core/settings/migrations/SettingsMigrator.ts",
]);
const TOOL_COMPATIBILITY_ALLOWLIST = new Set([
  "src/tools/toolNames.ts",
]);
const RETIRED_CHAT_TOOL_PREFIX = /\bfilesystem_[a-z0-9_]+\b|\bmcp[-_:][a-z0-9_-]+/i;

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

function authorityViolations(file) {
  const source = fs.readFileSync(file, "utf8");
  const relative = path.relative(process.cwd(), file);
  const findings = [];
  const imports = source.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*["']([^"']+)["']/g);
  for (const [, specifier] of imports) {
    if (FORBIDDEN_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`))) {
      findings.push(`${relative}: vendor import ${specifier}`);
    }
  }
  if (!LEGACY_ALLOWLIST.has(relative) && CUSTOM_PROVIDER.test(source)) {
    findings.push(`${relative}: custom-provider concept`);
  }
  if (RETIRED_CLIENT_SURFACE.test(source)) findings.push(`${relative}: retired client surface`);
  if (!TOOL_COMPATIBILITY_ALLOWLIST.has(relative) && RETIRED_TOOL_ARCHITECTURE.test(source)) {
    findings.push(`${relative}: retired tool architecture`);
  }
  return findings;
}

function networkViolations(file) {
  const source = fs.readFileSync(file, "utf8");
  const relative = path.relative(process.cwd(), file);
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
      FORBIDDEN_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`)),
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

test("current chat code and fixtures use only canonical first-party tool names", () => {
  const findings = sourceFiles("src/views/chatview").flatMap((file) => {
    const source = fs.readFileSync(file, "utf8");
    const match = source.match(RETIRED_CHAT_TOOL_PREFIX);
    return match ? [`${path.relative(process.cwd(), file)}: ${match[0]}`] : [];
  });
  assert.deepEqual(findings, []);
});
