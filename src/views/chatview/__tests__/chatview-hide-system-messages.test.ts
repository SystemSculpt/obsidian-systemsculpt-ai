/**
 * @jest-environment jsdom
 */

import { ChatView } from "../ChatView";

jest.mock("../../../core/ui/", () => ({ showPopup: jest.fn() }));
jest.mock("../../../utils/externalUrl", () => ({ openExternalUrl: jest.fn() }));
jest.mock("../uiSetup", () => ({
  uiSetup: {
    showLicenseBanner: jest.fn(),
    hideLicenseBanner: jest.fn(),
  },
}));

// Per-chat visibility of SystemSculpt system + tool messages (#213 → #174/#167).
// shouldRenderMessageRole is the single role filter the render loop consults, so
// its logic is the behavioral contract for the hide toggle.
const makeView = (opts: { perChat?: boolean; global?: boolean }): any =>
  Object.assign(Object.create(ChatView.prototype), {
    hideSystemMessages: opts.perChat,
    plugin: { settings: { hideSystemMessagesInChat: opts.global ?? false } },
  });

const shouldRender = (view: any, role: string): boolean =>
  view.shouldRenderMessageRole(role as any);

const isHidden = (view: any): boolean => view.isSystemNoiseHidden();

describe("ChatView system/tool message visibility (#213, #174, #167)", () => {
  it("renders every role when nothing is hidden", () => {
    const view = makeView({ perChat: undefined, global: false });
    for (const role of ["user", "assistant", "system", "tool"]) {
      expect(shouldRender(view, role)).toBe(true);
    }
    expect(isHidden(view)).toBe(false);
  });

  it("hides both system and tool messages (not just system) when hidden per-chat", () => {
    const view = makeView({ perChat: true, global: false });
    expect(shouldRender(view, "system")).toBe(false);
    expect(shouldRender(view, "tool")).toBe(false);
    expect(shouldRender(view, "user")).toBe(true);
    expect(shouldRender(view, "assistant")).toBe(true);
    expect(isHidden(view)).toBe(true);
  });

  it("falls back to the global setting when no per-chat preference is set", () => {
    const view = makeView({ perChat: undefined, global: true });
    expect(shouldRender(view, "system")).toBe(false);
    expect(shouldRender(view, "tool")).toBe(false);
    expect(isHidden(view)).toBe(true);
  });

  it("lets a per-chat preference override the global default", () => {
    const shown = makeView({ perChat: false, global: true });
    expect(shouldRender(shown, "system")).toBe(true);
    expect(shouldRender(shown, "tool")).toBe(true);
    expect(isHidden(shown)).toBe(false);

    const hidden = makeView({ perChat: true, global: false });
    expect(shouldRender(hidden, "system")).toBe(false);
    expect(isHidden(hidden)).toBe(true);
  });
});
