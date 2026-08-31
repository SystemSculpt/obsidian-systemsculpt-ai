declare module "obsidian" {
  interface Vault {
    /** Undocumented Obsidian configuration lookup used for ignore filters. */
    getConfig(key: string): unknown;
  }
}

export {};
