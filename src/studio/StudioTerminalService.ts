import { normalizePath } from "obsidian";
import { dirname, isAbsolute, join as joinPath } from "node:path";
import type SystemSculptPlugin from "../main";
import { StudioProjectStore } from "./StudioProjectStore";
import {
  StudioTerminalSessionManager,
  type StudioTerminalSidecarStatus,
  type StudioTerminalSidecarStatusListener,
  type StudioTerminalSessionListener,
  type StudioTerminalSessionRequest,
  type StudioTerminalSessionSnapshot,
} from "./StudioTerminalSessionManager";
import { normalizeStudioProjectPath } from "./paths";
import { randomId } from "./utils";

export class StudioTerminalService {
  constructor(
    private readonly plugin: SystemSculptPlugin,
    private readonly projectStore: StudioProjectStore,
    private readonly terminalSessionManager: StudioTerminalSessionManager
  ) {}

  private resolveVaultBasePath(): string {
    const adapter = this.plugin.app.vault.adapter as {
      getBasePath?: () => string;
      getFullPath?: (relativePath: string) => string;
      basePath?: unknown;
    };
    if (typeof adapter.getBasePath === "function") {
      const candidate = String(adapter.getBasePath() || "").trim();
      if (candidate) {
        return candidate;
      }
    }
    if (typeof adapter.basePath === "string" && adapter.basePath.trim().length > 0) {
      return adapter.basePath.trim();
    }
    if (typeof adapter.getFullPath === "function") {
      const candidate = String(adapter.getFullPath("") || "").trim();
      if (candidate) {
        return candidate;
      }
    }
    return "";
  }

  private resolveAbsolutePathFromStudioInput(inputPath: string): string {
    const trimmed = String(inputPath || "").trim();
    if (!trimmed) {
      return "";
    }
    if (isAbsolute(trimmed)) {
      return trimmed;
    }
    const vaultBasePath = this.resolveVaultBasePath();
    if (!vaultBasePath) {
      return "";
    }
    return joinPath(vaultBasePath, normalizePath(trimmed));
  }

  private resolveTerminalDefaultCwd(projectPath: string): string {
    const normalizedProjectPath = normalizeStudioProjectPath(projectPath);
    const projectDir = normalizePath(dirname(normalizedProjectPath));
    if (projectDir && projectDir !== ".") {
      const absoluteProjectDir = this.resolveAbsolutePathFromStudioInput(projectDir);
      if (absoluteProjectDir) {
        return absoluteProjectDir;
      }
    }
    const vaultBasePath = this.resolveVaultBasePath();
    if (vaultBasePath) {
      return vaultBasePath;
    }
    return process.cwd();
  }

  private async ensureTerminalPolicyDefaults(projectPath: string): Promise<void> {
    const normalizedProjectPath = normalizeStudioProjectPath(projectPath);
    const project = await this.projectStore.loadProject(normalizedProjectPath);
    const policy = await this.projectStore.loadPolicy(project.permissionsRef.policyPath);
    let changed = false;

    const hasFilesystemAll = policy.grants.some((grant) => {
      if (grant.capability !== "filesystem") {
        return false;
      }
      const paths = grant.scope.allowedPaths || [];
      return paths.includes("*") || paths.includes("/");
    });
    if (!hasFilesystemAll) {
      policy.grants.push({
        id: randomId("grant"),
        capability: "filesystem",
        scope: {
          allowedPaths: ["/"],
        },
        grantedAt: new Date().toISOString(),
        grantedByUser: true,
      });
      changed = true;
    }

    const cliGrant = policy.grants.find((grant) => grant.capability === "cli");
    if (!cliGrant) {
      policy.grants.push({
        id: randomId("grant"),
        capability: "cli",
        scope: {
          allowedCommandPatterns: ["*"],
        },
        grantedAt: new Date().toISOString(),
        grantedByUser: true,
      });
      changed = true;
    } else {
      const patterns = new Set((cliGrant.scope.allowedCommandPatterns || []).map((pattern) => pattern.trim()));
      if (!patterns.has("*")) {
        patterns.add("*");
        cliGrant.scope.allowedCommandPatterns = Array.from(patterns);
        changed = true;
      }
    }

    if (changed) {
      await this.projectStore.savePolicy(project.permissionsRef.policyPath, policy);
    }
  }

  private normalizeTerminalRequest(
    request: StudioTerminalSessionRequest
  ): Required<Pick<StudioTerminalSessionRequest, "projectPath" | "nodeId" | "cwd">> &
    Omit<StudioTerminalSessionRequest, "projectPath" | "nodeId" | "cwd"> {
    const projectPath = normalizeStudioProjectPath(String(request.projectPath || "").trim());
    const nodeId = String(request.nodeId || "").trim();
    if (!projectPath || !nodeId) {
      throw new Error("Terminal session requires projectPath and nodeId.");
    }

    const requestedCwd = this.resolveAbsolutePathFromStudioInput(String(request.cwd || "").trim());
    const cwd = requestedCwd || this.resolveTerminalDefaultCwd(projectPath);
    return {
      ...request,
      projectPath,
      nodeId,
      cwd,
    };
  }

