import type {
  StudioTerminalSidecarStatus,
  StudioTerminalSidecarStatusListener,
  StudioTerminalSessionListener,
  StudioTerminalSessionRequest,
  StudioTerminalSessionSnapshot,
} from "../../../studio/StudioTerminalSessionManager";
import type { StudioNodeInstance } from "../../../studio/types";

export type StudioTerminalNodeMountOptions = {
  node: StudioNodeInstance;
  nodeEl: HTMLElement;
  nodeCardEl?: HTMLElement;
  projectPath: string;
  interactionLocked: boolean;
  ensureSession: (request: StudioTerminalSessionRequest) => Promise<StudioTerminalSessionSnapshot>;
  restartSession: (request: StudioTerminalSessionRequest) => Promise<StudioTerminalSessionSnapshot>;
  stopSession: (options: { projectPath: string; nodeId: string }) => Promise<void>;
  clearSessionHistory: (options: { projectPath: string; nodeId: string }) => void;
  writeInput: (options: { projectPath: string; nodeId: string; data: string }) => void;
  resizeSession: (options: { projectPath: string; nodeId: string; cols: number; rows: number }) => void;
  peekSession: (options: { projectPath: string; nodeId: string }) => Promise<StudioTerminalSessionSnapshot | null>;
  subscribe: (
    options: { projectPath: string; nodeId: string },
    listener: StudioTerminalSessionListener
  ) => () => void;
  getSnapshot: (options: { projectPath: string; nodeId: string }) => StudioTerminalSessionSnapshot | null;
  getSidecarStatus: () => StudioTerminalSidecarStatus | null;
  subscribeSidecarStatus: (listener: StudioTerminalSidecarStatusListener) => () => void;
  refreshSidecarStatus?: () => Promise<StudioTerminalSidecarStatus | null>;
  getGraphZoom: () => number;
  subscribeToGraphZoomChanges?: (listener: () => void) => () => void;
};
