declare namespace WebdriverIO {
  interface Browser {
    obsidian?: {
      isPluginEnabled?: (pluginId: string) => Promise<boolean>;
      enablePlugin?: (pluginId: string) => Promise<void>;
      executeObsidianCommand?: (commandId: string) => Promise<void>;
    };
  }
}
