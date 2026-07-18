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
  readonly responses: Response[] = [];

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
      headers: expect.objectContaining({
        "x-license-key": "license-123",
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
});
