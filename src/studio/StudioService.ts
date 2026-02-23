import { normalizePath } from "obsidian";
import type SystemSculptPlugin from "../main";
import { StudioAssetStore } from "./StudioAssetStore";
import { registerBuiltInStudioNodes } from "./StudioBuiltInNodes";
import { StudioGraphCompiler } from "./StudioGraphCompiler";
import { migrateStudioProjectToPathOnlyPorts } from "./StudioGraphMigrations";
import { StudioNodeRegistry } from "./StudioNodeRegistry";
import { StudioProjectStore } from "./StudioProjectStore";
import { StudioRuntime } from "./StudioRuntime";
import { StudioSystemSculptApiAdapter } from "./StudioSystemSculptApiAdapter";
import { randomId } from "./utils";
import type {
  StudioAssetRef,
  StudioCapability,
  StudioCapabilityGrant,
  StudioNodeCacheSnapshotV1,
  StudioProjectV1,
  StudioRunEventHandler,
  StudioRunSummary,
} from "./types";
import {
  DEFAULT_STUDIO_PROJECTS_DIR,
  normalizeStudioProjectPath,
  sanitizeStudioProjectName,
} from "./paths";

function starterGraph(project: StudioProjectV1): StudioProjectV1 {
  if (project.graph.nodes.length > 0) {
    return project;
  }

  const inputId = randomId("node");
  const textId = randomId("node");

  return {
    ...project,
    graph: {
      nodes: [
        {
          id: inputId,
          kind: "studio.input",
          version: "1.0.0",
          title: "Input",
          position: { x: 80, y: 120 },
          config: { value: "Describe a launch-ready plan for this project." },
          continueOnError: false,
          disabled: false,
        },
        {
          id: textId,
          kind: "studio.text_generation",
          version: "1.0.0",
          title: "Text Generation",
          position: { x: 420, y: 120 },
          config: {
            modelId: project.engine.apiMode === "systemsculpt_only" ? "openai/gpt-5-mini" : "",
          },
          continueOnError: false,
          disabled: false,
        },
      ],
      edges: [
        {
          id: randomId("edge"),
          fromNodeId: inputId,
          fromPortId: "text",
          toNodeId: textId,
          toPortId: "prompt",
        },
      ],
      entryNodeIds: [inputId],
      groups: project.graph.groups || [],
    },
  };
}

export class StudioService {
  private readonly registry = new StudioNodeRegistry();
  private readonly compiler = new StudioGraphCompiler();
  private readonly projectStore: StudioProjectStore;
  private readonly assetStore: StudioAssetStore;
  private readonly apiAdapter: StudioSystemSculptApiAdapter;
  private readonly runtime: StudioRuntime;
  private currentProjectPath: string | null = null;

  constructor(private readonly plugin: SystemSculptPlugin) {
    this.projectStore = new StudioProjectStore(plugin.app);
    this.assetStore = new StudioAssetStore(plugin.app);
    this.apiAdapter = new StudioSystemSculptApiAdapter(plugin, this.assetStore);
    this.runtime = new StudioRuntime(
      plugin.app,
      plugin,
      this.projectStore,
      this.registry,
      this.compiler,
      this.assetStore,
      this.apiAdapter
    );

    registerBuiltInStudioNodes(this.registry);
  }

  getCurrentProjectPath(): string | null {
    return this.currentProjectPath;
  }

  async listProjects(): Promise<string[]> {
    return this.projectStore.listProjects();
  }

  async getCurrentProject(): Promise<StudioProjectV1 | null> {
    if (!this.currentProjectPath) return null;
    return this.projectStore.loadProject(this.currentProjectPath);
  }

  async openProject(path: string): Promise<StudioProjectV1> {
    const normalized = normalizeStudioProjectPath(path);
    let project = await this.projectStore.loadProject(normalized);
    const migration = migrateStudioProjectToPathOnlyPorts(project);
    if (migration.changed) {
      project = migration.project;
      await this.projectStore.saveProject(normalized, project);
    }
    await this.ensureDefaultPolicy(project);
    this.currentProjectPath = normalized;
    return project;
  }

  private getProjectsFolder(): string {
    return String(this.plugin.settings.studioDefaultProjectsFolder || "").trim() || DEFAULT_STUDIO_PROJECTS_DIR;
  }

  deriveDefaultProjectPath(name: string): string {
    const safeName = sanitizeStudioProjectName(name);
    return normalizeStudioProjectPath(normalizePath(`${this.getProjectsFolder()}/${safeName}`));
  }

