import { Platform } from "obsidian";
import type SystemSculptPlugin from "../main";
import {
  listStudioLocalTextModelOptions,
  listStudioPiProviderAuthRecords,
} from "./StudioLocalTextModelCatalog";
import {
  decorateStudioLocalTextModelOptionsWithAuth,
  resolveStudioLocalTextModelProviderId,
} from "./StudioLocalTextModelOptionAuth";
import type {
  StudioNodeConfigDynamicOptionsSource,
  StudioNodeConfigSelectOption,
} from "./types";

function normalizeOptionText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function modelIsSystemSculpt(model: any): boolean {
  const provider = normalizeOptionText(model?.identifier?.providerId || model?.provider).toLowerCase();
  if (provider === "systemsculpt") {
    return true;
  }
  const id = normalizeOptionText(model?.id).toLowerCase();
  return id.startsWith("systemsculpt@@");
}

function modelIsTextCapable(model: any): boolean {
  const capabilities = Array.isArray(model?.capabilities)
    ? model.capabilities.map((entry: unknown) => String(entry || "").trim().toLowerCase())
    : [];
  if (capabilities.length === 0) {
    return true;
  }
  if (capabilities.includes("embeddings")) {
    return capabilities.some((capability: string) =>
      capability === "text" ||
      capability === "chat" ||
      capability === "code" ||
      capability === "tools" ||
      capability === "function_calling" ||
      capability === "vision"
    );
  }
  return true;
}

function toSystemSculptTextModelOption(model: any): StudioNodeConfigSelectOption | null {
  const value = normalizeOptionText(model?.identifier?.modelId) || normalizeOptionText(model?.id);
  if (!value) {
    return null;
  }
  const label = normalizeOptionText(model?.identifier?.displayName || model?.name || model?.identifier?.modelId || value);
  const contextLength = Number(model?.context_length);
  const descriptionParts: string[] = [];
  if (Number.isFinite(contextLength) && contextLength > 0) {
    descriptionParts.push(`context ${contextLength.toLocaleString()}`);
  }
  const description = descriptionParts.join(" • ");
  return {
    value,
    label: label || value,
    description: description || undefined,
    badge: "SystemSculpt",
    keywords: [
      normalizeOptionText(model?.name),
      normalizeOptionText(model?.id),
      normalizeOptionText(model?.identifier?.modelId),
      normalizeOptionText(model?.provider),
    ].filter((entry) => entry.length > 0),
  };
}

export async function resolveStudioDynamicSelectOptions(options: {
  plugin: SystemSculptPlugin;
  source: StudioNodeConfigDynamicOptionsSource;
}): Promise<StudioNodeConfigSelectOption[]> {
  const { plugin, source } = options;
  if (source === "studio.local_text_models") {
    const localOptions = await listStudioLocalTextModelOptions(plugin);
    const baseOptions = localOptions.map((option) => ({
      value: option.value,
      label: option.label,
      description: option.description,
      badge: option.badge,
      keywords: option.keywords,
    }));
    if (!Platform.isDesktopApp || baseOptions.length === 0) {
      return baseOptions;
    }

    const providerHints = Array.from(
      new Set(
        baseOptions
          .map((option) => resolveStudioLocalTextModelProviderId(option))
          .filter((providerId) => providerId.length > 0)
      )
    );

    if (providerHints.length === 0) {
      return baseOptions;
    }

    try {
      const records = await listStudioPiProviderAuthRecords({ providerHints });
      return decorateStudioLocalTextModelOptionsWithAuth(baseOptions, records);
    } catch {
      return baseOptions;
    }
  }

  if (source === "studio.systemsculpt_text_models") {
    const models = await plugin.modelService.getModels().catch(() => [] as any[]);
    const options = models
      .filter((model) => modelIsSystemSculpt(model) && modelIsTextCapable(model))
      .map((model) => toSystemSculptTextModelOption(model))
      .filter((option): option is StudioNodeConfigSelectOption => option !== null)
      .sort((left, right) => left.label.localeCompare(right.label));
    return options;
  }

  return [];
}
