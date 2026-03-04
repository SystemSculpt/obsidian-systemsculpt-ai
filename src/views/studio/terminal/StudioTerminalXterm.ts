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

type StudioTerminalShortcutEvent = Pick<
  KeyboardEvent,
  "type" | "key" | "metaKey" | "ctrlKey" | "altKey" | "isComposing"
>;

function resolveNavigatorPlatform(): string {
  if (typeof navigator === "undefined") {
    return "";
  }
  const navigatorWithUserAgentData = navigator as Navigator & {
    userAgentData?: { platform?: string | null };
  };
  return String(navigatorWithUserAgentData.userAgentData?.platform || navigator.platform || "").trim();
}

function isMacPlatform(platformHint?: string): boolean {
  const normalizedPlatform = String(platformHint || resolveNavigatorPlatform()).toLowerCase();
  return (
    normalizedPlatform.includes("mac") ||
    normalizedPlatform.includes("iphone") ||
    normalizedPlatform.includes("ipad")
  );
}

export function resolveStudioTerminalShortcutInput(
  event: StudioTerminalShortcutEvent,
  platformHint?: string
): string | null {
  if (!isMacPlatform(platformHint)) {
    return null;
  }
  if (String(event.type || "").toLowerCase() !== "keydown") {
    return null;
  }
  if (!event.metaKey || event.ctrlKey || event.altKey || event.isComposing) {
    return null;
  }
  const normalizedKey = String(event.key || "").toLowerCase();
  if (normalizedKey !== "backspace" && normalizedKey !== "delete") {
    return null;
  }
  // Match macOS terminal expectations: Cmd+Delete/Cmd+Backspace clears input to line start.
  return "\u0015";
}

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
    cursorBlink: false,
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
