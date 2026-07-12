import { App } from "obsidian";
import type { StudioPermissionPolicyV1, StudioProjectV1 } from "./types";
import {
  createDefaultStudioPolicy,
  createEmptyStudioProject,
  parseStudioPolicy,
  parseStudioProject,
  serializeStudioPolicy,
  serializeStudioProject,
} from "./schema";
import {
  DEFAULT_STUDIO_PROJECTS_DIR,
  deriveStudioAssetsDir,
  deriveStudioPolicyPath,
  normalizeStudioProjectPath,
} from "./paths";
import { STUDIO_PROJECT_EXTENSION } from "./types";
import { cloneStudioProjectSnapshot } from "./StudioProjectSnapshots";
import { nowIso } from "./utils";
import {
  StudioProjectGenerationStore,
  type ExpectedGeneration,
  type SelectedGeneration,
  type StudioProjectGenerationCommand,
  type StudioAssetGenerationFile,
} from "./persistence/StudioProjectGenerationStore";
import { ObsidianStudioGenerationAdapter } from "./persistence/ObsidianStudioGenerationAdapter";

type CreateProjectOptions = {
  name: string;
  projectPath?: string;
  minPluginVersion: string;
  maxRuns: number;
  maxArtifactsMb: number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class StudioProjectStore {
  readonly generations: StudioProjectGenerationStore;
  private readonly selectedByPath = new Map<string, { token: ExpectedGeneration; generation: SelectedGeneration }>();

  constructor(private readonly app: App) {
    this.generations = new StudioProjectGenerationStore(
      new ObsidianStudioGenerationAdapter(app.vault.adapter)
    );
  }

  private async resolveUniqueProjectPath(path: string): Promise<string> {
    const normalized = normalizeStudioProjectPath(path);
    if (await this.generations.isProjectionLocatorAvailable({ vaultRelativeProjectPath: normalized })) return normalized;
    const base = normalized.slice(0, -STUDIO_PROJECT_EXTENSION.length);
    for (let suffix = 2; suffix < 10_000; suffix += 1) {
      const candidate = `${base} (${suffix})${STUDIO_PROJECT_EXTENSION}`;
      // eslint-disable-next-line no-await-in-loop
      if (await this.generations.isProjectionLocatorAvailable({ vaultRelativeProjectPath: candidate })) return candidate;
    }
    throw new Error(`Unable to allocate unique Studio project path for "${normalized}".`);
  }

  async listProjects(): Promise<string[]> {
    return this.app.vault.getFiles().map((file) => file.path)
      .filter((path) => path.toLowerCase().endsWith(STUDIO_PROJECT_EXTENSION))
      .filter((path) => !path.startsWith(".systemsculpt/studio/projects/"))
      .sort((a, b) => a.localeCompare(b));
  }

  private remember(path: string, token: ExpectedGeneration, generation: SelectedGeneration): void {
    this.selectedByPath.set(normalizeStudioProjectPath(path), { token, generation });
  }

  private async openSelected(projectPath: string): Promise<{ token: ExpectedGeneration; generation: SelectedGeneration }> {
    const path = normalizeStudioProjectPath(projectPath);
    const cached = this.selectedByPath.get(path);
    if (cached) return cached;
    const adopted = await this.generations.discoverAndAdopt({ vaultRelativeProjectPath: path });
    if (adopted.status !== "committed") throw new Error(`Studio project is read-only (${adopted.status}): ${"message" in adopted ? adopted.message : "conflict"}`);
    this.remember(path, adopted.expectedGeneration, adopted.generation);
    return { token: adopted.expectedGeneration, generation: adopted.generation };
  }

  private relativeSupportPath(projectPath: string, absolutePath: string): string {
    const supportRoot = deriveStudioAssetsDir(projectPath);
    if (absolutePath === supportRoot || !absolutePath.startsWith(`${supportRoot}/`)) throw new Error("Path is outside the Studio project support tree.");
    return `support/${absolutePath.slice(supportRoot.length + 1)}`;
  }

  async createProject(options: CreateProjectOptions): Promise<{ path: string; project: StudioProjectV1 }> {
    const fileName = `${options.name.trim() || "Untitled"}.systemsculpt`;
    const initialPath = options.projectPath?.trim() || `${DEFAULT_STUDIO_PROJECTS_DIR}/${fileName}`;
    const projectPath = await this.resolveUniqueProjectPath(initialPath);
    const policyPath = deriveStudioPolicyPath(projectPath);
    const project = createEmptyStudioProject({ name: options.name.trim() || "Untitled Studio Project", policyPath, minPluginVersion: options.minPluginVersion, maxRuns: options.maxRuns, maxArtifactsMb: options.maxArtifactsMb });
    const result = await this.generations.create({
      kind: "create",
      projectId: project.projectId,
      projectDocument: encoder.encode(serializeStudioProject(project)),
      policyDocument: encoder.encode(serializeStudioPolicy(createDefaultStudioPolicy())),
      projectManifest: encoder.encode(`${JSON.stringify({ schema: "studio.manifest.v1", projectId: project.projectId, projectPath, assetsDir: deriveStudioAssetsDir(projectPath), createdAt: nowIso() }, null, 2)}\n`),
    }, { vaultRelativeProjectPath: projectPath });
    if (result.status !== "committed") throw new Error(`Unable to create Studio project (${result.status}).`);
    this.remember(projectPath, result.expectedGeneration, result.generation);
    return { path: projectPath, project };
  }

  async renameProject(projectPath: string, nextName: string, options?: { project?: StudioProjectV1 }): Promise<{ oldPath: string; newPath: string; project: StudioProjectV1 }> {
    const oldPath = normalizeStudioProjectPath(projectPath);
    const slash = oldPath.lastIndexOf("/");
    const folder = slash < 0 ? "" : oldPath.slice(0, slash);
    const desired = normalizeStudioProjectPath(folder ? `${folder}/${nextName}` : nextName);
    const newPath = desired === oldPath ? oldPath : await this.resolveUniqueProjectPath(desired);
    const previous = options?.project ? cloneStudioProjectSnapshot(options.project) : await this.loadProject(oldPath);
    const project = { ...cloneStudioProjectSnapshot(previous), name: nextName, permissionsRef: { ...previous.permissionsRef, policyPath: deriveStudioPolicyPath(newPath) } };
    const selected = await this.openSelected(oldPath);
    const result = await this.generations.commitWholeGeneration({
      kind: "logical_rename",
      projectId: project.projectId,
      locator: { vaultRelativeProjectPath: newPath },
      projectDocument: encoder.encode(serializeStudioProject(project)),
      projectManifest: encoder.encode(`${JSON.stringify({ schema: "studio.manifest.v1", projectId: project.projectId, projectPath: newPath, assetsDir: deriveStudioAssetsDir(newPath), createdAt: nowIso() }, null, 2)}\n`),
    }, selected.token);
    if (result.status !== "committed") throw new Error(`Unable to rename Studio project (${result.status}).`);
    this.selectedByPath.delete(oldPath); this.remember(newPath, result.expectedGeneration, result.generation);
    return { oldPath, newPath, project: parseStudioProject(decoder.decode(result.generation.files.get("project.systemsculpt")!)) };
  }

  async readProjectRawText(projectPath: string): Promise<string | null> {
    try { const selected = await this.openSelected(projectPath); return decoder.decode(selected.generation.files.get("project.systemsculpt")!); }
    catch { return null; }
  }

  async loadProject(projectPath: string): Promise<StudioProjectV1> {
    const raw = await this.readProjectRawText(projectPath);
    if (raw == null) throw new Error(`Studio project not found: ${normalizeStudioProjectPath(projectPath)}`);
    return parseStudioProject(raw);
  }

  async saveProject(projectPath: string, project: StudioProjectV1): Promise<void> {
    const path = normalizeStudioProjectPath(projectPath);
    await this.commitCommand(path, {
      kind: "replace_project",
      projectId: project.projectId,
      reason: "discrete_save",
      projectDocument: encoder.encode(serializeStudioProject({ ...project, updatedAt: nowIso() })),
    });
  }

  async loadPolicy(policyPath: string): Promise<StudioPermissionPolicyV1> {
    const projects = [...this.selectedByPath.keys()];
    let projectPath = projects.find((path) => policyPath.startsWith(`${deriveStudioAssetsDir(path)}/`));
    if (!projectPath) {
      projectPath = (await this.listProjects()).find((path) => policyPath.startsWith(`${deriveStudioAssetsDir(path)}/`));
    }
    if (!projectPath) throw new Error("Policy path does not belong to an adopted Studio project.");
    const selected = await this.openSelected(projectPath);
    const bytes = selected.generation.files.get(this.relativeSupportPath(projectPath, policyPath));
    return bytes ? parseStudioPolicy(decoder.decode(bytes)) : createDefaultStudioPolicy();
  }

  async savePolicy(policyPath: string, policy: StudioPermissionPolicyV1): Promise<void> {
    const projectPath = [...this.selectedByPath.keys()].find((path) => policyPath.startsWith(`${deriveStudioAssetsDir(path)}/`));
    if (!projectPath) throw new Error("Policy path does not belong to an open Studio project.");
    const project = await this.loadProject(projectPath);
    await this.commitCommand(projectPath, {
      kind: "replace_policy",
      projectId: project.projectId,
      policyDocument: encoder.encode(serializeStudioPolicy({ ...policy, updatedAt: nowIso() })),
    });
  }

  async readSupportFile(projectPath: string, absolutePath: string): Promise<Uint8Array | null> {
    const selected = await this.openSelected(projectPath);
    return selected.generation.files.get(this.relativeSupportPath(projectPath, absolutePath))?.slice() || null;
  }

  async readSupportFileByAbsolutePath(absolutePath: string): Promise<Uint8Array | null> {
    const candidates = new Set([...this.selectedByPath.keys(), ...(await this.listProjects())]);
    for (const projectPath of candidates) {
      if (!absolutePath.startsWith(`${deriveStudioAssetsDir(projectPath)}/`)) continue;
      return this.readSupportFile(projectPath, absolutePath);
    }
    return null;
  }

  async putAsset(projectPath: string, projectId: string, asset: StudioAssetGenerationFile): Promise<void> {
    await this.commitCommand(projectPath, { kind: "put_asset", projectId, asset }, { refresh: true });
  }

  async replaceCache(projectPath: string, projectId: string, cacheDocument: Uint8Array): Promise<void> {
    await this.commitCommand(projectPath, { kind: "replace_cache", projectId, cacheDocument }, { refresh: true });
  }

  async publishRun(projectPath: string, command: Omit<Extract<StudioProjectGenerationCommand, { kind: "publish_run" }>, "kind">): Promise<void> {
    await this.commitCommand(projectPath, { kind: "publish_run", ...command }, { refresh: true });
  }

  private async commitCommand(projectPath: string, command: StudioProjectGenerationCommand, options?: { refresh?: boolean }): Promise<void> {
    const path = normalizeStudioProjectPath(projectPath);
    let selected = await this.openSelected(path);
    if (options?.refresh) {
      const opened = await this.generations.open(command.projectId, { vaultRelativeProjectPath: path });
      if (opened.status !== "ready") throw new Error(`Studio project is read-only (${opened.status}).`);
      selected = { token: opened.expectedGeneration, generation: opened.generation };
      this.remember(path, selected.token, selected.generation);
    }
    let result = await this.generations.commitWholeGeneration(command, selected.token);
    for (let attempt = 0; result.status === "stale_revision" && options?.refresh && attempt < 8; attempt += 1) {
      // Commutative runtime/support publications reload the serialized token;
      // project-document saves intentionally do not enter this retry path.
      // eslint-disable-next-line no-await-in-loop
      const reopened = await this.generations.open(command.projectId, { vaultRelativeProjectPath: path });
      if (reopened.status !== "ready") throw new Error(`Studio project is read-only (${reopened.status}).`);
      // eslint-disable-next-line no-await-in-loop
      result = await this.generations.commitWholeGeneration(command, reopened.expectedGeneration);
    }
    if (result.status !== "committed") throw new Error(`Studio generation commit failed (${result.status}).`);
    this.remember(path, result.expectedGeneration, result.generation);
  }

  supportRelativePath(projectPath: string, absolutePath: string): string { return this.relativeSupportPath(projectPath, absolutePath); }
}
