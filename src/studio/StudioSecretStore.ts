import type { StudioSecretStore as StudioSecretStoreContract } from "./types";

const SERVICE_NAME = "systemsculpt-studio";

export class StudioSecretStore implements StudioSecretStoreContract {
  private keytarModule: any | null = null;
  private initialized = false;

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const loaded = (globalThis as any)?.require?.("keytar");
      this.keytarModule = loaded?.default || loaded || null;
    } catch {
      this.keytarModule = null;
    }
  }

  isAvailable(): boolean {
    return this.keytarModule !== null;
  }

  async getSecret(referenceId: string): Promise<string> {
    await this.ensureInitialized();
    if (!this.keytarModule || typeof this.keytarModule.getPassword !== "function") {
      throw new Error(
        "Studio secret storage requires OS keychain support (keytar). This build cannot resolve keychain references."
      );
    }

    const secret = await this.keytarModule.getPassword(SERVICE_NAME, referenceId);
    if (!secret) {
      throw new Error(`No keychain secret found for reference "${referenceId}".`);
    }
    return secret;
  }
}
