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

function getModelProviderId(model: Pick<SystemSculptModel, "provider" | "sourceProviderId">): string {
  return String(model.sourceProviderId || model.provider || "").trim();
}

function getModelProviderLabel(
  model: Pick<SystemSculptModel, "provider" | "sourceProviderId">,
  resolveProviderLabel: (providerName: string) => string
): string {
  const providerId = getModelProviderId(model);
  const resolvedLabel = String(resolveProviderLabel(providerId) || "").trim();
  const compactLabel = resolvedLabel.replace(/\s*\([^)]*\)\s*$/u, "").trim();
  return compactLabel || resolvedLabel || providerId || "Pi";
}

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
  providerLabel: string
): string {
  if (getCanonicalId(model) === "systemsculpt@@vault-agent") {
    return "Agent";
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
  const providerLabel = getModelProviderLabel(model, resolveProviderLabel);
  const providerId = getModelProviderId(model);
  return [
    { field: "name", text: model.name || "", weight: 2.0 },
    { field: "description", text: model.description || "", weight: 0.5 },
    { field: "provider", text: providerId, weight: 0.8 },
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

    const providerCompare = getModelProviderLabel(left, options.resolveProviderLabel)
      .localeCompare(getModelProviderLabel(right, options.resolveProviderLabel));
    if (providerCompare !== 0) {
      return providerCompare;
    }

    return String(left.name || "").localeCompare(String(right.name || ""));
  });

  return sortedModels.map((model) => {
    const providerLabel = getModelProviderLabel(model, options.resolveProviderLabel);
    const accessState = options.resolveModelAccessState(model);
    const isCurrentModel = isModelSelected(model.id, options.selectedModelId);
    const providerAuthenticated = accessState === "pi-auth" || accessState === "local";
    const disabled = accessState === "unavailable";
    const title =
      String(model.name || "").trim() ||
      String(model.identifier?.displayName || "").trim() ||
      String(model.identifier?.modelId || "").trim() ||
      model.id;

    const item: ListItem = {
      id: model.id,
      title,
      icon: getModelIcon(model, accessState),
      selected: isCurrentModel,
      disabled,
      badge: getModelBadge(model, providerLabel),
      metadata: {
        provider: getModelProviderId(model),
        providerLabel,
        providerAccessState: accessState,
        contextLength: model.context_length,
        isFavorite: model.isFavorite || false,
        isNew: (model as any).is_new || false,
        isBeta: (model as any).is_beta || false,
        isDeprecated: (model as any).is_deprecated || false,
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
