import SystemSculptPlugin from "../../main";
import {
  BuilderSettings,
  DEFAULT_BUILDER_SETTINGS,
} from "./settings/BuilderSettings";
import { BuilderSettingTab } from "./settings/BuilderSettingTab";
import { TFile, Notice, WorkspaceLeaf } from "obsidian";

export class BuilderModule {
  plugin: SystemSculptPlugin;
  settings: BuilderSettings;

  constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
    this.settings = DEFAULT_BUILDER_SETTINGS;
  }

  async load() {
    await this.loadSettings();
    this.addCommands();

    // Add event listener for when the active leaf changes
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("active-leaf-change", (leaf) => {
        this.handleActiveLeafChange(leaf);
      })
    );
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_BUILDER_SETTINGS,
      await this.plugin.loadData()
    );
  }

  async saveSettings() {
    await this.plugin.saveSettings(this.settings);
  }

  settingsDisplay(containerEl: HTMLElement): void {
    new BuilderSettingTab(this.plugin.app, this, containerEl).display();
  }

  private addCommands() {
    this.plugin.addCommand({
      id: "open-systemsculpt-ai-builder-canvas",
      name: "Open SystemSculpt AI Builder Canvas",
      callback: () => this.openBuilderCanvas(),
    });
  }

  private async openBuilderCanvas() {
    const fileName = `SystemSculpt AI Builder Canvas ${Date.now()}.canvas`;
    const filePath = `${this.settings.builderCanvasDirectory}/${fileName}`;

    // Ensure the directory exists
    await this.plugin.app.vault.adapter.mkdir(
      this.settings.builderCanvasDirectory
    );

    const file = await this.plugin.app.vault.create(filePath, "{}");

    if (file instanceof TFile) {
      const leaf = this.plugin.app.workspace.getLeaf(true);
      await leaf.openFile(file, { active: true });

      // Optionally, you can add some initial content to the canvas
      await this.initializeCanvasContent(file);

      new Notice("SystemSculpt AI Builder Canvas created");
    }
  }

  private async initializeCanvasContent(file: TFile) {
    const initialContent = {
      nodes: [],
      edges: [],
      systemsculptAIBuilder: true, // This is our unique identifier
      version: "1.0", // Adding a version for future compatibility
    };
    await this.plugin.app.vault.modify(
      file,
      JSON.stringify(initialContent, null, 2)
    );
  }

  private handleActiveLeafChange(leaf: WorkspaceLeaf | null) {
    if (leaf && leaf.view.getViewType() === "canvas") {
      const canvasView = leaf.view as any;
      if (canvasView.canvas && canvasView.canvas.data.systemsculptAIBuilder) {
        this.addBuilderMenuToCanvas(canvasView);
      } else {
        this.removeBuilderMenuFromCanvas(canvasView);
      }
    } else {
      // If the new active leaf is not a canvas, remove the menu if it exists
      this.removeBuilderMenuFromCanvas();
    }
  }

  private addBuilderMenuToCanvas(canvasView: any) {
    const canvasContainer =
      canvasView.containerEl.querySelector(".canvas-wrapper");
    if (!canvasContainer) return;

    // Remove existing builder menu if it's there
    this.removeBuilderMenuFromCanvas(canvasView);

    const builderMenu = canvasContainer.createDiv("systemsculpt-builder-menu");
    builderMenu.style.position = "absolute";
    builderMenu.style.top = "10px";
    builderMenu.style.left = "10px";
    builderMenu.style.zIndex = "1000";

    const aiButton = builderMenu.createEl("button", {
      cls: "systemsculpt-builder-ai-button",
      text: "SSAI Settings",
    });

    aiButton.addEventListener("click", () => {
      console.log("Hello! Button is working!");
    });

    // You can add more buttons here in the future
  }

  private removeBuilderMenuFromCanvas(canvasView?: any) {
    const container = canvasView ? canvasView.containerEl : document;

    const existingBuilderMenu = container.querySelector(
      ".systemsculpt-builder-menu"
    );
    if (existingBuilderMenu) {
      existingBuilderMenu.remove();
    }
  }
}
