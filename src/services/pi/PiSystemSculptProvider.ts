import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type SystemSculptPlugin from "../../main";
import { resolveSystemSculptApiBaseUrl } from "../../utils/urlHelpers";
import { resolvePiPluginInstallDir } from "./PiRuntimeBootstrap";

export const SYSTEMSCULPT_PI_PROVIDER_ID = "systemsculpt";
export const SYSTEMSCULPT_PI_PROVIDER_MODEL_ID = "ai-agent";
export const SYSTEMSCULPT_PI_EXECUTION_MODEL_ID = "systemsculpt/ai-agent";
export const SYSTEMSCULPT_PI_CANONICAL_MODEL_ID = "systemsculpt@@systemsculpt/ai-agent";
export const SYSTEMSCULPT_PI_LICENSE_ENV = "SYSTEMSCULPT_PI_PROVIDER_LICENSE";

const SYSTEMSCULPT_PI_EXTENSION_FILE = "systemsculpt-pi-provider-extension.mjs";
const SYSTEMSCULPT_PI_CONTEXT_WINDOW = 256_000;
const SYSTEMSCULPT_PI_MAX_TOKENS = 32_768;

function buildExtensionSource(baseUrl: string): string {
  const normalizedBaseUrl = JSON.stringify(baseUrl);

  return [
    "export default function registerSystemSculptProvider(pi) {",
    `  pi.registerProvider(${JSON.stringify(SYSTEMSCULPT_PI_PROVIDER_ID)}, {`,
    `    baseUrl: ${normalizedBaseUrl},`,
    `    apiKey: ${JSON.stringify(SYSTEMSCULPT_PI_LICENSE_ENV)},`,
    '    api: "openai-completions",',
    "    headers: {",
    `      "x-license-key": ${JSON.stringify(SYSTEMSCULPT_PI_LICENSE_ENV)},`,
    "    },",
    "    models: [",
    "      {",
    `        id: ${JSON.stringify(SYSTEMSCULPT_PI_PROVIDER_MODEL_ID)},`,
    '        name: "SystemSculpt",',
    "        reasoning: true,",
    '        input: ["text", "image"],',
    "        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },",
    `        contextWindow: ${SYSTEMSCULPT_PI_CONTEXT_WINDOW},`,
    `        maxTokens: ${SYSTEMSCULPT_PI_MAX_TOKENS},`,
    "        compat: {",
    "          supportsReasoningEffort: true,",
    '          maxTokensField: "max_completion_tokens",',
    "        },",
    "      },",
    "    ],",
    "  });",
    "}",
    "",
  ].join("\n");
}

function buildExtensionPath(plugin: SystemSculptPlugin): string {
  const pluginInstallDir = resolvePiPluginInstallDir({ plugin });
  return join(pluginInstallDir, SYSTEMSCULPT_PI_EXTENSION_FILE);
}

export function isSystemSculptPiExecutionModel(modelId: string): boolean {
  return String(modelId || "").trim().toLowerCase() === SYSTEMSCULPT_PI_EXECUTION_MODEL_ID;
}

export function isSystemSculptPiProviderModel(providerId: string, modelId: string): boolean {
  return (
    String(providerId || "").trim().toLowerCase() === SYSTEMSCULPT_PI_PROVIDER_ID &&
    String(modelId || "").trim().toLowerCase() === SYSTEMSCULPT_PI_PROVIDER_MODEL_ID
  );
}

export async function ensureSystemSculptPiProviderExtension(
  plugin: SystemSculptPlugin
): Promise<string> {
  const extensionPath = buildExtensionPath(plugin);
  const source = buildExtensionSource(resolveSystemSculptApiBaseUrl(plugin.settings.serverUrl));

  await mkdir(resolvePiPluginInstallDir({ plugin }), { recursive: true });

  try {
    const current = await readFile(extensionPath, "utf8");
    if (current === source) {
      return extensionPath;
    }
  } catch {
    // Write the extension file below when it does not exist or cannot be read.
  }

  await writeFile(extensionPath, source, "utf8");
  return extensionPath;
}

export function buildSystemSculptPiProviderEnv(
  plugin: SystemSculptPlugin
): Record<string, string | undefined> {
  const licenseKey = String(plugin.settings.licenseKey || "").trim();
  return {
    [SYSTEMSCULPT_PI_LICENSE_ENV]: licenseKey || undefined,
  };
}
