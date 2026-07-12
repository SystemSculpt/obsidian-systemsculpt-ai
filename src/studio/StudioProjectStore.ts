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
  type StudioGenerationCommandKind,
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
      projectId: project.projectId,
      commandKind: "create",
      transform: (files) => {
        files.set("project.systemsculpt", encoder.encode(serializeStudioProject(project)));
        files.set(this.relativeSupportPath(projectPath, policyPath), encoder.encode(serializeStudioPolicy(createDefaultStudioPolicy())));
        files.set("support/project.manifest.json", encoder.encode(`${JSON.stringify({ schema: "studio.manifest.v1", projectId: project.projectId, projectPath, assetsDir: deriveStudioAssetsDir(projectPath), createdAt: nowIso() }, null, 2)}\n`));
        return files;
      },
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
    const result = await this.generations.commitWholeGeneration({ projectId: project.projectId, commandKind: "logical_rename", locator: { vaultRelativeProjectPath: newPath }, transform: (files) => {
      files.set("project.systemsculpt", encoder.encode(serializeStudioProject(project)));
      files.set("support/project.manifest.json", encoder.encode(`${JSON.stringify({ schema: "studio.manifest.v1", projectId: project.projectId, projectPath: newPath, assetsDir: deriveStudioAssetsDir(newPath), createdAt: nowIso() }, null, 2)}\n`));
      return files;
    } }, selected.token);
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
    await this.commitFiles(path, project.projectId, "discrete_save", (files) => {
      files.set("project.systemsculpt", encoder.encode(serializeStudioProject({ ...project, updatedAt: nowIso() })));
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
    await this.commitFiles(projectPath, project.projectId, "policy", (files) => files.set(this.relativeSupportPath(projectPath, policyPath), encoder.encode(serializeStudioPolicy({ ...policy, updatedAt: nowIso() }))));
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

  async commitSupportFiles(projectPath: string, projectId: string, commandKind: StudioGenerationCommandKind, mutate: (files: Map<string, Uint8Array>) => void): Promise<void> {
    await this.commitFiles(projectPath, projectId, commandKind, mutate);
  }

  private async commitFiles(projectPath: string, projectId: string, commandKind: StudioGenerationCommandKind, mutate: (files: Map<string, Uint8Array>) => void): Promise<void> {
    const path = normalizeStudioProjectPath(projectPath); const selected = await this.openSelected(path);
    const result = await this.generations.commitWholeGeneration({ projectId, commandKind, transform: (files) => { mutate(files); return files; } }, selected.token);
    if (result.status !== "committed") throw new Error(`Studio generation commit failed (${result.status}).`);
    this.remember(path, result.expectedGeneration, result.generation);
  }

  supportRelativePath(projectPath: string, absolutePath: string): string { return this.relativeSupportPath(projectPath, absolutePath); }
}
