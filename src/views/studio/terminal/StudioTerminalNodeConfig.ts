import type { StudioTerminalSessionRequest } from "../../../studio/StudioTerminalSessionManager";
import type { StudioNodeInstance } from "../../../studio/types";
import {
  resolveStudioGraphNodeMinHeight,
  resolveStudioGraphNodeWidth,
} from "../graph-v3/StudioGraphNodeGeometry";

export function clampTerminalInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function resolveTerminalCwd(configValue: unknown): string {
  if (typeof configValue === "string") {
    return configValue.trim();
  }
  return "";
}

function resolveTerminalShellProfile(value: unknown): StudioTerminalSessionRequest["shellProfile"] {
  const normalized = String(value || "").trim().toLowerCase();
  if (
    normalized === "auto" ||
    normalized === "pwsh" ||
    normalized === "powershell" ||
    normalized === "cmd" ||
    normalized === "bash" ||
    normalized === "zsh"
  ) {
    return normalized;
  }
  return "auto";
}

export function resolveTerminalScrollback(value: unknown): number {
  return clampTerminalInt(value, 4_000, 200, 50_000);
}

export function readTerminalSessionRequest(options: {
  node: StudioNodeInstance;
  projectPath: string;
}): StudioTerminalSessionRequest {
  const { node, projectPath } = options;
  return {
    projectPath,
    nodeId: node.id,
    cwd: resolveTerminalCwd((node.config as Record<string, unknown>).cwd),
    shellProfile: resolveTerminalShellProfile((node.config as Record<string, unknown>).shellProfile),
    scrollback: resolveTerminalScrollback((node.config as Record<string, unknown>).scrollback),
  };
}

export function fallbackTerminalGridDimensions(node: StudioNodeInstance): { cols: number; rows: number } {
  const width = resolveStudioGraphNodeWidth(node);
  const height = resolveStudioGraphNodeMinHeight(node);
  return {
    cols: clampTerminalInt(Math.floor((width - 24) / 8), 120, 20, 1000),
    rows: clampTerminalInt(Math.floor((height - 88) / 18), 30, 8, 600),
  };
}

export function applyTerminalNodeSize(node: StudioNodeInstance, nodeEl: HTMLElement): void {
  nodeEl.style.width = `${resolveStudioGraphNodeWidth(node)}px`;
  nodeEl.style.height = `${resolveStudioGraphNodeMinHeight(node)}px`;
}
