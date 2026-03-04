import {
  STUDIO_TERMINAL_FONT_FAMILY,
  buildStudioTerminalXtermOptions,
} from "../StudioTerminalNodeRenderer";

describe("buildStudioTerminalXtermOptions", () => {
  it("keeps first-line prompt glyphs stable across user shell themes", () => {
    const options = buildStudioTerminalXtermOptions(4_000);
    expect(options?.customGlyphs).toBe(true);
    expect(options?.rescaleOverlappingGlyphs).toBe(true);
    expect(options?.fontFamily).toBe(STUDIO_TERMINAL_FONT_FAMILY);
    expect(String(options?.fontFamily || "")).toContain("Symbols Nerd Font Mono");
    expect(String(options?.fontFamily || "")).toContain("MesloLGS NF");
  });

  it("preserves studio terminal visual defaults", () => {
    const options = buildStudioTerminalXtermOptions(1_234);
    expect(options?.scrollback).toBe(1_234);
    expect(options?.cursorBlink).toBe(true);
    expect(options?.fontSize).toBe(12);
    expect(options?.theme?.background).toBe("#06120d");
    expect(options?.theme?.foreground).toBe("#d7fce8");
  });
});
