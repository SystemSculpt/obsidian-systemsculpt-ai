import type { ListItem } from "../../core/ui/modals/standard";
import type { SearchableField } from "../../services/SearchService";
import type { SystemSculptModel } from "../../types/llm";
import { ensureCanonicalId, getCanonicalId } from "../../utils/modelUtils";
import type { ModelSelectionProviderAccessState } from "./ModelSelectionProviderAuth";

export type ModelSelectionItemBuilderOptions = {
  selectedModelId: string;
  resolveProviderLabel: (providerName: string) => string;
  resolveModelAccessState: (model: SystemSculptModel) => ModelSelectionProviderAccessState;
};

function isModelSelected(modelId: string, selectedModelId: string): boolean {
  if (selectedModelId === modelId) {
    return true;
  }

  const normalizedSelected = ensureCanonicalId(selectedModelId);
  const normalizedCandidate = ensureCanonicalId(modelId);
  return normalizedSelected === normalizedCandidate;
}

function getProviderAccessRank(state: ModelSelectionProviderAccessState): number {
  if (state === "pi-auth") {
    return 0;
  }
  if (state === "local") {
    return 1;
  }
  return 2;
}

function getModelCapabilities(model: SystemSculptModel): string[] {
  const capabilities: string[] = [];

  if ((model as any).supports_vision) capabilities.push("Vision");
  if ((model as any).supports_functions) capabilities.push("Functions");
  if ((model as any).supports_streaming !== false) capabilities.push("Streaming");
  if (model.context_length && model.context_length >= 100000) capabilities.push("Long Context");

  return capabilities;
}

function formatContextLength(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M tokens`;
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(0)}K tokens`;
  }
  return `${tokens} tokens`;
}

function getProviderAccessLabel(
  accessState: ModelSelectionProviderAccessState,
  providerLabel: string
): string {
  if (accessState === "pi-auth") {
    return `Pi connected via ${providerLabel}`;
  }
  if (accessState === "local") {
    return "Local Pi runtime";
  }
  return "Connect in Pi";
}

function getModelDescription(
  model: SystemSculptModel,
  accessState: ModelSelectionProviderAccessState,
  providerLabel: string
): string {
  const parts: string[] = [getProviderAccessLabel(accessState, providerLabel)];

  if (model.context_length) {
    parts.push(formatContextLength(model.context_length));
  }

  const pricing = (model as any).pricing;
  if (pricing?.input && pricing?.output) {
    parts.push(`$${pricing.input}/$${pricing.output} per 1K`);
  }

  const capabilityParts: string[] = [];
  if ((model as any).supports_vision) capabilityParts.push("Vision");
  if ((model as any).supports_functions) capabilityParts.push("Functions");
  if ((model as any).supports_streaming) capabilityParts.push("Streaming");
  if (capabilityParts.length > 0) {
    parts.push(capabilityParts.join(" · "));
  }

  if (model.description && model.description.length > 0 && model.description.length < 100) {
    parts.push(model.description);
  }

  return parts.join(" • ");
}

function getModelIcon(
  model: SystemSculptModel,
  accessState: ModelSelectionProviderAccessState
): string {
  if (getCanonicalId(model) === "systemsculpt@@vault-agent") {
    return "folder-open";
  }
  if (accessState === "pi-auth") {
    return "shield-check";
  }
  if (accessState === "local") {
    return "cpu";
  }
  return "shield-alert";
}

function getModelBadge(
  model: SystemSculptModel,
  accessState: ModelSelectionProviderAccessState,
  providerLabel: string
): string {
  if (getCanonicalId(model) === "systemsculpt@@vault-agent") {
    return "Agent";
  }
  if ((model as any).is_new) {
    return "New";
  }
  if ((model as any).is_beta) {
    return "Beta";
  }
  if ((model as any).is_deprecated) {
    return "Legacy";
  }
  if (accessState === "pi-auth") {
    return `${providerLabel} ✓`;
  }
  if (accessState === "local") {
    return "Local Pi";
  }
  return providerLabel;
}

function buildAdditionalClasses(
  accessState: ModelSelectionProviderAccessState,
  isCurrentModel: boolean
): string {
  const classes = [`ss-provider-access-${accessState}`];
  if (isCurrentModel) {
    classes.push("ss-current-model");
  }
  return classes.join(" ");
}

export function getModelSelectionSearchableFields(
  model: SystemSculptModel,
  resolveProviderLabel: (providerName: string) => string
): SearchableField[] {
  const providerLabel = resolveProviderLabel(model.provider || "");
  return [
    { field: "name", text: model.name || "", weight: 2.0 },
    { field: "description", text: model.description || "", weight: 0.5 },
    { field: "provider", text: model.provider || "", weight: 0.8 },
    { field: "providerLabel", text: providerLabel || "", weight: 0.9 },
    { field: "id", text: model.id || "", weight: 0.6 },
  ];
}

export function buildModelSelectionListItems(
  models: SystemSculptModel[],
  options: ModelSelectionItemBuilderOptions
): ListItem[] {
  const sortedModels = [...models].sort((left, right) => {
    const leftSelected = isModelSelected(left.id, options.selectedModelId) ? 1 : 0;
    const rightSelected = isModelSelected(right.id, options.selectedModelId) ? 1 : 0;
    if (leftSelected !== rightSelected) {
      return rightSelected - leftSelected;
    }

    const leftFavorite = left.isFavorite ? 1 : 0;
    const rightFavorite = right.isFavorite ? 1 : 0;
    if (leftFavorite !== rightFavorite) {
      return rightFavorite - leftFavorite;
    }

    const leftAccess = options.resolveModelAccessState(left);
    const rightAccess = options.resolveModelAccessState(right);
    const accessCompare = getProviderAccessRank(leftAccess) - getProviderAccessRank(rightAccess);
    if (accessCompare !== 0) {
      return accessCompare;
    }

    const providerCompare = options
      .resolveProviderLabel(left.provider || "")
      .localeCompare(options.resolveProviderLabel(right.provider || ""));
    if (providerCompare !== 0) {
      return providerCompare;
    }

    return left.name.localeCompare(right.name);
  });

  return sortedModels.map((model) => {
    const providerLabel = options.resolveProviderLabel(model.provider || "");
    const accessState = options.resolveModelAccessState(model);
    const isCurrentModel = isModelSelected(model.id, options.selectedModelId);
    const providerAuthenticated = accessState === "pi-auth" || accessState === "local";
    const disabled = accessState === "unavailable";

    const item: ListItem = {
      id: model.id,
      title: model.name,
      description: getModelDescription(model, accessState, providerLabel),
      icon: getModelIcon(model, accessState),
      selected: isCurrentModel,
      disabled,
      badge: getModelBadge(model, accessState, providerLabel),
      metadata: {
        provider: model.provider,
        providerAccessState: accessState,
        contextLength: model.context_length,
        isFavorite: model.isFavorite || false,
        isNew: (model as any).is_new || false,
        isBeta: (model as any).is_beta || false,
        isDeprecated: (model as any).is_deprecated || false,
        capabilities: getModelCapabilities(model),
        isCurrentModel,
        providerAuthenticated,
        disabled,
      },
    };

    (item as any)._ssModel = model;
    (item as any).providerClass = accessState === "local" ? "provider-local" : "provider-pi";
    (item as any).additionalClasses = buildAdditionalClasses(accessState, isCurrentModel);

    if (providerAuthenticated) {
      (item as any).providerAuthenticated = true;
    }

    return item;
  });
}
