/** @jest-environment jsdom */
import { openExternalUrl } from "../externalUrl";
import { resolveElectronModule } from "../../platform/hostCapabilities";

jest.mock("../../platform/hostCapabilities", () => ({
  resolveElectronModule: jest.fn(() => undefined),
}));

const resolveElectron = resolveElectronModule as jest.Mock;

type AnchorClick = Readonly<{
  href: string | null;
  target: string | null;
  rel: string | null;
  connected: boolean;
}>;

describe("openExternalUrl", () => {
  let clicks: AnchorClick[];
  let clickSpy: jest.SpyInstance;

  beforeEach(() => {
    resolveElectron.mockReset();
    resolveElectron.mockReturnValue(undefined);
    clicks = [];
    // jsdom cannot navigate; capture the anchor state instead of clicking.
    clickSpy = jest
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicks.push({
          href: this.getAttribute("href"),
          target: this.getAttribute("target"),
          rel: this.getAttribute("rel"),
          connected: this.isConnected,
        });
      });
  });

  afterEach(() => {
    clickSpy.mockRestore();
  });

  it("prefers the system browser via Electron shell on desktop", async () => {
    const openExternal = jest.fn().mockResolvedValue(undefined);
    resolveElectron.mockReturnValue({ shell: { openExternal } });

    await expect(openExternalUrl("https://systemsculpt.com/sign-in")).resolves.toBe(true);

    expect(openExternal).toHaveBeenCalledWith("https://systemsculpt.com/sign-in");
    expect(clicks).toHaveLength(0);
  });

  it("opens through a synthetic anchor click when Electron is unavailable", async () => {
    const openSpy = jest.spyOn(window, "open").mockReturnValue(null);

    await expect(openExternalUrl("https://systemsculpt.com/sign-in")).resolves.toBe(true);

    expect(clicks).toEqual([
      {
        href: "https://systemsculpt.com/sign-in",
        target: "_blank",
        rel: "noopener noreferrer",
        connected: true,
      },
    ]);
    expect(document.querySelector("a")).toBeNull();
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it("falls back to the anchor when shell.openExternal fails", async () => {
    const openExternal = jest.fn().mockRejectedValue(new Error("no handler"));
    resolveElectron.mockReturnValue({ shell: { openExternal } });

    await expect(openExternalUrl("https://systemsculpt.com/sign-in")).resolves.toBe(true);

    expect(clicks).toHaveLength(1);
  });

  it("falls back to a featureless window.open when the anchor click throws", async () => {
    clickSpy.mockImplementation(() => {
      throw new Error("blocked");
    });
    const openSpy = jest.spyOn(window, "open").mockReturnValue(null);

    await expect(openExternalUrl("https://systemsculpt.com/sign-in")).resolves.toBe(true);

    // WKWebView refuses window.open with a features string, so exactly two args.
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy.mock.calls[0]).toEqual(["https://systemsculpt.com/sign-in", "_blank"]);
    expect(document.querySelector("a")).toBeNull();
    openSpy.mockRestore();
  });

  it("rejects non-http(s) and malformed URLs without opening anything", async () => {
    const openSpy = jest.spyOn(window, "open").mockReturnValue(null);

    await expect(openExternalUrl("javascript:alert(1)")).resolves.toBe(false);
    await expect(openExternalUrl("data:text/html,hi")).resolves.toBe(false);
    await expect(openExternalUrl("not a url")).resolves.toBe(false);
    await expect(openExternalUrl("")).resolves.toBe(false);

    expect(clicks).toHaveLength(0);
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });
});
