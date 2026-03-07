import { App, TAbstractFile, TFile, WorkspaceLeaf } from "../../shims/obsidian";

const findFileByPath = (
  files: readonly TFile[],
  path: string
): TAbstractFile | null => {
  return files.find((file) => file.path === path) ?? null;
};

export const createVideoHostApp = (files: readonly TFile[] = []) => {
  const activeLeaf = new WorkspaceLeaf();

  const app = new App({
    workspace: {
      activeLeaf,
      trigger: () => {},
      openLinkText: () => {},
      getLeavesOfType: () => [],
      getLeaf: () => new WorkspaceLeaf(app),
      setActiveLeaf: () => {},
    },
    vault: {
      getFiles: () => [...files],
      getAbstractFileByPath: (path: string) => findFileByPath(files, path),
    },
    plugins: {
      plugins: {
        "systemsculpt-plugin": {
          settingsManager: {
            settings: {
              debugMode: false,
            },
          },
        },
      },
    },
  });

  activeLeaf.app = app;
  return app;
};
