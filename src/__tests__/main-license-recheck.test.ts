/** @jest-environment jsdom */

import { App } from "obsidian";
import SystemSculptPlugin from "../main";
import { PlatformRequestClient } from "../services/PlatformRequestClient";
import { SystemSculptService } from "../services/SystemSculptService";
import { DEFAULT_SETTINGS } from "../types";

function jsonResponse(status: number, body: unknown): Response {
  const response = new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  // The jsdom test Response has no clone(); managed reads clone error bodies.
  return Object.assign(response, { clone: () => jsonResponse(status, body) });
}

function createPlugin() {
  const plugin = new SystemSculptPlugin(new App(), { id: "systemsculpt", version: "1.0.0" } as any);
  plugin._internal_settings_systemsculpt_plugin = { ...DEFAULT_SETTINGS, licenseKey: "license_old", licenseValid: true };
  const recheckAfterRejection = jest.fn(async () => undefined);
  (plugin as any).licenseManager = { recheckAfterRejection };
  return { plugin, recheckAfterRejection };
}

describe("SystemSculptPlugin license re-check", () => {
  let request: jest.SpiedFunction<PlatformRequestClient["request"]>;

  beforeEach(() => {
    request = jest.spyOn(PlatformRequestClient.prototype, "request");
  });
  afterEach(() => {
    request.mockRestore();
    SystemSculptService.clearInstance();
  });

  it("re-checks the license when a managed request is refused", async () => {
    const { plugin, recheckAfterRejection } = createPlugin();
    request.mockImplementation(async () => jsonResponse(401, { error: "Invalid license key", code: "license_invalid" }));

    await plugin.getManagedCapabilityGraph().transport.request({ path: "/api/plugin/images/models", method: "GET" });

    expect(recheckAfterRejection).toHaveBeenCalledTimes(1);
  });

  it("re-checks the license when managed work finds the key refused", async () => {
    const { plugin, recheckAfterRejection } = createPlugin();
    request.mockImplementation(async () => jsonResponse(403, {
      contract_version: "admission-v1",
      code: "license_rejected",
      reason: "invalid",
      message: "License rejected.",
      request_id: "request-1",
    }));

    await expect(plugin.getManagedCapabilityGraph().admission.checkLicense())
      .resolves.toMatchObject({ outcome: "license_rejected", reason: "invalid" });

    expect(recheckAfterRejection).toHaveBeenCalledTimes(1);
  });

  it("re-checks the license when a credits read is refused", async () => {
    const { plugin, recheckAfterRejection } = createPlugin();
    request.mockImplementation(async () => jsonResponse(401, { error: "Invalid license key", code: "license_invalid" }));

    await expect(plugin.aiService.credits.readBalance({ fresh: true })).rejects.toBeDefined();

    expect(recheckAfterRejection).toHaveBeenCalledTimes(1);
  });

  it("does nothing before the license manager exists", () => {
    const { plugin } = createPlugin();
    (plugin as any).licenseManager = undefined;

    expect(() => plugin.recheckLicenseAfterRejection()).not.toThrow();
  });
});
