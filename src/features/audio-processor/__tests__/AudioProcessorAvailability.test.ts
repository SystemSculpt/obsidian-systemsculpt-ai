import { getVideoGenerationAvailability } from "../../../services/videos/VideoGenerationAvailability";
import {
  PlatformRequestClient,
  type PlatformRequestInput,
} from "../../../services/PlatformRequestClient";
import {
  canOpenAudioProcessor,
  getAudioProcessorAvailability,
} from "../AudioProcessorAvailability";

class QueueClient extends PlatformRequestClient {
  readonly inputs: PlatformRequestInput[] = [];
  readonly responses: Array<Response | Promise<Response>> = [];

  override async request(input: PlatformRequestInput): Promise<Response> {
    this.inputs.push(input);
    const response = this.responses.shift();
    if (!response) throw new Error("Missing queued response.");
    return response;
  }
}

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), {
  status,
  headers: { "Content-Type": "application/json" },
});

function createPlugin() {
  return {
    manifest: { version: "6.1.0" },
    settings: { licenseKey: "license-123" },
  } as any;
}

describe("AudioProcessorAvailability", () => {
  it("blocks only when plugin config v1 explicitly disables the hosted audio processor", async () => {
    const requestClient = new QueueClient();
    requestClient.responses.push(json({
      contract: "systemsculpt-plugin-config-v1",
      capabilities: { hosted_audio_processor: false },
    }));

    await expect(getAudioProcessorAvailability(createPlugin(), {
      baseUrl: "https://systemsculpt.test/api/plugin/",
      requestClient,
    })).resolves.toEqual({ canOpen: false, authoritative: true });

    expect(requestClient.inputs[0]).toEqual(expect.objectContaining({
      url: "https://systemsculpt.test/api/plugin/config",
      method: "GET",
      licenseKey: "license-123",
      // The request client adds the license header from licenseKey.
      headers: expect.objectContaining({
        "x-plugin-version": "6.1.0",
      }),
    }));
  });

  it("allows authoritative true and treats a valid catalogue without the capability as unavailable", async () => {
    const requestClient = new QueueClient();
    requestClient.responses.push(json({
      contract: "systemsculpt-plugin-config-v1",
      capabilities: { hosted_audio_processor: true },
    }));
    requestClient.responses.push(json({
      contract: "systemsculpt-plugin-config-v1",
      capabilities: { hosted_chat: true },
    }));

    await expect(getAudioProcessorAvailability(createPlugin(), {
      requestClient,
      baseUrl: "https://systemsculpt.test/api/plugin",
    })).resolves.toEqual({ canOpen: true, authoritative: true });

    await expect(getAudioProcessorAvailability(createPlugin(), {
      requestClient,
      baseUrl: "https://systemsculpt.test/api/plugin",
    })).resolves.toEqual({ canOpen: false, authoritative: true });
  });

  it("fails open for older or unavailable servers instead of blocking the modal", async () => {
    const requestClient = new QueueClient();
    requestClient.responses.push(json({
      contract: "some-other-contract",
      capabilities: { hosted_audio_processor: false },
    }));
    requestClient.responses.push(new Response("unavailable", { status: 503 }));
    requestClient.responses.push(new Response("{", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await expect(canOpenAudioProcessor(createPlugin(), {
      requestClient,
      baseUrl: "https://systemsculpt.test/api/plugin",
    })).resolves.toBe(true);
    await expect(canOpenAudioProcessor(createPlugin(), {
      requestClient,
      baseUrl: "https://systemsculpt.test/api/plugin",
      now: () => 5 * 60_000 + 1,
    })).resolves.toBe(true);
    await expect(canOpenAudioProcessor(createPlugin(), {
      requestClient,
      baseUrl: "https://systemsculpt.test/api/plugin",
      now: () => 10 * 60_000 + 2,
    })).resolves.toBe(true);
  });

  it("caches the last decision for five minutes to avoid repeated config probes", async () => {
    const plugin = createPlugin();
    const requestClient = new QueueClient();
    let currentTime = 1_000;

    requestClient.responses.push(json({
      contract: "systemsculpt-plugin-config-v1",
      capabilities: { hosted_audio_processor: false },
    }));
    requestClient.responses.push(json({
      contract: "systemsculpt-plugin-config-v1",
      capabilities: { hosted_audio_processor: true },
    }));

    await expect(canOpenAudioProcessor(plugin, {
      requestClient,
      baseUrl: "https://systemsculpt.test/api/plugin",
      now: () => currentTime,
    })).resolves.toBe(false);
    await expect(canOpenAudioProcessor(plugin, {
      requestClient,
      baseUrl: "https://systemsculpt.test/api/plugin",
      now: () => currentTime + (5 * 60_000) - 1,
    })).resolves.toBe(false);
    expect(requestClient.inputs).toHaveLength(1);

    currentTime += (5 * 60_000) + 1;
    await expect(canOpenAudioProcessor(plugin, {
      requestClient,
      baseUrl: "https://systemsculpt.test/api/plugin",
      now: () => currentTime,
    })).resolves.toBe(true);
    expect(requestClient.inputs).toHaveLength(2);
  });
  it("reads /config through the plugin's managed transport by default", async () => {
    const getPluginConfigCapabilities = jest.fn(async () => ({ hosted_audio_processor: true, hosted_videos: false }));
    const plugin = {
      ...createPlugin(),
      getManagedCapabilityGraph: () => ({ transport: { getPluginConfigCapabilities } }),
    };
    const controller = new AbortController();

    await expect(getAudioProcessorAvailability(plugin, { now: () => 1_000 }, controller.signal))
      .resolves.toEqual({ canOpen: true, authoritative: true });
    await expect(getVideoGenerationAvailability(plugin, { now: () => 1_000 }))
      .resolves.toEqual({ canOpen: false, authoritative: true });
    expect(getPluginConfigCapabilities).toHaveBeenCalledTimes(1);
    expect(getPluginConfigCapabilities).toHaveBeenCalledWith(controller.signal);
  });

  it("shares the catalogue across public audio and video entry points", async () => {
    const plugin = createPlugin();
    const requestClient = new QueueClient();
    requestClient.responses.push(json({
      contract: "systemsculpt-plugin-config-v1",
      capabilities: { hosted_audio_processor: true, hosted_videos: false },
    }));
    const options = { requestClient, baseUrl: "https://systemsculpt.test/api/plugin" };
    await expect(getAudioProcessorAvailability(plugin, options)).resolves.toEqual({ canOpen: true, authoritative: true });
    await expect(getVideoGenerationAvailability(plugin, options)).resolves.toEqual({ canOpen: false, authoritative: true });
    expect(requestClient.inputs).toHaveLength(1);
  });

  it.each(["license", "version", "baseUrl"])("invalidates cached config when %s changes", async (field) => {
    const plugin = createPlugin();
    const requestClient = new QueueClient();
    for (const enabled of [false, true]) {
      requestClient.responses.push(json({
        contract: "systemsculpt-plugin-config-v1",
        capabilities: { hosted_audio_processor: enabled },
      }));
    }
    const options = { requestClient, baseUrl: "https://systemsculpt.test/api/plugin", now: () => 1_000 };
    await expect(canOpenAudioProcessor(plugin, options)).resolves.toBe(false);
    if (field === "license") plugin.settings.licenseKey = "new-account";
    if (field === "version") plugin.manifest.version = "6.2.0";
    if (field === "baseUrl") options.baseUrl = "https://systemsculpt.test/new-api";
    await expect(canOpenAudioProcessor(plugin, options)).resolves.toBe(true);
    expect(requestClient.inputs).toHaveLength(2);
  });

  it("does not let an aborted probe poison another surface's cache", async () => {
    const plugin = createPlugin();
    const requestClient = new QueueClient();
    requestClient.responses.push(json({
      contract: "systemsculpt-plugin-config-v1",
      capabilities: { hosted_videos: false },
    }));
    const controller = new AbortController();
    controller.abort();
    await expect(getAudioProcessorAvailability(plugin, { requestClient }, controller.signal))
      .resolves.toEqual({ canOpen: true, authoritative: false });
    await expect(getVideoGenerationAvailability(plugin, { requestClient }))
      .resolves.toEqual({ canOpen: false, authoritative: true });
    expect(requestClient.inputs).toHaveLength(1);
  });

  it("keeps a new account's cached config when an older account probe finishes late", async () => {
    const plugin = createPlugin();
    const requestClient = new QueueClient();
    let finishOld!: (response: Response) => void;
    requestClient.responses.push(new Promise((resolve) => { finishOld = resolve; }));
    requestClient.responses.push(json({
      contract: "systemsculpt-plugin-config-v1",
      capabilities: { hosted_audio_processor: false },
    }));
    const options = { requestClient, now: () => 1_000 };
    const oldProbe = getAudioProcessorAvailability(plugin, options);
    plugin.settings.licenseKey = "new-account";
    await expect(canOpenAudioProcessor(plugin, options)).resolves.toBe(false);
    finishOld(json({
      contract: "systemsculpt-plugin-config-v1",
      capabilities: { hosted_audio_processor: true },
    }));
    await oldProbe;
    await expect(canOpenAudioProcessor(plugin, options)).resolves.toBe(false);
    expect(requestClient.inputs.map((input) => input.licenseKey)).toEqual(["license-123", "new-account"]);
  });

  it("a cache hit supersedes an older pending account probe", async () => {
    const plugin = createPlugin();
    const requestClient = new QueueClient();
    requestClient.responses.push(json({
      contract: "systemsculpt-plugin-config-v1", capabilities: { hosted_audio_processor: false },
    }));
    const options = { requestClient, now: () => 1_000 };
    await expect(canOpenAudioProcessor(plugin, options)).resolves.toBe(false);
    plugin.settings.licenseKey = "temporary-account";
    let finishOther!: (response: Response) => void;
    requestClient.responses.push(new Promise((resolve) => { finishOther = resolve; }));
    const otherProbe = getAudioProcessorAvailability(plugin, options);
    plugin.settings.licenseKey = "license-123";
    await expect(canOpenAudioProcessor(plugin, options)).resolves.toBe(false);
    finishOther(json({ contract: "systemsculpt-plugin-config-v1", capabilities: { hosted_audio_processor: true } }));
    await otherProbe;
    await expect(canOpenAudioProcessor(plugin, options)).resolves.toBe(false);
    expect(requestClient.inputs).toHaveLength(2);
  });

});
