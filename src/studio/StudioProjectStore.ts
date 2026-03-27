import { App, TFile, normalizePath } from "obsidian";
import type {
  StudioPermissionPolicyV1,
  StudioProjectV1,
} from "./types";
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
  deriveStudioAssetBlobDir,
  deriveStudioAssetsDir,
  deriveStudioPolicyPath,
  deriveStudioRunsDir,
  normalizeStudioProjectPath,
} from "./paths";
import { STUDIO_PROJECT_EXTENSION } from "./types";
import { cloneStudioProjectSnapshot } from "./StudioProjectSnapshots";
import { asString, isRecord, nowIso } from "./utils";

type CreateProjectOptions = {
  name: string;
  projectPath?: string;
  minPluginVersion: string;
  maxRuns: number;
  maxArtifactsMb: number;
};

export class StudioProjectStore {
  constructor(private readonly app: App) {}

  private get adapter() {
    return this.app.vault.adapter;
  }

  private get fileManager(): { renameFile?: (file: TFile, newPath: string) => Promise<void> } | null {
    return ((this.app as unknown as { fileManager?: { renameFile?: (file: TFile, newPath: string) => Promise<void> } })
      .fileManager || null);
  }

  private async ensureDir(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const segments = normalized.split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      try {
        const exists = await this.adapter.exists(current);
        if (!exists) {
          await this.adapter.mkdir(current);
        }
      } catch {
        // Best effort because concurrent workers may already have created it.
      }
    }
  }

  private dirname(path: string): string {
    const normalized = normalizePath(path);
    const index = normalized.lastIndexOf("/");
    return index > 0 ? normalized.slice(0, index) : "";
  }

  private async resolveUniqueProjectPath(path: string): Promise<string> {
    const normalized = normalizeStudioProjectPath(path);
    const exists = await this.adapter.exists(normalized);
    const assetsDirExists = await this.adapter.exists(deriveStudioAssetsDir(normalized));
    if (!exists && !assetsDirExists) {
      return normalized;
    }

    const base = normalized.endsWith(STUDIO_PROJECT_EXTENSION)
      ? normalized.slice(0, -STUDIO_PROJECT_EXTENSION.length)
      : normalized;

    for (let suffix = 2; suffix < 10_000; suffix += 1) {
      const candidate = normalizePath(`${base} (${suffix})${STUDIO_PROJECT_EXTENSION}`);
      // eslint-disable-next-line no-await-in-loop
      const candidateExists = await this.adapter.exists(candidate);
      if (!candidateExists) {
        return candidate;
      }
    }

    throw new Error(`Unable to allocate unique Studio project path for "${normalized}".`);
  }

  private async ensureProjectSupportDirs(projectPath: string): Promise<void> {
    await this.ensureDir(this.dirname(projectPath));
    await this.ensureDir(deriveStudioAssetsDir(projectPath));
    await this.ensureDir(this.dirname(deriveStudioPolicyPath(projectPath)));
    await this.ensureDir(deriveStudioAssetBlobDir(projectPath));
    await this.ensureDir(deriveStudioRunsDir(projectPath));
  }

  private async writeProjectManifest(projectPath: string, projectId: string): Promise<void> {
    const assetsDir = deriveStudioAssetsDir(projectPath);
    await this.ensureDir(assetsDir);
    const manifestPath = normalizePath(`${assetsDir}/project.manifest.json`);
    await this.adapter.write(
      manifestPath,
      `${JSON.stringify(
        {
          schema: "studio.manifest.v1",
          projectId,
          projectPath,
          assetsDir,
          createdAt: nowIso(),
        },
        null,
        2
      )}\n`
    );
  }

  private async renameProjectFile(oldPath: string, newPath: string): Promise<void> {
    if (oldPath === newPath) {
      return;
    }

    const abstract = this.app.vault.getAbstractFileByPath?.(oldPath);
    if (abstract instanceof TFile && typeof this.fileManager?.renameFile === "function") {
      await this.fileManager.renameFile(abstract, newPath);
      return;
    }

    const adapterRename = (this.adapter as { rename?: (source: string, destination: string) => Promise<void> }).rename;
    if (typeof adapterRename === "function") {
      await adapterRename.call(this.adapter, oldPath, newPath);
      return;
    }

    throw new Error(`Unable to rename Studio project file "${oldPath}".`);
  }

  private async canRenameAdapterPath(oldPath: string, newPath: string): Promise<boolean> {
    if (!oldPath || !newPath || oldPath === newPath) {
      return false;
    }
    const adapterRename = (this.adapter as { rename?: (source: string, destination: string) => Promise<void> }).rename;
    if (typeof adapterRename !== "function") {
      return false;
    }
    const oldExists = await this.adapter.exists(oldPath);
    if (!oldExists) {
      return false;
    }
    const newExists = await this.adapter.exists(newPath);
    return !newExists;
  }

  private async renameAdapterPath(oldPath: string, newPath: string): Promise<void> {
    if (!oldPath || !newPath || oldPath === newPath) {
      return;
    }
    const adapterRename = (this.adapter as { rename?: (source: string, destination: string) => Promise<void> }).rename;
    if (typeof adapterRename !== "function") {
      return;
    }
    await this.ensureDir(this.dirname(newPath));
    await adapterRename.call(this.adapter, oldPath, newPath);
  }

  async listProjects(): Promise<string[]> {
    const files = this.app.vault.getFiles();
    const projects = files
      .map((file) => file.path)
      .filter((path) => path.toLowerCase().endsWith(".systemsculpt"))
      .sort((a, b) => a.localeCompare(b));
    return projects;
  }

  async createProject(options: CreateProjectOptions): Promise<{ path: string; project: StudioProjectV1 }> {
    const fileName = `${options.name.trim() || "Untitled"}.systemsculpt`;
    const initialPath = normalizePath(
      options.projectPath && options.projectPath.trim().length > 0
        ? options.projectPath
        : `${DEFAULT_STUDIO_PROJECTS_DIR}/${fileName}`
    );
    const projectPath = await this.resolveUniqueProjectPath(initialPath);
    const policyPath = deriveStudioPolicyPath(projectPath);

    await this.ensureProjectSupportDirs(projectPath);

    const project = createEmptyStudioProject({
      name: options.name.trim() || "Untitled Studio Project",
      policyPath,
      minPluginVersion: options.minPluginVersion,
      maxRuns: options.maxRuns,
      maxArtifactsMb: options.maxArtifactsMb,
    });

    const policy = createDefaultStudioPolicy();
    await this.adapter.write(policyPath, serializeStudioPolicy(policy));
    await this.adapter.write(projectPath, serializeStudioProject(project));
    await this.writeProjectManifest(projectPath, project.projectId);

    return { path: projectPath, project };
  }

  async renameProject(
    projectPath: string,
    nextName: string,
    options?: { project?: StudioProjectV1 }
  ): Promise<{ oldPath: string; newPath: string; project: StudioProjectV1 }> {
    const normalizedOldPath = normalizeStudioProjectPath(projectPath);
    const folderPath = this.dirname(normalizedOldPath);
    const desiredPath = normalizeStudioProjectPath(
      folderPath ? `${folderPath}/${nextName}` : nextName
    );
    const normalizedNewPath =
      desiredPath === normalizedOldPath
        ? desiredPath
        : await this.resolveUniqueProjectPath(desiredPath);

    const previousProject = options?.project
      ? cloneStudioProjectSnapshot(options.project)
      : await this.loadProject(normalizedOldPath);
    const nextPolicyPath = deriveStudioPolicyPath(normalizedNewPath);
    const nextProject: StudioProjectV1 = {
      ...cloneStudioProjectSnapshot(previousProject),
      name: nextName,
      permissionsRef: {
        ...previousProject.permissionsRef,
        policyPath: nextPolicyPath,
      },
    };

    if (normalizedNewPath === normalizedOldPath) {
      await this.ensureProjectSupportDirs(normalizedOldPath);
      await this.saveProject(normalizedOldPath, nextProject);
      await this.writeProjectManifest(normalizedOldPath, nextProject.projectId);
      return {
        oldPath: normalizedOldPath,
        newPath: normalizedOldPath,
        project: await this.loadProject(normalizedOldPath),
      };
    }

    const oldAssetsDir = deriveStudioAssetsDir(normalizedOldPath);
    const newAssetsDir = deriveStudioAssetsDir(normalizedNewPath);
    const oldAssetsExist = await this.adapter.exists(oldAssetsDir);
    if (oldAssetsExist) {
      const canRenameAssets = await this.canRenameAdapterPath(oldAssetsDir, newAssetsDir);
      if (!canRenameAssets) {
        throw new Error(`Unable to rename Studio project assets to "${newAssetsDir}".`);
      }
    }

    await this.renameProjectFile(normalizedOldPath, normalizedNewPath);
    if (oldAssetsExist) {
      await this.renameAdapterPath(oldAssetsDir, newAssetsDir);
    }
    await this.ensureProjectSupportDirs(normalizedNewPath);
    await this.saveProject(normalizedNewPath, nextProject);
    await this.writeProjectManifest(normalizedNewPath, nextProject.projectId);

    return {
      oldPath: normalizedOldPath,
      newPath: normalizedNewPath,
      project: await this.loadProject(normalizedNewPath),
    };
  }

  private async writeMigrationBackup(projectPath: string, rawText: string): Promise<void> {
    const timestamp = nowIso().replace(/[:.]/g, "-");
    const backupPath = normalizePath(`${projectPath}.bak.${timestamp}.json`);
    await this.adapter.write(backupPath, rawText);
  }

  async readProjectRawText(projectPath: string): Promise<string | null> {
    const normalizedPath = normalizeStudioProjectPath(projectPath);
    const exists = await this.adapter.exists(normalizedPath);
    if (!exists) {
      return null;
    }
    return this.adapter.read(normalizedPath);
  }

  async loadProject(projectPath: string): Promise<StudioProjectV1> {
    const normalizedPath = normalizeStudioProjectPath(projectPath);
    const rawText = await this.readProjectRawText(normalizedPath);
    if (rawText == null) {
      throw new Error(`Studio project not found: ${normalizedPath}`);
    }
    let rawSchema = "";
    try {
      const parsed: unknown = JSON.parse(rawText);
      if (isRecord(parsed)) {
        rawSchema = asString(parsed.schema).trim();
      }
    } catch {}

    const project = parseStudioProject(rawText);
    const migrated = rawSchema !== "studio.project.v1";
    if (migrated) {
      await this.writeMigrationBackup(normalizedPath, rawText);
      await this.saveProject(normalizedPath, project);
    }

    const policyExists = await this.adapter.exists(project.permissionsRef.policyPath);
    if (!policyExists) {
      const defaultPolicy = createDefaultStudioPolicy();
      await this.savePolicy(project.permissionsRef.policyPath, defaultPolicy);
    }

    return project;
  }

  async saveProject(projectPath: string, project: StudioProjectV1): Promise<void> {
    const normalizedPath = normalizeStudioProjectPath(projectPath);
    const next: StudioProjectV1 = {
      ...project,
      updatedAt: nowIso(),
    };
    await this.ensureDir(this.dirname(normalizedPath));
    await this.adapter.write(normalizedPath, serializeStudioProject(next));
  }

  async loadPolicy(policyPath: string): Promise<StudioPermissionPolicyV1> {
    const normalizedPath = normalizePath(policyPath);
    const exists = await this.adapter.exists(normalizedPath);
    if (!exists) {
      const policy = createDefaultStudioPolicy();
      await this.savePolicy(normalizedPath, policy);
      return policy;
    }

    const raw = await this.adapter.read(normalizedPath);
    return parseStudioPolicy(raw);
  }

  async savePolicy(policyPath: string, policy: StudioPermissionPolicyV1): Promise<void> {
    const normalizedPath = normalizePath(policyPath);
    await this.ensureDir(this.dirname(normalizedPath));
    await this.adapter.write(
      normalizedPath,
      serializeStudioPolicy({
        ...policy,
        updatedAt: nowIso(),
      })
    );
  }
}
