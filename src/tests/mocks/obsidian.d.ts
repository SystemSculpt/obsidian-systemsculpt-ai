/**
 * Types for the shared Jest Obsidian host (obsidian.js). tsconfig.test.json
 * maps "obsidian" here. Every export keeps its obsidian.d.ts type; the
 * declarations below add only what the mock really does differently, so tests
 * construct mock objects the way the mock accepts them.
 */
import * as obsidian from "../../../node_modules/obsidian";

export * from "../../../node_modules/obsidian";

export declare class TFile extends obsidian.TFile {
  /** Missing name, extension and basename are derived from path. */
  constructor(init?: {
    path?: string;
    name?: string;
    extension?: string;
    stat?: Partial<obsidian.FileStats>;
  });
}

export declare class TFolder extends obsidian.TFolder {
  /** The name is derived from path. */
  constructor(init?: { path?: string; children?: obsidian.TAbstractFile[] });
}

export declare class WorkspaceLeaf extends obsidian.WorkspaceLeaf {
  constructor(app?: obsidian.App);
}

export declare class FileSystemAdapter extends obsidian.FileSystemAdapter {
  constructor(basePath?: string);
}

export declare class MarkdownView extends obsidian.MarkdownView {
  constructor(leaf?: obsidian.WorkspaceLeaf);
}

/** Concrete in the mock, with a default App and manifest. */
export declare class Plugin extends obsidian.Plugin {
  constructor(app?: obsidian.App, manifest?: obsidian.PluginManifest);
}
