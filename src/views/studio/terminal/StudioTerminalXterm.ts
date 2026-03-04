type XtermRuntime = {
  TerminalCtor: typeof import("@xterm/xterm").Terminal;
  FitAddonCtor: typeof import("@xterm/addon-fit").FitAddon;
};

let xtermRuntimePromise: Promise<XtermRuntime> | null = null;

export const STUDIO_TERMINAL_FONT_FAMILY =
  "'MesloLGS NF', 'MesloLGM Nerd Font Mono', 'JetBrainsMono Nerd Font', 'Hack Nerd Font Mono', " +
  "'Symbols Nerd Font Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, " +
  "'Liberation Mono', 'Courier New', monospace";

type StudioXtermOptions = ConstructorParameters<typeof import("@xterm/xterm").Terminal>[0];

export async function loadXtermRuntime(): Promise<XtermRuntime> {
  if (xtermRuntimePromise) {
    return xtermRuntimePromise;
  }
  xtermRuntimePromise = (async () => {
    const [xtermModule, fitModule] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
    return {
      TerminalCtor: xtermModule.Terminal,
      FitAddonCtor: fitModule.FitAddon,
    };
  })();
  return await xtermRuntimePromise;
}

export function buildStudioTerminalXtermOptions(scrollback: number): StudioXtermOptions {
  return {
    scrollback,
    convertEol: false,
    allowProposedApi: true,
    cursorBlink: true,
    lineHeight: 1.2,
    minimumContrastRatio: 3,
    // Keep common prompt symbols stable even when users do not have a Nerd Font installed.
    customGlyphs: true,
    rescaleOverlappingGlyphs: true,
    fontFamily: STUDIO_TERMINAL_FONT_FAMILY,
    fontSize: 12,
    theme: {
      background: "#06120d",
      foreground: "#d7fce8",
      cursor: "#95e5bb",
      cursorAccent: "#06120d",
      selectionBackground: "rgba(149, 229, 187, 0.24)",
    },
  };
}
