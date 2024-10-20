export interface BuilderSettings {
  exampleSetting: string;
  builderCanvasDirectory: string;
  nodeData: { [nodeId: string]: any };
}

export const DEFAULT_BUILDER_SETTINGS: BuilderSettings = {
  exampleSetting: "Default value",
  builderCanvasDirectory: "SystemSculpt/Builder",
  nodeData: {},
};
