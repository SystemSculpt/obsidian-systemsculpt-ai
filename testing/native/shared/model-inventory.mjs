function normalizeSection(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function toSectionSet(value) {
  const entries = Array.isArray(value) ? value : [value];
  const normalized = entries
    .map((entry) => normalizeSection(entry))
    .filter((entry) => entry.length > 0);
  return normalized.length > 0 ? new Set(normalized) : null;
}

function toModelSelectorList(value) {
  const entries = Array.isArray(value) ? value : [value];
  const normalized = [];
  for (const entry of entries) {
    const parts = String(entry || "")
      .split(",")
      .map((part) => normalizeText(part))
      .filter((part) => part.length > 0);
    normalized.push(...parts);
  }
  return normalized;
}

function appendNormalizedValue(target, value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return;
  }
  target.push(normalized);
}

function appendNestedModelSelectors(target, value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return;
  }
  target.push(normalized);

  const canonicalSeparatorIndex = normalized.indexOf("@@");
  const canonicalSuffix =
    canonicalSeparatorIndex >= 0 && canonicalSeparatorIndex + 2 < normalized.length
      ? normalized.slice(canonicalSeparatorIndex + 2)
      : "";
  if (canonicalSuffix) {
    target.push(canonicalSuffix);
  }

  const providerSeparatorIndex = normalized.indexOf("/");
  const providerSuffix =
    providerSeparatorIndex >= 0 && providerSeparatorIndex + 1 < normalized.length
      ? normalized.slice(providerSeparatorIndex + 1)
      : "";
  if (providerSuffix) {
    target.push(providerSuffix);
  }

  const nestedSource = canonicalSuffix || providerSuffix || normalized;
  const modelNameIndex = nestedSource.lastIndexOf("/");
  if (modelNameIndex >= 0 && modelNameIndex + 1 < nestedSource.length) {
    target.push(nestedSource.slice(modelNameIndex + 1));
  }
}

function collectOptionSelectors(option) {
  const selectors = [];
  appendNestedModelSelectors(selectors, option?.value);
  appendNestedModelSelectors(selectors, option?.modelId);
  appendNestedModelSelectors(selectors, option?.piExecutionModelId);
  appendNormalizedValue(selectors, option?.label);
  return Array.from(new Set(selectors));
}

export function normalizeProviderId(value) {
  return String(value || "").trim().toLowerCase();
}

export function findProviderModelOption(inventory, providerId, options = {}) {
  const normalizedProviderId = normalizeProviderId(providerId);
  const requiredSections = toSectionSet(options.sections ?? options.section);
  const preferredSections = toSectionSet(options.preferredSections);
  const preferredModelIds = toModelSelectorList(
    options.preferredModelIds ?? options.preferredModelId
  );
  const requiredAuthenticated =
    typeof options.authenticated === "boolean" ? options.authenticated : undefined;
  const requiredModelId = String(options.modelId || "").trim() || null;

  const models = Array.isArray(inventory?.options) ? inventory.options : [];
  const matches = models.filter((option) => {
    if (!option || normalizeProviderId(option.providerId) !== normalizedProviderId) {
      return false;
    }
    if (
      requiredAuthenticated !== undefined &&
      Boolean(option.providerAuthenticated) !== requiredAuthenticated
    ) {
      return false;
    }
    if (requiredModelId && String(option.value || "").trim() !== requiredModelId) {
      return false;
    }
    if (requiredSections && !requiredSections.has(normalizeSection(option.section))) {
      return false;
    }
    return true;
  });

  if (matches.length < 1) {
    return null;
  }
  if (preferredModelIds.length > 0) {
    for (const selector of preferredModelIds) {
      const preferredMatch = matches.find((option) =>
        collectOptionSelectors(option).includes(selector)
      );
      if (preferredMatch) {
        return preferredMatch;
      }
    }
  }
  if (preferredSections) {
    const preferredMatch = matches.find((option) =>
      preferredSections.has(normalizeSection(option?.section))
    );
    if (preferredMatch) {
      return preferredMatch;
    }
  }

  return matches[0] || null;
}

export function describeModelOptions(inventory) {
  const models = Array.isArray(inventory?.options) ? inventory.options : [];
  return models
    .map((option) => {
      const providerId = normalizeProviderId(option?.providerId);
      const label = String(option?.label || option?.value || "").trim();
      const section = String(option?.section || "").trim();
      const auth = option?.providerAuthenticated ? "ready" : "setup";
      return [providerId, section, auth, label].filter(Boolean).join("/");
    })
    .join(", ");
}