  private async ensureDefaultPolicy(project: StudioProjectV1): Promise<void> {
    const policy = await this.projectStore.loadPolicy(project.permissionsRef.policyPath);
    let changed = false;

    const hasFilesystemDefault = policy.grants.some(
      (grant) => grant.capability === "filesystem" && (grant.scope.allowedPaths || []).includes("/")
    );
    if (!hasFilesystemDefault) {
      policy.grants.push({
        id: randomId("grant"),
        capability: "filesystem",
        scope: { allowedPaths: ["/"] },
        grantedAt: new Date().toISOString(),
        grantedByUser: true,
      });
      changed = true;
    }

    const hasStudioNetwork = policy.grants.some(
      (grant) =>
        grant.capability === "network" &&
        (grant.scope.allowedDomains || []).some((domain) => domain === "api.systemsculpt.com")
    );
    if (!hasStudioNetwork) {
      policy.grants.push({
        id: randomId("grant"),
        capability: "network",
        scope: {
          allowedDomains: ["api.systemsculpt.com", "systemsculpt.com"],
        },
        grantedAt: new Date().toISOString(),
        grantedByUser: true,
      });
      changed = true;
    }

    const requiredCliPatterns = [
      "ffmpeg",
      "ffprobe",
      "*/ffmpeg",
      "*/ffprobe",
    ];
    const cliGrant = policy.grants.find((grant) => grant.capability === "cli");
    if (!cliGrant) {
      policy.grants.push({
        id: randomId("grant"),
        capability: "cli",
        scope: {
          allowedCommandPatterns: requiredCliPatterns,
        },
        grantedAt: new Date().toISOString(),
        grantedByUser: true,
      });
      changed = true;
    } else {
      const patterns = new Set(cliGrant.scope.allowedCommandPatterns || []);
      if (!patterns.has("*")) {
        for (const pattern of requiredCliPatterns) {
          if (!patterns.has(pattern)) {
            patterns.add(pattern);
            changed = true;
          }
        }
      }
      cliGrant.scope.allowedCommandPatterns = Array.from(patterns);
    }

    if (changed) {
      await this.projectStore.savePolicy(project.permissionsRef.policyPath, policy);
    }
  }

  async createProject(options?: { name?: string; projectPath?: string }): Promise<StudioProjectV1> {
    const name = sanitizeStudioProjectName(String(options?.name || "New Studio Project"));
    const filePath = options?.projectPath
      ? normalizeStudioProjectPath(options.projectPath)
      : this.deriveDefaultProjectPath(name);

    const created = await this.projectStore.createProject({
      name,
      projectPath: filePath,
      minPluginVersion: this.plugin.manifest.version,
      maxRuns: Math.max(1, Math.floor(this.plugin.settings.studioRunRetentionMaxRuns || 100)),
      maxArtifactsMb: Math.max(1, Math.floor(this.plugin.settings.studioRunRetentionMaxArtifactsMb || 1024)),
    });

    const seeded = starterGraph(created.project);
    await this.projectStore.saveProject(created.path, seeded);
    await this.ensureDefaultPolicy(seeded);
    this.currentProjectPath = created.path;
    return seeded;
  }

  async saveProject(projectPath: string, project: StudioProjectV1): Promise<void> {
    await this.projectStore.saveProject(projectPath, project);
  }

  async runCurrentProject(options?: { onEvent?: StudioRunEventHandler }): Promise<StudioRunSummary> {
    if (!this.currentProjectPath) {
      throw new Error("No Studio project is currently open.");
    }
    return this.runtime.runProject(this.currentProjectPath, {
      onEvent: options?.onEvent,
    });
  }

  async runCurrentProjectFromNode(
    nodeId: string,
    options?: { onEvent?: StudioRunEventHandler }
  ): Promise<StudioRunSummary> {
    if (!this.currentProjectPath) {
      throw new Error("No Studio project is currently open.");
    }

    const normalizedNodeId = String(nodeId || "").trim();
    if (!normalizedNodeId) {
      throw new Error("A valid node ID is required to run a scoped Studio execution.");
    }

    const project = await this.projectStore.loadProject(this.currentProjectPath);
    const exists = project.graph.nodes.some((node) => node.id === normalizedNodeId);
    if (!exists) {
      throw new Error(`Cannot run from node "${normalizedNodeId}" because it is not part of this project.`);
    }

    return this.runtime.runProject(this.currentProjectPath, {
      entryNodeIds: [normalizedNodeId],
      forceNodeIds: [normalizedNodeId],
      onEvent: options?.onEvent,
    });
  }

  async getRecentRuns(): Promise<StudioRunSummary[]> {
    if (!this.currentProjectPath) return [];
    return this.runtime.getRecentRuns(this.currentProjectPath);
  }

  async getProjectNodeCache(projectPath?: string): Promise<StudioNodeCacheSnapshotV1 | null> {
    const rawPath = String(projectPath || this.currentProjectPath || "").trim();
    if (!rawPath) {
      return null;
    }
    const targetPath = normalizeStudioProjectPath(rawPath);
    return this.runtime.getNodeCacheSnapshot(targetPath);
  }

  async storeAsset(projectPath: string, bytes: ArrayBuffer, mimeType: string): Promise<StudioAssetRef> {
    const targetPath = normalizeStudioProjectPath(String(projectPath || "").trim());
    return this.assetStore.storeArrayBuffer(targetPath, bytes, mimeType);
  }

  async addCapabilityGrant(grant: {
    capability: StudioCapability;
    scope: StudioCapabilityGrant["scope"];
    grantedByUser?: boolean;
  }): Promise<void> {
    if (!this.currentProjectPath) {
      throw new Error("No Studio project is currently open.");
    }
    const project = await this.projectStore.loadProject(this.currentProjectPath);
    const policy = await this.projectStore.loadPolicy(project.permissionsRef.policyPath);
    policy.grants.push({
      id: randomId("grant"),
      capability: grant.capability,
      scope: grant.scope,
      grantedAt: new Date().toISOString(),
      grantedByUser: grant.grantedByUser !== false,
    });
    await this.projectStore.savePolicy(project.permissionsRef.policyPath, policy);
  }

  listNodeDefinitions() {
    return this.registry.list();
  }
}
