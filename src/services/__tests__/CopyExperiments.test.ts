import { requireApiVersion } from "obsidian";
import {
  UPGRADE_PROMPT_EXPERIMENT,
  fnv1a,
  upgradePromptCopy,
  variantFor,
  withExperimentArm,
} from "../CopyExperiments";

/** A vault with Obsidian's vault-scoped local storage. */
function vaultApp(stored: Record<string, unknown> = {}) {
  const store = { ...stored };
  return {
    store,
    loadLocalStorage: jest.fn((key: string) => store[key] ?? null),
    saveLocalStorage: jest.fn((key: string, value: unknown) => { store[key] = value; }),
  } as any;
}

describe("copy experiments", () => {
  // The Obsidian mock reports 1.5.0; vault-scoped local storage needs 1.8.7.
  const hostVersionCheck = jest.mocked(requireApiVersion).getMockImplementation()!;
  beforeEach(() => jest.mocked(requireApiVersion).mockImplementation(() => true));
  afterEach(() => jest.mocked(requireApiVersion).mockImplementation(hostVersionCheck));

  it("assigns arms exactly as Trellis' scorer does (@trellisbyte/analytics/experiment 0.5.0)", () => {
    // Reference values from trellis tools/experiments.mjs variantFor and fnv1a.
    const variants = [{ key: "a" }, { key: "b" }];
    expect(fnv1a("ss-plugin-upgrade-pro-2026-11:0123456789abcdef")).toBe(3914063310);
    expect(variantFor("ss-plugin-upgrade-pro-2026-11", "0123456789abcdef", variants)).toBe("b");
    expect(variantFor("ss-plugin-upgrade-pro-2026-11", "2222222222222222", variants)).toBe("a");
    expect(variantFor("ss-plugin-upgrade-pro-2026-11", "4444444444444444", variants)).toBe("a");
    expect(variantFor("ss-plugin-upgrade-pro-2026-11", "6666666666666666", variants)).toBe("b");
  });

  it("keeps one sticky arm per vault from a device-local unit", () => {
    const app = vaultApp({ "systemsculpt-experiment-unit": "2222222222222222" });
    expect(upgradePromptCopy(app)).toEqual({
      title: "SystemSculpt Pro: images and video in your vault",
      subtitle: "Plus smart search and Studio. $9 a month.",
      arm: { experiment: "ss-plugin-upgrade-pro-2026-11", variant: "a" },
    });
    const challenger = vaultApp({ "systemsculpt-experiment-unit": "0123456789abcdef" });
    expect(upgradePromptCopy(challenger)).toMatchObject({
      title: UPGRADE_PROMPT_EXPERIMENT.variants[1].title,
      arm: { variant: "b" },
    });
    expect(challenger.saveLocalStorage).not.toHaveBeenCalled();
  });

  it("creates the unit once and reuses it", () => {
    const app = vaultApp();
    const first = upgradePromptCopy(app);
    const unit = app.store["systemsculpt-experiment-unit"];
    expect(unit).toMatch(/^[0-9a-f]{16}$/);
    expect(first.arm?.variant).toBe(variantFor(UPGRADE_PROMPT_EXPERIMENT.key, unit, UPGRADE_PROMPT_EXPERIMENT.variants));
    expect(upgradePromptCopy(app)).toEqual(first);
    expect(app.saveLocalStorage).toHaveBeenCalledTimes(1);
  });

  it("shows the control and joins no test without vault local storage", () => {
    expect(upgradePromptCopy({} as any)).toEqual({
      title: "SystemSculpt Pro: images and video in your vault",
      subtitle: "Plus smart search and Studio. $9 a month.",
      arm: null,
    });
    jest.mocked(requireApiVersion).mockReturnValueOnce(false);
    expect(upgradePromptCopy(vaultApp()).arm).toBeNull();
  });

  it("tags only systemsculpt.com links with the arm", () => {
    const arm = { experiment: "ss-plugin-upgrade-pro-2026-11", variant: "b" };
    const tagged = new URL(withExperimentArm("https://systemsculpt.com/pricing?utm_campaign=upgrade&utm_medium=modal", arm));
    expect(tagged.searchParams.get("utm_campaign")).toBe("ss-plugin-upgrade-pro-2026-11");
    expect(tagged.searchParams.get("utm_content")).toBe("b");
    expect(tagged.searchParams.get("utm_medium")).toBe("modal");
    const patreon = "https://www.patreon.com/SystemSculpt?utm_source=plugin_upgrade_modal";
    expect(withExperimentArm(patreon, arm)).toBe(patreon);
    expect(withExperimentArm("https://systemsculpt.com/pricing", null)).toBe("https://systemsculpt.com/pricing");
  });
});
