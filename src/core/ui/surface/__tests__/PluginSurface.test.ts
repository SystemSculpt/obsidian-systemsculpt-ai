/** @jest-environment jsdom */

import { applyPluginSurface, isPluginSurface } from "../PluginSurface";

describe("PluginSurface", () => {
  it.each(["view", "modal", "transient"] as const)(
    "applies the %s host contract without replacing feature state",
    (kind) => {
      const root = document.createElement("div");
      root.className = "feature-root";
      root.style.transform = "translate(12px, 8px)";
      const child = root.appendChild(document.createElement("span"));

      applyPluginSurface(root, kind);

      expect(isPluginSurface(root, kind)).toBe(true);
      expect(root.classList.contains("feature-root")).toBe(true);
      expect(root.style.transform).toBe("translate(12px, 8px)");
      expect(root.firstElementChild).toBe(child);
    },
  );

  it("is idempotent for the same host kind", () => {
    const root = document.createElement("div");
    applyPluginSurface(root, "view");
    applyPluginSurface(root, "view");
    expect(root.className).toBe("ss-surface");
  });

  it("rejects reclassification without mutating the original contract", () => {
    const root = document.createElement("div");
    applyPluginSurface(root, "modal");

    expect(() => applyPluginSurface(root, "view")).toThrow(
      "already mounted as modal",
    );
    expect(isPluginSurface(root, "modal")).toBe(true);
  });

  it("works before a root is connected", () => {
    const root = document.createElement("div");
    expect(root.isConnected).toBe(false);
    expect(() => applyPluginSurface(root, "transient")).not.toThrow();
  });
});
