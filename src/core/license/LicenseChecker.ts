import { App, TFile } from "obsidian";
import { showPopup } from "../ui";
import { LICENSE_URL } from "../../types";

export class LicenseChecker {
  private static PRO_EXTENSIONS = [
    "pdf",
    "doc",
    "docx",
    "ppt",
    "pptx",
    "xls",
    "xlsx",
    "mp3",
    "wav",
    "m4a",
    "ogg",
    "webm",
  ];

  public static requiresProLicense(extension: string): boolean {
    return this.PRO_EXTENSIONS.includes(extension.toLowerCase());
  }

  public static hasValidLicense(plugin: any): boolean {
    // Treat presence of a key as sufficient for attempting; server is source-of-truth
    // We still surface last-known validation state to gate heavy operations UX-wise
    return !!plugin.settings.licenseKey?.trim() && plugin.settings.licenseValid === true;
  }

  public static async showProFeaturePopup(app: App): Promise<boolean> {
    const result = await showPopup(
      app,
      "Support SystemSculpt's development and unlock powerful document processing features. Upgrade to Pro to process PDFs, Word documents, and audio files.",
      {
        title: "Pro Feature Required",
        primaryButton: "Get License",
        secondaryButton: "Maybe Later",
        icon: "sparkles",
      }
    );

    if (result?.confirmed) {
      window.open(LICENSE_URL, "_blank");
    }

    return result?.confirmed || false;
  }

  public static async checkLicenseForFile(
    file: TFile,
    app: App,
    plugin: any
  ): Promise<boolean> {
    if (this.requiresProLicense(file.extension.toLowerCase())) {
      if (!this.hasValidLicense(plugin)) {
        await this.showProFeaturePopup(app);
        return false;
      }
    }
    return true;
  }
}
