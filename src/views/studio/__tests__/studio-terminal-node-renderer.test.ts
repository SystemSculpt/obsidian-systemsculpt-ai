import {
  STUDIO_TERMINAL_FONT_FAMILY,
  buildStudioTerminalXtermOptions,
} from "../StudioTerminalNodeRenderer";
import { resolveStudioTerminalShortcutInput } from "../terminal/StudioTerminalXterm";

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

describe("resolveStudioTerminalShortcutInput", () => {
  it("maps Cmd+Backspace on macOS to line-kill control input", () => {
    const translated = resolveStudioTerminalShortcutInput(
      {
        type: "keydown",
        key: "Backspace",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        isComposing: false,
      },
      "MacIntel"
    );
    expect(translated).toBe("\u0015");
  });

  it("maps Cmd+Delete on macOS to line-kill control input", () => {
    const translated = resolveStudioTerminalShortcutInput(
      {
        type: "keydown",
        key: "Delete",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        isComposing: false,
      },
      "MacIntel"
    );
    expect(translated).toBe("\u0015");
  });

  it("does not map non-mac platforms", () => {
    const translated = resolveStudioTerminalShortcutInput(
      {
        type: "keydown",
        key: "Backspace",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        isComposing: false,
      },
      "Linux x86_64"
    );
    expect(translated).toBeNull();
  });

  it("does not remap option delete behavior", () => {
    const translated = resolveStudioTerminalShortcutInput(
      {
        type: "keydown",
        key: "Backspace",
        metaKey: false,
        ctrlKey: false,
        altKey: true,
        isComposing: false,
      },
      "MacIntel"
    );
    expect(translated).toBeNull();
  });
});
