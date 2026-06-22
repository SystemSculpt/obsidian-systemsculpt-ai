/**
 * @jest-environment jsdom
 */

import { ChatView } from "../ChatView";
import { ERROR_CODES, SystemSculptError } from "../../../utils/errors";
import { showPopup } from "../../../core/ui/";
import { openExternalUrl } from "../../../utils/externalUrl";
import { uiSetup } from "../uiSetup";
import { SYSTEMSCULPT_WEBSITE } from "../../../constants/externalServices";

jest.mock("../../../core/ui/", () => ({ showPopup: jest.fn() }));
jest.mock("../../../utils/externalUrl", () => ({ openExternalUrl: jest.fn() }));
jest.mock("../uiSetup", () => ({
  uiSetup: {
    showLicenseBanner: jest.fn(),
    hideLicenseBanner: jest.fn(),
    updateToolCompatibilityWarning: jest.fn().mockResolvedValue(undefined),
  },
}));

const showPopupMock = showPopup as jest.Mock;
const openExternalUrlMock = openExternalUrl as jest.Mock;
const showBannerMock = uiSetup.showLicenseBanner as jest.Mock;
const hideBannerMock = uiSetup.hideLicenseBanner as jest.Mock;

const makeHandleErrorView = (opts: { automation?: boolean; updateSettings: jest.Mock }) => ({
  inputHandler: { isAutomationRequestActive: jest.fn(() => opts.automation === true) },
  getEffectiveSelectedModelId: jest.fn(() => "systemsculpt@@systemsculpt/ai-agent"),
  resetFailedAssistantTurn: jest.fn().mockResolvedValue(undefined),
  openSetupTab: jest.fn(),
  messages: [],
  chatId: "chat-license",
  isGenerating: false,
  app: {},
  plugin: {
    getSettingsManager: () => ({ updateSettings: opts.updateSettings }),
    settings: { licenseValid: true },
  },
});

const makeRefreshView = (opts: {
  licenseValid: boolean;
  getCreditsBalance: jest.Mock;
  updateSettings: jest.Mock;
}) => ({
  plugin: {
    getEntitlementService: () => ({ hasSystemSculptLicense: () => true }),
    getSettingsManager: () => ({ updateSettings: opts.updateSettings }),
    settings: { licenseValid: opts.licenseValid },
  },
  aiService: { getCreditsBalance: opts.getCreditsBalance },
  updateCreditsIndicator: jest.fn().mockResolvedValue(undefined),
  creditsBalanceRefreshPromise: null as Promise<void> | null,
  creditsBalance: null,
});

