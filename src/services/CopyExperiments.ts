import { requireApiVersion, type App } from "obsidian";

/**
 * In-app copy A/B tests (T-5852). Each vault gets a sticky arm from a random,
 * device-local unit that never leaves the device. Obsidian bans client-side
 * telemetry, so the plugin reports nothing when an arm is shown: the arm rides
 * only on the systemsculpt.com links the person opens from that copy, as UTM
 * tags (utm_campaign = experiment key, utm_content = arm), and the website's
 * own analytics records the visit. Trellis registers and scores each test in
 * company/experiments.json (kind link_split).
 */
export type CopyExperimentArm = Readonly<{ experiment: string; variant: string }>;

type Variant = Readonly<{ key: string; weight?: number }>;

const UNIT_KEY = "systemsculpt-experiment-unit";
const units = new WeakMap<object, string | null>();

/** FNV-1a 32-bit over UTF-8; the same hash as @trellisbyte/analytics/experiment 0.5.0.
 * @internal Unit-tested directly. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Same key and unit always give the same arm; equal weights by default.
 * @internal Unit-tested directly. */
export function variantFor(key: string, unit: string, variants: readonly Variant[]): string {
  const total = variants.reduce((sum, variant) => sum + (variant.weight ?? 1), 0);
  let point = (fnv1a(`${key}:${unit}`) / 2 ** 32) * total;
  for (const variant of variants) {
    point -= variant.weight ?? 1;
    if (point < 0) return variant.key;
  }
  return variants[variants.length - 1].key;
}

/**
 * The vault's experiment unit, kept in vault-scoped local storage (Obsidian
 * 1.8.7+, not synchronized). Null where that storage is missing: such hosts
 * stay on the control copy and outside every test, so no arm is ever unstable.
 */
function experimentUnit(app: App): string | null {
  if (units.has(app)) return units.get(app) ?? null;
  let unit: string | null = null;
  try {
    if (requireApiVersion("1.8.7") && typeof app.loadLocalStorage === "function") {
      const stored: unknown = app.loadLocalStorage(UNIT_KEY);
      if (typeof stored === "string" && /^[0-9a-f]{16}$/.test(stored)) {
        unit = stored;
      } else {
        const fresh = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
        app.saveLocalStorage(UNIT_KEY, fresh);
        if (app.loadLocalStorage(UNIT_KEY) === fresh) unit = fresh;
      }
    }
  } catch {
    unit = null;
  }
  units.set(app, unit);
  return unit;
}

/** The upgrade prompt's title and subtitle (UpgradePlanModal), control first; copy picked by CMO T-5831.
 * A no-break space keeps "SystemSculpt Pro" on one line.
 * @internal Tests assert against this value. */
export const UPGRADE_PROMPT_EXPERIMENT = {
  key: "ss-plugin-upgrade-pro-2026-11",
  variants: [
    { key: "a", title: "SystemSculpt\u00a0Pro: AI images and video in your vault", subtitle: "Plus smart search and Studio. $9 a month." },
    { key: "b", title: "Get SystemSculpt\u00a0Pro, AI for your vault", subtitle: "Image and video generation, smart search and Studio for $9 a month." },
  ],
} as const;

export type UpgradePromptCopy = Readonly<{ title: string; subtitle: string; arm: CopyExperimentArm | null }>;

/** This vault's upgrade-prompt copy; the control without an arm where no stable unit exists. */
export function upgradePromptCopy(app: App): UpgradePromptCopy {
  const { key, variants } = UPGRADE_PROMPT_EXPERIMENT;
  const unit = experimentUnit(app);
  const chosen = unit ? variantFor(key, unit, variants) : null;
  const variant = variants.find((candidate) => candidate.key === chosen) ?? variants[0];
  return {
    title: variant.title,
    subtitle: variant.subtitle,
    arm: chosen ? { experiment: key, variant: variant.key } : null,
  };
}

/** Tags a systemsculpt.com link with the arm whose copy led to it; other hosts pass through. */
export function withExperimentArm(href: string, arm: CopyExperimentArm | null): string {
  if (!arm) return href;
  try {
    const url = new URL(href);
    if (!/^(www\.)?systemsculpt\.com$/.test(url.hostname)) return href;
    url.searchParams.set("utm_campaign", arm.experiment);
    url.searchParams.set("utm_content", arm.variant);
    return url.toString();
  } catch {
    return href;
  }
}
