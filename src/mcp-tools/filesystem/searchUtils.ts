import { TFile } from "obsidian";
import type SystemSculptPlugin from "../../main";

const regexCache = new Map<string, RegExp | null>();
const REGEX_CACHE_LIMIT = 200;

function getCachedSafeRegex(pattern: string): RegExp | null {
  const cached = regexCache.get(pattern);
  if (cached !== undefined) return cached;

  if (regexCache.size >= REGEX_CACHE_LIMIT) {
    regexCache.clear();
  }

  if (isLikelyUnsafeRegex(pattern)) {
    regexCache.set(pattern, null);
    return null;
  }

  try {
    const regex = new RegExp(pattern);
    regexCache.set(pattern, regex);
    return regex;
  } catch {
    regexCache.set(pattern, null);
    return null;
  }
}

function isLikelyUnsafeRegex(pattern: string): boolean {
  if (pattern.length > 240) return true;
  return /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/.test(pattern);
}

/**
 * Check if a file should be excluded from search results.
 * This lives in a mobile-safe module so search surfaces do not pull Node helpers.
 */
export function shouldExcludeFromSearch(file: TFile, plugin: SystemSculptPlugin): boolean {
  const settings = plugin.settings;
  const exclusions = settings.embeddingsExclusions;

  if (exclusions?.ignoreChatHistory !== false) {
    const chatsDirectory = settings.chatsDirectory || "SystemSculpt/Chats";
    if (file.path.startsWith(chatsDirectory + "/") && file.extension === "md") {
      return true;
    }
  }

  if (exclusions?.respectObsidianExclusions !== false) {
    try {
      const userIgnoreFilters = plugin.app.vault.getConfig("userIgnoreFilters");
      if (userIgnoreFilters && Array.isArray(userIgnoreFilters)) {
        for (const pattern of userIgnoreFilters) {
          const regex = getCachedSafeRegex(String(pattern));
          if (regex?.test(file.path)) {
            return true;
          }
        }
      }
    } catch {
      // Ignore vault-config lookup failures.
    }
  }

  if (file.path.startsWith(".obsidian/") || file.path.includes("node_modules/")) {
    return true;
  }

  const systemDirs = [
    "SystemSculpt/Recordings",
    "SystemSculpt/System Prompts",
    "SystemSculpt/Attachments",
    "SystemSculpt/Extractions",
  ];

  for (const dir of systemDirs) {
    if (file.path.startsWith(dir + "/")) {
      return true;
    }
  }

  if (plugin.settings.embeddingsExclusions?.folders) {
    for (const folder of plugin.settings.embeddingsExclusions.folders) {
      if (folder && file.path.startsWith(folder + "/")) {
        return true;
      }
    }
  }

  if (plugin.settings.embeddingsExclusions?.patterns) {
    for (const pattern of plugin.settings.embeddingsExclusions.patterns) {
      const regex = getCachedSafeRegex(String(pattern));
      if (regex?.test(file.path)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Simple fuzzy match scoring function (lower score = better match).
 * Returns `null` if `needle` cannot be found in order inside `haystack`.
 */
export function fuzzyMatchScore(needle: string, haystack: string): number | null {
  const lcNeedle = needle.toLowerCase();
  const lcHaystack = haystack.toLowerCase();
  const exactIdx = lcHaystack.indexOf(lcNeedle);
  if (exactIdx !== -1) {
    return exactIdx;
  }

  let nIdx = 0;
  let score = 0;
  for (let hIdx = 0; hIdx < lcHaystack.length && nIdx < lcNeedle.length; hIdx++) {
    if (lcHaystack[hIdx] === lcNeedle[nIdx]) {
      nIdx += 1;
    } else {
      score += 1;
    }
  }

  if (nIdx !== lcNeedle.length) {
    return null;
  }

  score += lcHaystack.length - lcNeedle.length;
  return score;
}
