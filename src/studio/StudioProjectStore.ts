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
  type StudioSupportGenerationFile,
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

type StudioPersistenceFailure = {
  status: string;
  message?: string;
};

function studioPersistenceError(
  action: "open" | "create" | "rename" | "save",
  failure: StudioPersistenceFailure
): Error {
  console.warn("[SystemSculpt Studio] Project persistence operation failed", {
    action,
    status: failure.status,
    detail: failure.message,
  });
  if (failure.status === "future_unsupported") {
    return new Error("This Studio project needs a newer version of SystemSculpt.");
  }
  if (failure.status === "storage_unavailable") {
    return new Error("Studio couldn't access this project right now. The project file was not changed.");
  }
  if (failure.status === "invalid_candidate") {
    const rawDetail = String(failure.message || "");
    const safeValidationPrefix = /^The Studio project file is invalid:\s*/i;
    if (safeValidationPrefix.test(rawDetail)) {
      const detail = rawDetail.replace(safeValidationPrefix, "").trim();
      return new Error(`Studio couldn't read this project file: ${detail}`);
    }
    return new Error("Studio couldn't read this project file. The file was not changed.");
  }
  if (action === "save") {
    return new Error("This project file changed before Studio could save. Studio left the file untouched.");
  }
  if (action === "create") {
    return new Error("Studio couldn't create this project. No project file was changed.");
  }
  if (action === "rename") {
    return new Error("Studio couldn't rename this project. The existing project file was not changed.");
  }
  return new Error("Studio couldn't safely open this project. The project file was left untouched.");
}

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

  private async openSelected(projectPath: string, options?: { forceReload?: boolean }): Promise<{ token: ExpectedGeneration; generation: SelectedGeneration }> {
    const path = normalizeStudioProjectPath(projectPath);
    const cached = this.selectedByPath.get(path);
    if (cached && options?.forceReload !== true) return cached;
    if (options?.forceReload === true) this.selectedByPath.delete(path);
    if (cached) {
      const opened = await this.generations.open(cached.generation.metadata.projectId, { vaultRelativeProjectPath: path });
      if (opened.status !== "ready") throw studioPersistenceError("open", opened);
      this.remember(path, opened.expectedGeneration, opened.generation);
      return { token: opened.expectedGeneration, generation: opened.generation };
    }
    const adopted = await this.generations.discoverAndAdopt({ vaultRelativeProjectPath: path });
    if (adopted.status !== "committed") throw studioPersistenceError("open", adopted);
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
    if (result.status !== "committed") throw studioPersistenceError("create", result);
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
    if (result.status !== "committed") throw studioPersistenceError("rename", result);
    this.selectedByPath.delete(oldPath); this.remember(newPath, result.expectedGeneration, result.generation);
    return { oldPath, newPath, project: parseStudioProject(decoder.decode(result.generation.files.get("project.systemsculpt")!)) };
  }

  async adoptVisibleProjectRename(options: {
    oldPath: string;
    newPath: string;
    movedRawText: string;
    project: StudioProjectV1;
  }): Promise<{ oldPath: string; newPath: string; project: StudioProjectV1 }> {
    const oldPath = normalizeStudioProjectPath(options.oldPath);
    const newPath = normalizeStudioProjectPath(options.newPath);
    const selected = await this.openSelected(oldPath);
    const movedProject = parseStudioProject(options.movedRawText);
    if (movedProject.projectId !== selected.generation.metadata.projectId) {
      throw new Error("The renamed Studio file does not match the open project.");
    }
    const project = cloneStudioProjectSnapshot(options.project);
    if (project.projectId !== selected.generation.metadata.projectId) {
      throw new Error("The open Studio canvas does not match the renamed project.");
    }
    const result = await this.generations.commitWholeGeneration({
      kind: "logical_rename",
      projectId: project.projectId,
      locator: { vaultRelativeProjectPath: newPath },
      destinationProjectDocumentBeforeRename: encoder.encode(options.movedRawText),
      projectDocument: encoder.encode(serializeStudioProject({ ...project, updatedAt: nowIso() })),
      projectManifest: encoder.encode(`${JSON.stringify({
        schema: "studio.manifest.v1",
        projectId: project.projectId,
        projectPath: newPath,
        assetsDir: deriveStudioAssetsDir(newPath),
        createdAt: nowIso(),
      }, null, 2)}\n`),
    }, selected.token);
    if (result.status !== "committed") throw studioPersistenceError("rename", result);
    const renamedProject = parseStudioProject(
      decoder.decode(result.generation.files.get("project.systemsculpt")!)
    );
    this.selectedByPath.delete(oldPath);
    this.remember(newPath, result.expectedGeneration, result.generation);
    return { oldPath, newPath, project: renamedProject };
  }

  async readVisibleProjectRawText(projectPath: string): Promise<string> {
    return await this.app.vault.adapter.read(normalizeStudioProjectPath(projectPath));
  }

  async readProjectRawText(projectPath: string): Promise<string | null> {
    try { const selected = await this.openSelected(projectPath); return decoder.decode(selected.generation.files.get("project.systemsculpt")!); }
    catch { return null; }
  }

  async loadProject(projectPath: string, options?: { forceReload?: boolean }): Promise<StudioProjectV1> {
    const selected = await this.openSelected(projectPath, options);
    const document = selected.generation.files.get("project.systemsculpt");
    if (!document) throw new Error(`Studio project not found: ${normalizeStudioProjectPath(projectPath)}`);
    return parseStudioProject(decoder.decode(document));
  }

  async saveProject(
    projectPath: string,
    project: StudioProjectV1,
    options?: { onBeforeProjectWrite?: (rawText: string) => void }
  ): Promise<void> {
    const path = normalizeStudioProjectPath(projectPath);
    const projectDocument = serializeStudioProject({ ...project, updatedAt: nowIso() });
    options?.onBeforeProjectWrite?.(projectDocument);
    await this.commitCommand(path, {
      kind: "replace_project",
      projectId: project.projectId,
      reason: "discrete_save",
      projectDocument: encoder.encode(projectDocument),
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

  async putSupportFile(projectPath: string, projectId: string, file: StudioSupportGenerationFile): Promise<void> {
    await this.commitCommand(projectPath, { kind: "put_support_file", projectId, file }, { refresh: true });
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
      if (opened.status !== "ready") throw studioPersistenceError("save", opened);
      selected = { token: opened.expectedGeneration, generation: opened.generation };
      this.remember(path, selected.token, selected.generation);
    }
    let result = await this.generations.commitWholeGeneration(command, selected.token);
    for (let attempt = 0; result.status === "stale_revision" && options?.refresh && attempt < 8; attempt += 1) {
      // Commutative runtime/support publications reload the serialized token;
      // project-document saves intentionally do not enter this retry path.

      const reopened = await this.generations.open(command.projectId, { vaultRelativeProjectPath: path });
      if (reopened.status !== "ready") throw studioPersistenceError("save", reopened);

      result = await this.generations.commitWholeGeneration(command, reopened.expectedGeneration);
    }
    if (result.status !== "committed") throw studioPersistenceError("save", result);
    this.remember(path, result.expectedGeneration, result.generation);
  }

  supportRelativePath(projectPath: string, absolutePath: string): string { return this.relativeSupportPath(projectPath, absolutePath); }
}
