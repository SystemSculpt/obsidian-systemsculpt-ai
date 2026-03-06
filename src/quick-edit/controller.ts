import type { TFile } from "obsidian";
import type SystemSculptPlugin from "../main";
import type { ToolCallRequest } from "../types/toolCalls";
import { TypedEventEmitter } from "../core/TypedEventEmitter";
import type { QuickEditReadinessResult } from "./capabilities";
import type { QuickEditSelection } from "./prompt-builder";

export type QuickEditState =
  | "idle"
  | "checking"
  | "streaming"
  | "awaiting-confirmation"
  | "responded"
  | "completed"
  | "failed"
  | "cancelled";

export interface QuickEditCapabilityInput {
  plugin: SystemSculptPlugin;
  file: TFile;
}

export interface QuickEditControllerDeps {
  capabilityChecker: (input: QuickEditCapabilityInput) => Promise<QuickEditReadinessResult>;
}

export interface QuickEditStartOptions {
  plugin: SystemSculptPlugin;
  file: TFile;
  prompt: string;
  selection?: QuickEditSelection;
}

export interface QuickEditMoveOperation {
  source: string;
  destination: string;
}

export type QuickEditActivity =
  | { type: "thinking" }
  | { type: "exploring"; folder?: string }
  | { type: "reading"; file?: string }
  | { type: "deciding" }
  | { type: "proposing" };

export interface QuickEditControllerEvents {
  state: { state: QuickEditState; issues?: QuickEditReadinessResult["issues"]; error?: Error };
  activity: QuickEditActivity;
  preview: { toolCalls: ToolCallRequest[]; pendingMove?: QuickEditMoveOperation };
  response: { content: string };
}

const UNAVAILABLE_MESSAGE =
  "Quick Edit is temporarily unavailable while its Pi-native replacement is being rebuilt.";

export class QuickEditController {
  public readonly events = new TypedEventEmitter<QuickEditControllerEvents>();
  public state: QuickEditState = "idle";
  public issues: QuickEditReadinessResult["issues"] = [];

  private readonly deps: QuickEditControllerDeps;
  private pendingMove: QuickEditMoveOperation | null = null;

  constructor(deps: QuickEditControllerDeps) {
    this.deps = deps;
  }

  public async start(options: QuickEditStartOptions): Promise<void> {
    void options.prompt;
    void options.selection;
    this.reset();
    this.updateState("checking");

    const capability = await this.deps.capabilityChecker({
      plugin: options.plugin,
      file: options.file,
    });

    if (!capability.ok) {
      this.issues = capability.issues;
      this.updateState("failed", { issues: capability.issues });
      return;
    }

    this.updateState("failed", { error: new Error(UNAVAILABLE_MESSAGE) });
  }

  public get currentPendingMove(): QuickEditMoveOperation | null {
    return this.pendingMove;
  }

  public complete(): void {
    if (this.state === "completed" || this.state === "failed") return;
    this.pendingMove = null;
    this.updateState("completed");
  }

  public cancel(): void {
    if (this.state === "completed" || this.state === "failed" || this.state === "cancelled") {
      return;
    }

    this.pendingMove = null;
    this.updateState("cancelled");
  }

  private reset(): void {
    this.issues = [];
    this.pendingMove = null;
  }

  private updateState(
    state: QuickEditState,
    extras: { issues?: QuickEditReadinessResult["issues"]; error?: Error } = {}
  ): void {
    this.state = state;
    this.events.emit("state", { state, ...extras });
  }
}