describe("ChatView license error handling (#249)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("expired license: flips licenseValid, shows an expired banner, and renews on the primary action", async () => {
    showPopupMock.mockResolvedValue({ action: "primary" });
    const updateSettings = jest.fn().mockResolvedValue(undefined);
    const view = makeHandleErrorView({ updateSettings });

    await ChatView.prototype.handleError.call(
      view as any,
      new SystemSculptError("expired", ERROR_CODES.LICENSE_EXPIRED, 401, {
        renewUrl: "https://systemsculpt.com/renew",
      })
    );

    expect(view.resetFailedAssistantTurn).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({ licenseValid: false });
    expect(showBannerMock).toHaveBeenCalledWith(view, {
      expired: true,
      renewUrl: "https://systemsculpt.com/renew",
    });
    expect(showPopupMock).toHaveBeenCalledTimes(1);
    expect(openExternalUrlMock).toHaveBeenCalledWith("https://systemsculpt.com/renew");
    expect(view.openSetupTab).not.toHaveBeenCalled();
  });

  it("invalid license: shows an invalid banner, opens settings on the secondary action, and falls back to the license URL", async () => {
    showPopupMock.mockResolvedValue({ action: "secondary" });
    const updateSettings = jest.fn().mockResolvedValue(undefined);
    const view = makeHandleErrorView({ updateSettings });

    await ChatView.prototype.handleError.call(
      view as any,
      // A real managed invalid-license carries licenseFailure: true (set by the
      // SystemSculpt API error path) — that is what distinguishes it from a BYOK
      // provider key failure, which is also mapped to INVALID_LICENSE (#249).
      new SystemSculptError("invalid", ERROR_CODES.INVALID_LICENSE, 401, { licenseFailure: true })
    );

    expect(showBannerMock).toHaveBeenCalledWith(view, {
      expired: false,
      renewUrl: SYSTEMSCULPT_WEBSITE.LICENSE,
    });
    expect(view.openSetupTab).toHaveBeenCalledWith("account");
    expect(openExternalUrlMock).not.toHaveBeenCalled();
  });

  it("BYOK provider auth failure (INVALID_LICENSE without licenseFailure) is not treated as a SystemSculpt license problem (#249)", async () => {
    const updateSettings = jest.fn().mockResolvedValue(undefined);
    // automation: true so the fall-through catch-all skips UI construction.
    const view = makeHandleErrorView({ automation: true, updateSettings });

    await ChatView.prototype.handleError.call(
      view as any,
      new SystemSculptError(
        "Invalid API key or authentication error.",
        ERROR_CODES.INVALID_LICENSE,
        401,
        { provider: "openrouter", statusCode: 401 }
      )
    );

    // Must NOT flip the managed SystemSculpt license or show the renewal banner —
    // the failing credential is the user's own provider key, not a subscription.
    expect(updateSettings).not.toHaveBeenCalledWith({ licenseValid: false });
    expect(showBannerMock).not.toHaveBeenCalled();
    expect(showPopupMock).not.toHaveBeenCalled();
    // The catch-all still cleans up the failed assistant turn.
    expect(view.resetFailedAssistantTurn).toHaveBeenCalled();
  });

  it("during automation: heals state and banners but skips the blocking popup", async () => {
    const updateSettings = jest.fn().mockResolvedValue(undefined);
    const view = makeHandleErrorView({ automation: true, updateSettings });

    await ChatView.prototype.handleError.call(
      view as any,
      new SystemSculptError("expired", ERROR_CODES.LICENSE_EXPIRED, 401, {})
    );

    expect(view.resetFailedAssistantTurn).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({ licenseValid: false });
    expect(showBannerMock).toHaveBeenCalledTimes(1);
    expect(showPopupMock).not.toHaveBeenCalled();
    expect(openExternalUrlMock).not.toHaveBeenCalled();
  });

  it("refreshCreditsBalance: proactively flags an expired license from a credits 401", async () => {
    const updateSettings = jest.fn().mockResolvedValue(undefined);
    const getCreditsBalance = jest.fn().mockRejectedValue(
      new SystemSculptError("expired", ERROR_CODES.LICENSE_EXPIRED, 401, { renewUrl: "https://x/renew" })
    );
    const view = makeRefreshView({ licenseValid: true, getCreditsBalance, updateSettings });

    await ChatView.prototype.refreshCreditsBalance.call(view as any);

    expect(updateSettings).toHaveBeenCalledWith({ licenseValid: false });
    expect(showBannerMock).toHaveBeenCalledWith(view, { expired: true, renewUrl: "https://x/renew" });
    expect(hideBannerMock).not.toHaveBeenCalled();
  });

  it("refreshCreditsBalance: flags a managed INVALID_LICENSE (licenseFailure) as an invalid-key banner", async () => {
    const updateSettings = jest.fn().mockResolvedValue(undefined);
    const getCreditsBalance = jest.fn().mockRejectedValue(
      new SystemSculptError("invalid", ERROR_CODES.INVALID_LICENSE, 401, {
        licenseFailure: true,
        renewUrl: "https://x/renew",
      })
    );
    const view = makeRefreshView({ licenseValid: true, getCreditsBalance, updateSettings });

    await ChatView.prototype.refreshCreditsBalance.call(view as any);

    expect(updateSettings).toHaveBeenCalledWith({ licenseValid: false });
    expect(showBannerMock).toHaveBeenCalledWith(view, { expired: false, renewUrl: "https://x/renew" });
  });

  it("refreshCreditsBalance: heals stale invalid state and hides the banner on a successful fetch", async () => {
    const updateSettings = jest.fn().mockResolvedValue(undefined);
    const getCreditsBalance = jest.fn().mockResolvedValue({ remaining: 100 });
    const view = makeRefreshView({ licenseValid: false, getCreditsBalance, updateSettings });

    await ChatView.prototype.refreshCreditsBalance.call(view as any);

    expect(updateSettings).toHaveBeenCalledWith({ licenseValid: true });
    expect(hideBannerMock).toHaveBeenCalledWith(view);
  });

  it("refreshCreditsBalance: does not rewrite settings when the license is already valid", async () => {
    const updateSettings = jest.fn().mockResolvedValue(undefined);
    const getCreditsBalance = jest.fn().mockResolvedValue({ remaining: 100 });
    const view = makeRefreshView({ licenseValid: true, getCreditsBalance, updateSettings });

    await ChatView.prototype.refreshCreditsBalance.call(view as any);

    expect(updateSettings).not.toHaveBeenCalled();
    expect(hideBannerMock).toHaveBeenCalledWith(view);
  });

  it("refreshCreditsBalance: stays silent for a non-license credits error", async () => {
    const updateSettings = jest.fn().mockResolvedValue(undefined);
    const getCreditsBalance = jest.fn().mockRejectedValue(
      new SystemSculptError("boom", ERROR_CODES.STREAM_ERROR, 500, {})
    );
    const view = makeRefreshView({ licenseValid: true, getCreditsBalance, updateSettings });

    await ChatView.prototype.refreshCreditsBalance.call(view as any);

    expect(updateSettings).not.toHaveBeenCalled();
    expect(showBannerMock).not.toHaveBeenCalled();
  });
});
