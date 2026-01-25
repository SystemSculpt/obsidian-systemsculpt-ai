/**
 * @jest-environment jsdom
 */
import { App, TFile } from "obsidian";
import { LicenseChecker } from "../LicenseChecker";

// Mock the showPopup function
jest.mock("../../ui", () => ({
  showPopup: jest.fn(),
}));

describe("LicenseChecker", () => {
  describe("requiresProLicense", () => {
    describe("PDF extensions", () => {
      it("returns true for pdf", () => {
        expect(LicenseChecker.requiresProLicense("pdf")).toBe(true);
      });

      it("returns true for PDF (uppercase)", () => {
        expect(LicenseChecker.requiresProLicense("PDF")).toBe(true);
      });
    });

    describe("Word document extensions", () => {
      it("returns true for doc", () => {
        expect(LicenseChecker.requiresProLicense("doc")).toBe(true);
      });

      it("returns true for docx", () => {
        expect(LicenseChecker.requiresProLicense("docx")).toBe(true);
      });
    });

    describe("PowerPoint extensions", () => {
      it("returns true for ppt", () => {
        expect(LicenseChecker.requiresProLicense("ppt")).toBe(true);
      });

      it("returns true for pptx", () => {
        expect(LicenseChecker.requiresProLicense("pptx")).toBe(true);
      });
    });

    describe("Excel extensions", () => {
      it("returns true for xls", () => {
        expect(LicenseChecker.requiresProLicense("xls")).toBe(true);
      });

      it("returns true for xlsx", () => {
        expect(LicenseChecker.requiresProLicense("xlsx")).toBe(true);
      });
    });

    describe("Audio extensions", () => {
      it("returns true for mp3", () => {
        expect(LicenseChecker.requiresProLicense("mp3")).toBe(true);
      });

      it("returns true for wav", () => {
        expect(LicenseChecker.requiresProLicense("wav")).toBe(true);
      });

      it("returns true for m4a", () => {
        expect(LicenseChecker.requiresProLicense("m4a")).toBe(true);
      });

      it("returns true for ogg", () => {
        expect(LicenseChecker.requiresProLicense("ogg")).toBe(true);
      });

      it("returns true for webm", () => {
        expect(LicenseChecker.requiresProLicense("webm")).toBe(true);
      });
    });

    describe("Free extensions", () => {
      it("returns false for md", () => {
        expect(LicenseChecker.requiresProLicense("md")).toBe(false);
      });

      it("returns false for txt", () => {
        expect(LicenseChecker.requiresProLicense("txt")).toBe(false);
      });

      it("returns false for jpg", () => {
        expect(LicenseChecker.requiresProLicense("jpg")).toBe(false);
      });

      it("returns false for png", () => {
        expect(LicenseChecker.requiresProLicense("png")).toBe(false);
      });

      it("returns false for json", () => {
        expect(LicenseChecker.requiresProLicense("json")).toBe(false);
      });

      it("returns false for unknown extension", () => {
        expect(LicenseChecker.requiresProLicense("xyz")).toBe(false);
      });
    });

    describe("case insensitivity", () => {
      it("handles mixed case PDF", () => {
        expect(LicenseChecker.requiresProLicense("Pdf")).toBe(true);
      });

      it("handles mixed case DOCX", () => {
        expect(LicenseChecker.requiresProLicense("DoCx")).toBe(true);
      });

      it("handles mixed case MP3", () => {
        expect(LicenseChecker.requiresProLicense("Mp3")).toBe(true);
      });
    });
  });

  describe("hasValidLicense", () => {
    it("returns true when license key exists and is valid", () => {
      const plugin = {
        settings: {
          licenseKey: "abc123",
          licenseValid: true,
        },
      };

      expect(LicenseChecker.hasValidLicense(plugin)).toBe(true);
    });

    it("returns false when license key is empty", () => {
      const plugin = {
        settings: {
          licenseKey: "",
          licenseValid: true,
        },
      };

      expect(LicenseChecker.hasValidLicense(plugin)).toBe(false);
    });

    it("returns false when license key is whitespace only", () => {
      const plugin = {
        settings: {
          licenseKey: "   ",
          licenseValid: true,
        },
      };

      expect(LicenseChecker.hasValidLicense(plugin)).toBe(false);
    });

    it("returns false when licenseValid is false", () => {
      const plugin = {
        settings: {
          licenseKey: "abc123",
          licenseValid: false,
        },
      };

      expect(LicenseChecker.hasValidLicense(plugin)).toBe(false);
    });

    it("returns false when license key is undefined", () => {
      const plugin = {
        settings: {
          licenseValid: true,
        },
      };

      expect(LicenseChecker.hasValidLicense(plugin)).toBe(false);
    });

    it("returns false when licenseValid is undefined", () => {
      const plugin = {
        settings: {
          licenseKey: "abc123",
        },
      };

      expect(LicenseChecker.hasValidLicense(plugin)).toBe(false);
    });

    it("throws when settings is undefined", () => {
      const plugin = {};

      expect(() => LicenseChecker.hasValidLicense(plugin)).toThrow();
    });
  });

  describe("showProFeaturePopup", () => {
    let app: App;
    let mockShowPopup: jest.Mock;

    beforeEach(() => {
      app = new App();
      mockShowPopup = require("../../ui").showPopup;
      mockShowPopup.mockReset();
    });

    it("calls showPopup with correct parameters", async () => {
      mockShowPopup.mockResolvedValue({ confirmed: false });

      await LicenseChecker.showProFeaturePopup(app);

      expect(mockShowPopup).toHaveBeenCalledWith(
        app,
        expect.stringContaining("Pro"),
        expect.objectContaining({
          title: "Pro Feature Required",
          primaryButton: "Get License",
          secondaryButton: "Maybe Later",
          icon: "sparkles",
        })
      );
    });

    it("returns true when user confirms", async () => {
      mockShowPopup.mockResolvedValue({ confirmed: true });

      const result = await LicenseChecker.showProFeaturePopup(app);

      expect(result).toBe(true);
    });

    it("returns false when user declines", async () => {
      mockShowPopup.mockResolvedValue({ confirmed: false });

      const result = await LicenseChecker.showProFeaturePopup(app);

      expect(result).toBe(false);
    });

    it("returns false when popup returns null", async () => {
      mockShowPopup.mockResolvedValue(null);

      const result = await LicenseChecker.showProFeaturePopup(app);

      expect(result).toBe(false);
    });

    it("opens license URL when user confirms", async () => {
      const mockOpen = jest.fn();
      window.open = mockOpen;
      mockShowPopup.mockResolvedValue({ confirmed: true });

      await LicenseChecker.showProFeaturePopup(app);

      expect(mockOpen).toHaveBeenCalledWith(expect.any(String), "_blank");
    });

    it("does not open URL when user declines", async () => {
      const mockOpen = jest.fn();
      window.open = mockOpen;
      mockShowPopup.mockResolvedValue({ confirmed: false });

      await LicenseChecker.showProFeaturePopup(app);

      expect(mockOpen).not.toHaveBeenCalled();
    });
  });

  describe("checkLicenseForFile", () => {
    let app: App;
    let mockShowPopup: jest.Mock;

    beforeEach(() => {
      app = new App();
      mockShowPopup = require("../../ui").showPopup;
      mockShowPopup.mockReset();
    });

    it("returns true for free file types", async () => {
      const file = new TFile({ path: "test.md" });
      const plugin = { settings: {} };

      const result = await LicenseChecker.checkLicenseForFile(file, app, plugin);

      expect(result).toBe(true);
    });

    it("returns true for pro file with valid license", async () => {
      const file = new TFile({ path: "document.pdf" });
      const plugin = {
        settings: {
          licenseKey: "abc123",
          licenseValid: true,
        },
      };

      const result = await LicenseChecker.checkLicenseForFile(file, app, plugin);

      expect(result).toBe(true);
    });

    it("returns false for pro file without license", async () => {
      const file = new TFile({ path: "document.pdf" });
      const plugin = {
        settings: {
          licenseKey: "",
          licenseValid: false,
        },
      };
      mockShowPopup.mockResolvedValue({ confirmed: false });

      const result = await LicenseChecker.checkLicenseForFile(file, app, plugin);

      expect(result).toBe(false);
    });

    it("shows popup for pro file without license", async () => {
      const file = new TFile({ path: "audio.mp3" });
      const plugin = {
        settings: {},
      };
      mockShowPopup.mockResolvedValue({ confirmed: false });

      await LicenseChecker.checkLicenseForFile(file, app, plugin);

      expect(mockShowPopup).toHaveBeenCalled();
    });

    it("does not show popup for free files", async () => {
      const file = new TFile({ path: "note.txt" });
      const plugin = { settings: {} };

      await LicenseChecker.checkLicenseForFile(file, app, plugin);

      expect(mockShowPopup).not.toHaveBeenCalled();
    });
  });
});
