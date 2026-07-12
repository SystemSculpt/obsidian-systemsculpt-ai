import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const MANAGED_ROOTS = [
  "src/services/managed",
  "src/services/images",
  "src/services/transcription",
  "src/services/workflow/WorkflowEngineService.ts",
  "src/services/DocumentProcessingService.ts",
  "src/services/PostProcessingService.ts",
  "src/services/TitleGenerationService.ts",
];
const FORBIDDEN_PACKAGES = ["openai", "@anthropic-ai/sdk", "@google/generative-ai"];
const CUSTOM_PROVIDER = /\bCustomProvider\b|\bcustomProviders?\b|\bcustom[_-]?provider\b|\bcustomEndpoint\b|\bcustom_endpoint\b|\bproviderOAuth\b|\bproviderAuth\b/i;

function productionFiles(entry) {
  const absolute = path.resolve(entry);
  if (!fs.existsSync(absolute)) return [];
  if (fs.statSync(absolute).isFile()) return [absolute];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((item) => {
    if (item.name === "__tests__") return [];
    return productionFiles(path.join(absolute, item.name));
  }).filter((file) => file.endsWith(".ts"));
}

function violations(file) {
  const source = fs.readFileSync(file, "utf8");
  const relative = path.relative(process.cwd(), file);
  const findings = [];
  const imports = source.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*["']([^"']+)["']/g);
  for (const [, specifier] of imports) {
    if (FORBIDDEN_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`))) {
      findings.push(`${relative}: vendor import ${specifier}`);
    }
  }
  if (CUSTOM_PROVIDER.test(source)) findings.push(`${relative}: custom-provider concept`);
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
  const files = MANAGED_ROOTS.flatMap(productionFiles);
  assert.ok(files.length > 0, "managed production tree is empty");
  assert.deepEqual(files.flatMap(violations), []);
});
