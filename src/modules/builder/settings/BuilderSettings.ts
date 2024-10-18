export interface BuilderSettings {
  // Define your builder settings here
  exampleSetting: string;
  builderCanvasDirectory: string;
}

export const DEFAULT_BUILDER_SETTINGS: BuilderSettings = {
  exampleSetting: "Default value",
  builderCanvasDirectory: "SystemSculpt/Builder",
};
