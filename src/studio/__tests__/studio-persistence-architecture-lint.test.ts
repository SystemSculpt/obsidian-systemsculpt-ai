import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../..");
const SOURCE_ROOTS = [
  resolve(REPO_ROOT, "src/studio"),
  resolve(REPO_ROOT, "src/views/studio"),
];
const WRAPPER_FILES = new Set<string>([
  "src/views/studio/StudioManagedOutputNodes.ts",
  "src/views/studio/systemsculpt-studio-view/StudioRunOutputProjectors.ts",
  "src/views/studio/graph-v3/StudioGraphGroupModel.ts",
]);
const ALLOWED_LEGACY_NODE_MUTATION_FILES = [
  "src/views/studio/graph-v3/StudioGraphImageEditorModal.ts",
  "src/views/studio/graph-v3/StudioGraphInlineConfigPanel.ts",
  "src/views/studio/graph-v3/StudioGraphJsonInlineEditor.ts",
  "src/views/studio/graph-v3/StudioGraphNodeCardSections.ts",
  "src/views/studio/graph-v3/StudioGraphNodeResizeFrame.ts",
  "src/views/studio/graph-v3/StudioGraphTextInlineEditor.ts",
  "src/views/studio/graph-v3/StudioGraphTextNodeCard.ts",
];

function listSourceFiles(): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const fullPath = join(directory, entry);
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        if (entry === "__tests__") {
          continue;
        }
        visit(fullPath);
        continue;
      }
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) {
        continue;
      }
      files.push(fullPath);
    }
  };
  for (const root of SOURCE_ROOTS) {
    visit(root);
  }
  return files.sort();
}

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

function findTokenMatches(token: RegExp): string[] {
  const matches: string[] = [];
  for (const filePath of listSourceFiles()) {
    const content = readFileSync(filePath, "utf8");
    if (token.test(content)) {
      matches.push(relative(REPO_ROOT, filePath).replace(/\\/g, "/"));
    }
    token.lastIndex = 0;
  }
  return matches.sort();
}

describe("Studio persistence architecture lint", () => {
  it("removes the old scheduleProjectSave seam from production Studio source", () => {
    expect(findTokenMatches(/scheduleProjectSave\(/g)).toEqual([]);
  });

  it("keeps legacy onNodeConfigMutated call sites confined to explicit fallback adapters", () => {
    expect(findTokenMatches(/onNodeConfigMutated\(/g)).toEqual(ALLOWED_LEGACY_NODE_MUTATION_FILES);
  });

  it("prevents view-layer production code from importing graph mutation helpers from old helper paths", () => {
    const offendingFiles: string[] = [];
    const viewOnlyFiles = listSourceFiles().filter((filePath) =>
      relative(REPO_ROOT, filePath).replace(/\\/g, "/").startsWith("src/views/studio/")
    );
    const forbiddenImports = [
      'from "./StudioManagedOutputNodes"',
      'from "../StudioManagedOutputNodes"',
      'from "./systemsculpt-studio-view/StudioRunOutputProjectors"',
      'from "../systemsculpt-studio-view/StudioRunOutputProjectors"',
      'from "./graph-v3/StudioGraphGroupModel"',
      'from "../graph-v3/StudioGraphGroupModel"',
    ];
    for (const filePath of viewOnlyFiles) {
      const relativePath = relative(REPO_ROOT, filePath).replace(/\\/g, "/");
      if (WRAPPER_FILES.has(relativePath)) {
        continue;
      }
      const content = readFileSync(filePath, "utf8");
      if (forbiddenImports.some((token) => content.includes(token))) {
        offendingFiles.push(relativePath);
      }
    }
    expect(offendingFiles).toEqual([]);
  });

  it("keeps load-time project repair core-owned", () => {
    const viewSource = readRepoFile("src/views/studio/SystemSculptStudioView.ts");
    expect(viewSource).toContain("repairStudioProjectForLoad(");
    expect(viewSource).not.toContain("sanitizeGraphGroups(currentProject)");
    expect(viewSource).not.toContain("normalizeLegacyMediaNodeTitles(currentProject)");
    expect(viewSource).not.toContain("cleanupStaleManagedOutputPlaceholders(currentProject)");
    expect(viewSource).not.toContain("removeManagedTextOutputNodes({ project: currentProject })");
  });

  it("keeps session-backed runs on the runtime snapshot path", () => {
    const serviceSource = readRepoFile("src/studio/StudioService.ts");
    expect(serviceSource).toContain("const projectSnapshot = session.getProjectSnapshot();");
    expect(serviceSource).toContain("return this.runtime.runProjectSnapshot(normalized, projectSnapshot, {");
    expect(serviceSource).toContain(
      "return this.runtime.runProjectSnapshot(normalized, projectSnapshot, {\n      entryNodeIds: [normalizedNodeId],"
    );
  });

  it("keeps StudioService free of global current-project session state", () => {
    const serviceSource = readRepoFile("src/studio/StudioService.ts");
    // Sessions are owned per-view through retain/release refcounting; a
    // service-level "current" pointer is the root cause of cross-tab
    // corruption (#286) and must not come back.
    expect(serviceSource).not.toMatch(/currentProjectPath/);
    expect(serviceSource).not.toMatch(/currentProjectSession/);
    expect(serviceSource).not.toMatch(/mutateCurrentProject/);
    expect(serviceSource).not.toMatch(/openProjectSession\(/);
    expect(serviceSource).not.toMatch(/closeCurrentProject/);
    expect(serviceSource).toContain("retainProjectSession(");
    expect(serviceSource).toContain("releaseProjectSession(");
  });

  it("keeps production Studio sources off the removed current-project service seams", () => {
    expect(findTokenMatches(/mutateCurrentProject(Async|AndFlush)?\(/g)).toEqual([]);
    expect(findTokenMatches(/getCurrentProjectPath\(/g)).toEqual([]);
    expect(findTokenMatches(/getCurrentProjectSession\(/g)).toEqual([]);
    expect(findTokenMatches(/closeCurrentProject\(/g)).toEqual([]);
    expect(findTokenMatches(/runCurrentProject(FromNode)?\(/g)).toEqual([]);
  });
});
