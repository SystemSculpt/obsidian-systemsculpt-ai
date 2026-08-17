import fs from "node:fs";
import path from "node:path";

const readCss = (relativePath: string): string =>
  fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");

describe("Plan and connect modal CSS contract", () => {
  it("stacks upgrade actions full-width on the mobile sheet", () => {
    const css = readCss("src/css/modals/upgrade-plan.css");

    expect(css).toContain(".ss-mobile-layout .ss-upgrade-plan-modal .ss-modal__footer");
    expect(css).toContain("flex-direction: column");
    // The narrow-container `flex: 1 1 12rem` must be neutralized in the column
    // footer or the 12rem basis becomes button height on the mobile sheet.
    expect(css).toMatch(/\.ss-modal__footer > \.ss-button[\s\S]*?flex: 0 0 auto/);
    expect(css).toMatch(/\.ss-modal__footer > \.ss-button[\s\S]*?min-height: var\(--ss-touch-target\)/);
  });

  it("keeps the connect modal's mobile footer touch-friendly too", () => {
    const css = readCss("src/css/modals/upgrade-plan.css");

    expect(css).toContain(".ss-mobile-layout .ss-account-connect-modal .ss-modal__footer");
  });

  it("uses design tokens, not raw values, for type and radius", () => {
    for (const sheet of ["src/css/modals/upgrade-plan.css", "src/css/modals/account-connect.css"]) {
      const css = readCss(sheet);
      expect(css).not.toMatch(/font-size:\s*\d/);
      expect(css).not.toMatch(/border-radius:\s*\d/);
    }
  });

  it("is imported exactly once by the CSS entry point", () => {
    const index = readCss("src/css/index.css");
    expect(index.match(/modals\/upgrade-plan\.css/g)).toHaveLength(1);
    expect(index.match(/modals\/account-connect\.css/g)).toHaveLength(1);
  });
});