  async ensureSession(request: StudioTerminalSessionRequest): Promise<StudioTerminalSessionSnapshot> {
    const normalized = this.normalizeTerminalRequest(request);
    await this.ensureTerminalPolicyDefaults(normalized.projectPath);
    return await this.terminalSessionManager.ensureSession(normalized);
  }

  async restartSession(request: StudioTerminalSessionRequest): Promise<StudioTerminalSessionSnapshot> {
    const normalized = this.normalizeTerminalRequest(request);
    await this.ensureTerminalPolicyDefaults(normalized.projectPath);
    return await this.terminalSessionManager.restartSession(normalized);
  }

  async terminateProjectSessions(options: { projectPath: string; reason?: string }): Promise<void> {
    const projectPath = normalizeStudioProjectPath(String(options.projectPath || "").trim());
    if (!projectPath) {
      return;
    }
    await this.terminalSessionManager.terminateProjectSessions({
      projectPath,
      reason: String(options.reason || "").trim(),
    });
  }

  async stopSession(options: { projectPath: string; nodeId: string }): Promise<void> {
    const projectPath = normalizeStudioProjectPath(String(options.projectPath || "").trim());
    const nodeId = String(options.nodeId || "").trim();
    if (!projectPath || !nodeId) {
      return;
    }
    await this.terminalSessionManager.stopSession({ projectPath, nodeId });
  }

  clearHistory(options: { projectPath: string; nodeId: string }): void {
    const projectPath = normalizeStudioProjectPath(String(options.projectPath || "").trim());
    const nodeId = String(options.nodeId || "").trim();
    if (!projectPath || !nodeId) {
      return;
    }
    this.terminalSessionManager.clearHistory({ projectPath, nodeId });
  }

  writeInput(options: { projectPath: string; nodeId: string; data: string }): void {
    const projectPath = normalizeStudioProjectPath(String(options.projectPath || "").trim());
    const nodeId = String(options.nodeId || "").trim();
    if (!projectPath || !nodeId) {
      return;
    }
    this.terminalSessionManager.writeInput({
      projectPath,
      nodeId,
      data: String(options.data || ""),
    });
  }

  resizeSession(options: { projectPath: string; nodeId: string; cols: number; rows: number }): void {
    const projectPath = normalizeStudioProjectPath(String(options.projectPath || "").trim());
    const nodeId = String(options.nodeId || "").trim();
    if (!projectPath || !nodeId) {
      return;
    }
    this.terminalSessionManager.resizeSession({
      projectPath,
      nodeId,
      cols: options.cols,
      rows: options.rows,
    });
  }

  getSnapshot(options: { projectPath: string; nodeId: string }): StudioTerminalSessionSnapshot | null {
    const projectPath = normalizeStudioProjectPath(String(options.projectPath || "").trim());
    const nodeId = String(options.nodeId || "").trim();
    if (!projectPath || !nodeId) {
      return null;
    }
    return this.terminalSessionManager.getSnapshot({ projectPath, nodeId });
  }

  async peekSession(options: { projectPath: string; nodeId: string }): Promise<StudioTerminalSessionSnapshot | null> {
    const projectPath = normalizeStudioProjectPath(String(options.projectPath || "").trim());
    const nodeId = String(options.nodeId || "").trim();
    if (!projectPath || !nodeId) {
      return null;
    }
    return await this.terminalSessionManager.peekSession({ projectPath, nodeId });
  }

  subscribe(
    options: { projectPath: string; nodeId: string },
    listener: StudioTerminalSessionListener
  ): () => void {
    const projectPath = normalizeStudioProjectPath(String(options.projectPath || "").trim());
    const nodeId = String(options.nodeId || "").trim();
    if (!projectPath || !nodeId) {
      return () => {};
    }
    return this.terminalSessionManager.subscribe({ projectPath, nodeId }, listener);
  }

  getSidecarStatus(): StudioTerminalSidecarStatus | null {
    return this.terminalSessionManager.getSidecarStatus();
  }

  subscribeSidecarStatus(listener: StudioTerminalSidecarStatusListener): () => void {
    return this.terminalSessionManager.subscribeSidecarStatus(listener);
  }

  async refreshSidecarStatus(): Promise<StudioTerminalSidecarStatus | null> {
    return await this.terminalSessionManager.refreshSidecarStatus();
  }

  buildSidecarStatusReport(): string {
    const status = this.getSidecarStatus();
    if (!status) {
      return "Studio terminal sidecar status is unavailable.";
    }
    return JSON.stringify(status, null, 2);
  }

  async dispose(): Promise<void> {
    await this.terminalSessionManager.dispose();
  }
}
