/**
 * @jest-environment jsdom
 *
 * Exercise account connection through the exact production bundle and its
 * onload composition. Only host network, browser handoff, and storage edges
 * are mocked; no deep link or manual exchange completes these sign-ins.
 * A fresh signed-out vault opens with no dialog; sign-in starts from an
 * explicit plan gate and finishes in that same modal.
 * Run `npm run build` first.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { App, requestUrl } from "obsidian";
import type SystemSculptPlugin from "../../src/main";
import { hostRequest } from "./host-request";
import { captureStartupIdentity, expectProductionStartupIdentity } from "./startup-identity-assertions";

const BUNDLE_PATH = path.resolve(__dirname, "..", "..", "main.js");
const MANIFEST_PATH = path.resolve(__dirname, "..", "..", "manifest.json");
const POLL_URL = "https://systemsculpt.com/api/plugin/auth/poll";
const CONNECTED_ACCOUNT = {
  status: "no_license",
  account: { name: "Test User", email: "account-connect@example.test" },
};

function hostResponse(payload: unknown) {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    text: JSON.stringify(payload),
    json: payload,
    arrayBuffer: new ArrayBuffer(0),
  };
}

function button(testId: string): HTMLButtonElement {
  const element = document.querySelector<HTMLButtonElement>(`button[data-testid="${testId}"]`);
  expect(element).not.toBeNull();
  return element!;
}

describe("account connection in the built bundle", () => {
  let plugin: SystemSculptPlugin | undefined;
  let openedUrls: string[];
  let unexpectedRequests: string[];
  let connectCallback: Parameters<SystemSculptPlugin["registerObsidianProtocolHandler"]>[1] | undefined;
  const request = jest.mocked(requestUrl);
  // The shared jsdom Headers shim has get/set but lacks this browser API,
  // which the real PlatformRequestClient uses to normalize host responses.
  const originalHas = Object.getOwnPropertyDescriptor(Headers.prototype, "has");

  beforeAll(() => {
    if (!existsSync(BUNDLE_PATH)) throw new Error("Run `npm run build` before this integration test.");
    if (!originalHas) {
      Object.defineProperty(Headers.prototype, "has", {
        configurable: true,
        value(this: Headers, name: string) { return this.get(name) !== null; },
      });
    }
  });

  afterAll(() => {
    if (!originalHas) Reflect.deleteProperty(Headers.prototype, "has");
  });

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
    openedUrls = [];
    unexpectedRequests = [];
    jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      openedUrls.push(this.href);
    });
    jest.spyOn(window, "fetch").mockImplementation(async (input) => {
      unexpectedRequests.push(String(input));
      throw new Error("Unexpected fetch in account-connect integration test");
    });
    request.mockReset();
    request.mockImplementation(hostRequest(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === POLL_URL) return hostResponse(CONNECTED_ACCOUNT);
      if (url === "https://systemsculpt.com/api/plugin/releases/latest") {
        return hostResponse({
          contract_version: "plugin-release-v1",
          plugin_id: manifest.id,
          latest_version: manifest.version,
          release_url: `https://github.com/SystemSculpt/obsidian-systemsculpt-ai/releases/tag/${manifest.version}`,
          published_at: "2026-10-24T00:00:00.000Z",
        });
      }
      unexpectedRequests.push(url);
      throw new Error(`Unexpected host request: ${url}`);
    }));

    const bundleModule = require(BUNDLE_PATH);
    const PluginClass = bundleModule?.default ?? bundleModule;
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    plugin = new PluginClass(new App(), manifest);
    const registeredProtocols = jest.spyOn(plugin!, "registerObsidianProtocolHandler");
    const startupIdentity = captureStartupIdentity();
    // Use the host Component lifecycle so registered cleanup runs on unload.
    // Advancing the clock also settles onload's critical/deferred/layout work.
    plugin!.load();
    await jest.advanceTimersByTimeAsync(1_500);
    expectProductionStartupIdentity(startupIdentity, manifest.version);
    connectCallback = registeredProtocols.mock.calls.find(([action]) => action === "systemsculpt-connect")?.[1];
    expect(typeof connectCallback).toBe("function");
    // A fresh signed-out install is usable with nothing opened for it.
    await jest.advanceTimersByTimeAsync(10_000);
    expect(document.querySelector(".ss-upgrade-plan-modal")).toBeNull();
    expect(document.querySelectorAll("[role='dialog']")).toHaveLength(0);
    // Startup release metadata is unrelated to the sign-in requests below.
    request.mockClear();
  });

  afterEach(async () => {
    document.querySelectorAll<HTMLButtonElement>('button[data-testid="modal.close"]')
      .forEach((close) => close.click());
    plugin?.unload();
    await jest.advanceTimersByTimeAsync(0);
    plugin = undefined;
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    document.body.replaceChildren();
    expect(unexpectedRequests).toEqual([]);
  });

  async function openPlanGate(): Promise<void> {
    const command = (plugin as unknown as { _commands: Array<{ id: string; callback?: () => unknown }> })
      ._commands.find(({ id }) => id === "open-audio-processor");
    expect(command?.callback).toBeDefined();
    void command!.callback!();
    await jest.advanceTimersByTimeAsync(0);
    expect(document.querySelectorAll(".ss-upgrade-plan-modal")).toHaveLength(1);
  }

  async function beginInBrowser(): Promise<URL> {
    if (!document.querySelector(".ss-upgrade-plan-modal")) await openPlanGate();
    button("upgrade-plan.sign-in").click();
    await jest.advanceTimersByTimeAsync(0);
    expect(document.querySelector(".ss-upgrade-plan-modal")?.textContent)
      .toContain("Waiting for you to finish in the browser");
    expect(plugin!.getAccountConnectService().hasPendingRequest()).toBe(true);
    expect(openedUrls).toHaveLength(1);
    const signIn = new URL(openedUrls[0]);
    expect(signIn.origin).toBe("https://systemsculpt.com");
    expect(signIn.pathname).toBe("/sign-in");
    const connect = new URL(signIn.searchParams.get("redirect_url")!, signIn.origin);
    expect(connect.pathname).toBe("/plugin/connect");
    expect(connect.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(connect.searchParams.get("challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    return connect;
  }

  /** The plan-less account continues to the plan choice in the modal that started sign-in. */
  function expectSignedInPlanChoice(): void {
    expect(document.querySelectorAll("[role='dialog']")).toHaveLength(1);
    const modals = document.querySelectorAll(".ss-upgrade-plan-modal");
    expect(modals).toHaveLength(1);
    expect(modals[0].textContent).toContain("Signed in as account-connect@example.test.");
    expect(modals[0].textContent).not.toContain("Welcome");
    expect(modals[0].textContent).not.toContain("Waiting for you to finish in the browser");
    expect(modals[0].textContent).not.toContain("expired");
    expect(button("upgrade-plan.yearly").textContent).toContain("Subscribe yearly");
    expect(plugin!.getAccountConnectService().hasPendingRequest()).toBe(false);
  }

  it("hands off to the browser, waits for polling, and shows the result in place of the handoff", async () => {
    request.mockResolvedValueOnce(hostResponse({ status: "pending" }));
    const connect = await beginInBrowser();
    expect(request).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(3_500);
    expect(request).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".ss-upgrade-plan-modal")?.textContent)
      .toContain("Waiting for you to finish in the browser");
    expect(plugin!.getAccountConnectService().hasPendingRequest()).toBe(true);
    const poll = request.mock.calls[0][0];
    expect(poll).toMatchObject({ url: POLL_URL, method: "POST", throw: false });
    const { body, headers } = poll as { body: string; headers: Record<string, string> };
    expect(headers["x-license-key"]).toBeUndefined();
    const { verifier } = JSON.parse(body);
    expect(createHash("sha256").update(verifier).digest("base64url"))
      .toBe(connect.searchParams.get("challenge"));

    await jest.advanceTimersByTimeAsync(3_500);
    expectSignedInPlanChoice();
    expect(await plugin!.loadData()).toMatchObject({
      userEmail: CONNECTED_ACCOUNT.account.email,
      userName: CONNECTED_ACCOUNT.account.name,
      licenseKey: "",
      licenseValid: false,
    });
    // A delayed browser callback must preserve the actual no-plan outcome.
    connectCallback!({
      action: "systemsculpt-connect",
      state: connect.searchParams.get("state")!,
      code: "already-consumed-test-code",
    });
    await jest.advanceTimersByTimeAsync(0);
    expectSignedInPlanChoice();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed save visible after a late deep link, then completes a fresh browser sign-in", async () => {
    const firstConnect = await beginInBrowser();
    const previouslySaved = await plugin!.loadData();
    const save = jest.spyOn(plugin!, "saveData")
      .mockRejectedValueOnce(new Error("Local settings storage is unavailable"));

    await jest.advanceTimersByTimeAsync(3_500);
    expect(request).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      userEmail: CONNECTED_ACCOUNT.account.email,
    }));
    expect(await plugin!.loadData()).toEqual(previouslySaved);
    expect(document.querySelectorAll("[role='dialog']")).toHaveLength(1);
    const errorModal = document.querySelector(".ss-upgrade-plan-modal");
    expect(errorModal?.textContent).toContain("Sign-in didn't finish");
    expect(errorModal?.textContent).toContain("Sign-in is temporarily unavailable");
    expect(errorModal?.textContent).not.toContain("Signed in as");
    expect(button("upgrade-plan.retry").textContent).toContain("Start sign-in again");
    expect(plugin!.getAccountConnectService().hasPendingRequest()).toBe(false);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(1);

    // Failed persistence still leaves the email in the settings draft. A late
    // browser callback must adopt the failed completion, not infer success.
    expect(plugin!.settings.userEmail).toBe(CONNECTED_ACCOUNT.account.email);
    connectCallback!({
      action: "systemsculpt-connect",
      state: firstConnect.searchParams.get("state")!,
      code: "already-consumed-test-code",
    });
    await jest.advanceTimersByTimeAsync(0);
    const lateModal = document.querySelector(".ss-upgrade-plan-modal");
    expect(lateModal).toBe(errorModal);
    expect(document.querySelectorAll("[role='dialog']")).toHaveLength(1);
    expect(lateModal?.textContent).toContain("Sign-in didn't finish");
    expect(lateModal?.textContent).toContain("Sign-in is temporarily unavailable");
    expect(lateModal?.textContent).not.toContain("Signed in as");
    expect(await plugin!.loadData()).toEqual(previouslySaved);
    expect(request).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    const retry = button("upgrade-plan.retry");
    expect(retry.textContent).toContain("Start sign-in again");
    expect(retry.disabled).toBe(false);

    retry.click();
    await jest.advanceTimersByTimeAsync(0);
    expect(lateModal!.isConnected).toBe(true);
    expect(lateModal?.textContent).toContain("Waiting for you to finish in the browser");
    expect(openedUrls).toHaveLength(2);
    const secondSignIn = new URL(openedUrls[1]);
    expect(secondSignIn.pathname).toBe("/sign-in");
    const secondConnect = new URL(secondSignIn.searchParams.get("redirect_url")!, secondSignIn.origin);
    expect(secondConnect.searchParams.get("state")).not.toBe(firstConnect.searchParams.get("state"));
    expect(secondConnect.searchParams.get("challenge")).not.toBe(firstConnect.searchParams.get("challenge"));
    expect(plugin!.getAccountConnectService().hasPendingRequest()).toBe(true);

    await jest.advanceTimersByTimeAsync(3_500);
    expectSignedInPlanChoice();
    expect(save).toHaveBeenCalledTimes(2);
    expect(await plugin!.loadData()).toMatchObject({ userEmail: CONNECTED_ACCOUNT.account.email });
    expect(request).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
