import type SystemSculptPlugin from "../../main";
import { AudioProcessorDeviceStaging } from "../../features/audio-processor/AudioProcessorDeviceStaging";
import { ManagedDocumentLocalStaging } from "../managed/ManagedDocumentLocalStaging";

const implementations = [
  { name: "audio", create: (plugin: SystemSculptPlugin) => new AudioProcessorDeviceStaging(plugin), errorName: "AudioProcessorDeviceStagingError" },
  { name: "document", create: (plugin: SystemSculptPlugin) => new ManagedDocumentLocalStaging(plugin), errorName: "ManagedDocumentLocalStagingError" },
];

function installedPlugin(configDir: unknown, dir: unknown): SystemSculptPlugin {
  return {
    app: { vault: { configDir, adapter: {} } },
    manifest: { id: "systemsculpt-ai", dir },
  } as unknown as SystemSculptPlugin;
}

describe.each(implementations)("$name staging directory validation", ({ name, create, errorName }) => {
  it.each([
    [".obsidian", undefined],
    ["./.obsidian/", ".\\.obsidian\\plugins\\systemsculpt-ai\\"],
    [".obsidian///", ".obsidian/plugins/systemsculpt-ai///"],
    [" config ", " config /plugins/systemsculpt-ai"],
    ["café config", "café config/plugins/systemsculpt-ai"],
  ])("accepts equivalent installed paths %j and %j", (config, directory) => {
    expect(() => create(installedPlugin(config, directory))).not.toThrow();
  });

  it.each(["", "/.obsidian", "\\.obsidian", "././.obsidian", ".obsidian//child", ".obsidian/../other", ".obsidian/./child", null, 42])(
    "keeps the domain error for invalid config directory %j",
    (config) => {
      expect(() => create(installedPlugin(config, undefined))).toThrow(expect.objectContaining({
        name: errorName,
        code: "invalid_staging_request",
        message: `Invalid ${name} staging request.`,
      }));
    },
  );

  it.each(["/.obsidian/plugins/systemsculpt-ai", ".obsidian//plugins/systemsculpt-ai", ".obsidian/plugins/../systemsculpt-ai"])(
    "does not repair an invalid manifest directory %j into an accepted one",
    (directory) => {
      expect(() => create(installedPlugin(".obsidian", directory))).toThrow(expect.objectContaining({
        code: "invalid_staging_request",
        message: `Invalid ${name} staging request.`,
      }));
    },
  );

  it("keeps the installed-root mismatch error", () => {
    expect(() => create(installedPlugin(".obsidian", "other/plugins/systemsculpt-ai"))).toThrow(
      "Plugin manifest directory does not match the installed plugin location.",
    );
  });
});
