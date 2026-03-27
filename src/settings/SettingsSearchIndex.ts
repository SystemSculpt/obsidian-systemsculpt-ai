export type SettingsIndexEntryKind = "setting" | "anchor";

export interface SettingsIndexEntry {
  tabId: string;
  tabLabel: string;
  title: string;
  description: string;
  element: HTMLElement;
  kind: SettingsIndexEntryKind;
}

export interface SettingsSearchMatch extends SettingsIndexEntry {
  score: number;
}

export interface SettingsSearchGroup {
  tabId: string;
  tabLabel: string;
  results: SettingsSearchMatch[];
  topScore: number;
}

export interface SettingsSearchResultSet {
  groups: SettingsSearchGroup[];
  results: SettingsSearchMatch[];
}

export interface SettingsSearchHighlightPart {
  text: string;
  matched: boolean;
}

function normalizeSearchText(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function tokenizeSearchQuery(query: string): string[] {
  return Array.from(
    new Set(normalizeSearchText(query).split(/\s+/).filter(Boolean)),
  );
}

function scoreField(
  fieldValue: string,
  normalizedQuery: string,
  tokens: string[],
): number {
  if (!fieldValue) {
    return 0;
  }

  let score = 0;

  if (normalizedQuery) {
    if (fieldValue === normalizedQuery) {
      score += 400;
    } else if (fieldValue.startsWith(normalizedQuery)) {
      score += 250;
    } else if (fieldValue.includes(normalizedQuery)) {
      score += 150;
    }
  }

  for (const token of tokens) {
    if (fieldValue === token) {
      score += 120;
    } else if (fieldValue.startsWith(token)) {
      score += 80;
    } else if (fieldValue.includes(token)) {
      score += 40;
    }
  }

  return score;
}

function scoreSearchEntry(
  entry: SettingsIndexEntry,
  normalizedQuery: string,
  tokens: string[],
): number {
  if (!tokens.length) {
    return 0;
  }

  const normalizedTitle = normalizeSearchText(entry.title);
  const normalizedDescription = normalizeSearchText(entry.description);
  const normalizedTabLabel = normalizeSearchText(entry.tabLabel);
  const combined = [normalizedTitle, normalizedDescription, normalizedTabLabel]
    .filter(Boolean)
    .join(" ");

  if (!tokens.every((token) => combined.includes(token))) {
    return 0;
  }

  let score = 0;
  score += scoreField(normalizedTitle, normalizedQuery, tokens) * 4;
  score += scoreField(normalizedDescription, normalizedQuery, tokens) * 2;
  score += scoreField(normalizedTabLabel, normalizedQuery, tokens);

  if (entry.kind === "setting") {
    score += 8;
  }

  score -= Math.min(normalizedTitle.length, 80) / 100;

  return score;
}

function compareMatches(
  a: SettingsSearchMatch,
  b: SettingsSearchMatch,
): number {
  if (b.score !== a.score) {
    return b.score - a.score;
  }
  if (a.kind !== b.kind) {
    return a.kind === "setting" ? -1 : 1;
  }
  if (a.title.length !== b.title.length) {
    return a.title.length - b.title.length;
  }
  if (a.title !== b.title) {
    return a.title.localeCompare(b.title);
  }
  return a.description.localeCompare(b.description);
}

export function buildSettingsIndexFromRoot(
  contentRootEl: HTMLElement,
  tabsDef: { id: string; label: string }[],
): SettingsIndexEntry[] {
  const all: SettingsIndexEntry[] = [];
  const sections = Array.from(
    contentRootEl.querySelectorAll<HTMLElement>(".systemsculpt-tab-content"),
  );
  sections.forEach((section) => {
    const tabId = section.dataset.tab || "";
    const tabLabel = tabsDef.find((t) => t.id === tabId)?.label || tabId;

    const settings = Array.from(
      section.querySelectorAll<HTMLElement>(".setting-item"),
    );
    for (const setting of settings) {
      const title = (
        setting.querySelector(".setting-item-name")?.textContent || ""
      ).trim();
      const description = (
        setting.querySelector(".setting-item-description")?.textContent || ""
      ).trim();
      if (!title && !description) continue;
      all.push({
        tabId,
        tabLabel,
        title,
        description,
        element: setting,
        kind: "setting",
      });
    }

    const anchors = Array.from(
      section.querySelectorAll<HTMLElement>("[data-ss-search='true']"),
    );
    for (const anchor of anchors) {
      const title = (
        anchor.getAttribute("data-ss-title") ||
        anchor.textContent ||
        ""
      ).trim();
      const description = (anchor.getAttribute("data-ss-desc") || "").trim();
      if (!title && !description) continue;
      all.push({
        tabId,
        tabLabel,
        title,
        description,
        element: anchor,
        kind: "anchor",
      });
    }
  });
  return all;
}

export function searchSettingsIndex(
  entries: SettingsIndexEntry[],
  query: string,
): SettingsSearchResultSet {
  const normalizedQuery = normalizeSearchText(query);
  const tokens = tokenizeSearchQuery(query);

  if (!normalizedQuery || !tokens.length) {
    return {
      groups: [],
      results: [],
    };
  }

  const results = entries
    .map((entry) => ({
      ...entry,
      score: scoreSearchEntry(entry, normalizedQuery, tokens),
    }))
    .filter((entry) => entry.score > 0)
    .sort(compareMatches);

  const groupsByTabId = new Map<string, SettingsSearchGroup>();
  for (const result of results) {
    const existing = groupsByTabId.get(result.tabId);
    if (existing) {
      existing.results.push(result);
      existing.topScore = Math.max(existing.topScore, result.score);
      continue;
    }

    groupsByTabId.set(result.tabId, {
      tabId: result.tabId,
      tabLabel: result.tabLabel,
      results: [result],
      topScore: result.score,
    });
  }

  const groups = Array.from(groupsByTabId.values()).sort((a, b) => {
    if (b.topScore !== a.topScore) {
      return b.topScore - a.topScore;
    }
    return a.tabLabel.localeCompare(b.tabLabel);
  });

  return {
    groups,
    results,
  };
}

export function buildSettingsSearchHighlightParts(
  text: string,
  query: string,
): SettingsSearchHighlightPart[] {
  const source = String(text || "");
  if (!source) {
    return [];
  }

  const tokens = tokenizeSearchQuery(query).sort((a, b) => b.length - a.length);
  if (!tokens.length) {
    return [{ text: source, matched: false }];
  }

  const lowerSource = source.toLowerCase();
  const ranges: Array<{ start: number; end: number }> = [];

  for (const token of tokens) {
    let searchFrom = 0;
    while (searchFrom < lowerSource.length) {
      const foundIndex = lowerSource.indexOf(token, searchFrom);
      if (foundIndex === -1) {
        break;
      }
      ranges.push({ start: foundIndex, end: foundIndex + token.length });
      searchFrom = foundIndex + token.length;
    }
  }

  if (!ranges.length) {
    return [{ text: source, matched: false }];
  }

  ranges.sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end) {
      merged.push({ ...range });
      continue;
    }
    last.end = Math.max(last.end, range.end);
  }

  const parts: SettingsSearchHighlightPart[] = [];
  let cursor = 0;
  for (const range of merged) {
    if (cursor < range.start) {
      parts.push({ text: source.slice(cursor, range.start), matched: false });
    }
    parts.push({ text: source.slice(range.start, range.end), matched: true });
    cursor = range.end;
  }
  if (cursor < source.length) {
    parts.push({ text: source.slice(cursor), matched: false });
  }

  return parts;
}
