import { getPluginCapabilityAvailability } from "../PluginCapabilityAvailability";

function createPlugin(settings: Record<string, unknown> = { licenseKey: "license-a" }, version: unknown = "6.18.7") {
  const getPluginConfigCapabilities = jest.fn(async () => ({ hosted_audio_processor: false, hosted_videos: true }));
  const plugin = {
    settings,
    manifest: { version },
    getManagedCapabilityGraph: () => ({ transport: { getPluginConfigCapabilities } }),
  };
  return { plugin: plugin as never, getPluginConfigCapabilities };
}

describe("plugin capability account boundaries", () => {
  it.each([{}, { licenseKey: "" }, { licenseKey: " \t " }, { licenseKey: 42 }])(
    "does not send account config requests without a usable license (%j)", async (settings) => {
      const { plugin, getPluginConfigCapabilities } = createPlugin(settings);
      await expect(getPluginCapabilityAvailability(plugin, "hosted_audio_processor"))
        .resolves.toEqual({ canOpen: true, authoritative: false });
      expect(getPluginConfigCapabilities).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "", "  ", 42])("does not probe an unknown plugin version (%j)", async (version) => {
    const { plugin, getPluginConfigCapabilities } = createPlugin({ licenseKey: "license-a" }, "");
    (plugin as unknown as { manifest: { version: unknown } }).manifest.version = version;
    await expect(getPluginCapabilityAvailability(plugin, "hosted_videos"))
      .resolves.toEqual({ canOpen: true, authoritative: false });
    expect(getPluginConfigCapabilities).not.toHaveBeenCalled();
  });

  it("shares the plugin's transport and invalidates the decision when the saved license changes", async () => {
    const settings = { licenseKey: " license-a " };
    const { plugin, getPluginConfigCapabilities } = createPlugin(settings);
    getPluginConfigCapabilities.mockResolvedValueOnce({ hosted_audio_processor: false, hosted_videos: true });
    await expect(getPluginCapabilityAvailability(plugin, "hosted_audio_processor"))
      .resolves.toEqual({ canOpen: false, authoritative: true });
    await expect(getPluginCapabilityAvailability(plugin, "hosted_videos"))
      .resolves.toEqual({ canOpen: true, authoritative: true });
    expect(getPluginConfigCapabilities).toHaveBeenCalledTimes(1);

    settings.licenseKey = "license-b";
    getPluginConfigCapabilities.mockResolvedValueOnce({ hosted_audio_processor: true, hosted_videos: false });
    await expect(getPluginCapabilityAvailability(plugin, "hosted_audio_processor"))
      .resolves.toEqual({ canOpen: true, authoritative: true });
    expect(getPluginConfigCapabilities).toHaveBeenCalledTimes(2);
  });
});
