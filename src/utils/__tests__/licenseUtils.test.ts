/**
 * @jest-environment jsdom
 */
import { checkPremiumUserStatus } from "../licenseUtils";
import { SystemSculptSettings } from "../../types";

// Create a minimal settings object for testing
const createMockSettings = (overrides: Partial<SystemSculptSettings> = {}): SystemSculptSettings => ({
  licenseValid: false,
  displayName: "",
  userName: "",
  userEmail: "",
  ...overrides,
} as SystemSculptSettings);

describe("licenseUtils", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("checkPremiumUserStatus", () => {
    it("returns isPremium false when licenseValid is false", () => {
      const settings = createMockSettings({ licenseValid: false });
      const status = checkPremiumUserStatus(settings);

      expect(status.isPremium).toBe(false);
    });

    it("returns isPremium true when licenseValid is true", () => {
      const settings = createMockSettings({ licenseValid: true });
      const status = checkPremiumUserStatus(settings);

      expect(status.isPremium).toBe(true);
    });

    it("uses displayName when available", () => {
      const settings = createMockSettings({
        displayName: "John Doe",
        userName: "johnd",
        userEmail: "john@example.com",
      });
      const status = checkPremiumUserStatus(settings);

      expect(status.displayName).toBe("John Doe");
    });

    it("falls back to userName when displayName is empty", () => {
      const settings = createMockSettings({
        displayName: "",
        userName: "johnd",
        userEmail: "john@example.com",
      });
      const status = checkPremiumUserStatus(settings);

      expect(status.displayName).toBe("johnd");
    });

    it("falls back to userEmail when displayName and userName are empty", () => {
      const settings = createMockSettings({
        displayName: "",
        userName: "",
        userEmail: "john@example.com",
      });
      const status = checkPremiumUserStatus(settings);

      expect(status.displayName).toBe("john@example.com");
    });

    it("falls back to User when all name fields are empty", () => {
      const settings = createMockSettings({
        displayName: "",
        userName: "",
        userEmail: "",
      });
      const status = checkPremiumUserStatus(settings);

      expect(status.displayName).toBe("User");
    });

    it("provides greeting for premium users", () => {
      const settings = createMockSettings({
        licenseValid: true,
        displayName: "John",
      });
      const status = checkPremiumUserStatus(settings);

      expect(status.greeting).toBeDefined();
      expect(status.greeting).toContain("John");
      expect(status.greeting).toContain("Premium");
    });

    it("provides special greeting for family members", () => {
      const settings = createMockSettings({
        licenseValid: true,
        displayName: "My Daughter Sarah",
      });
      const status = checkPremiumUserStatus(settings);

      expect(status.greeting).toContain("cherished family member");
    });

    it("does not provide greeting for non-premium users", () => {
      const settings = createMockSettings({
        licenseValid: false,
        displayName: "John",
      });
      const status = checkPremiumUserStatus(settings);

      expect(status.greeting).toBeUndefined();
    });
  });
});
