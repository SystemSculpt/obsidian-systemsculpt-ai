import { registerBuiltInStudioNodes } from "../StudioBuiltInNodes";
import {
  getUnknownNodeConfigKeys,
  mergeNodeConfigWithDefaults,
  rebuildConfigWithUnknownKeys,
  validateNodeConfig,
} from "../StudioNodeConfigValidation";
import { StudioNodeRegistry } from "../StudioNodeRegistry";

function registryWithBuiltIns(): StudioNodeRegistry {
  const registry = new StudioNodeRegistry();
  registerBuiltInStudioNodes(registry);
  return registry;
}

describe("Studio node config validation", () => {
  it("flags required CLI fields when missing", () => {
    const registry = registryWithBuiltIns();
    const definition = registry.get("studio.cli_command", "1.0.0");
    expect(definition).not.toBeNull();

    const result = validateNodeConfig(definition!, {
      command: "",
      cwd: "",
      timeoutMs: 30_000,
      maxOutputBytes: 256 * 1024,
    });

    expect(result.isValid).toBe(false);
    expect(result.errors.some((error) => error.fieldKey === "command")).toBe(true);
    expect(result.errors.some((error) => error.fieldKey === "cwd")).toBe(true);
  });

  it("passes valid CLI config values", () => {
    const registry = registryWithBuiltIns();
    const definition = registry.get("studio.cli_command", "1.0.0");
    expect(definition).not.toBeNull();

    const result = validateNodeConfig(definition!, {
      command: "echo",
      args: ["hello", "world"],
      cwd: "/",
      timeoutMs: 1_000,
      maxOutputBytes: 8_192,
    });

    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects invalid select options", () => {
    const registry = registryWithBuiltIns();
    const definition = registry.get("studio.http_request", "1.0.0");
    expect(definition).not.toBeNull();

    const result = validateNodeConfig(definition!, {
      method: "INVALID",
      url: "https://api.systemsculpt.com",
      headers: {},
    });

    expect(result.isValid).toBe(false);
    expect(result.errors.some((error) => error.fieldKey === "method")).toBe(true);
  });

  it("rejects invalid image-generation aspect-ratio values", () => {
    const registry = registryWithBuiltIns();
    const definition = registry.get("studio.image_generation", "1.0.0");
    expect(definition).not.toBeNull();

    const result = validateNodeConfig(definition!, {
      count: 1,
      aspectRatio: "bad-ratio",
    });

    expect(result.isValid).toBe(false);
    expect(result.errors.some((error) => error.fieldKey === "aspectRatio")).toBe(true);
  });

  it("accepts legacy provider key as unknown config key during validation", () => {
    const registry = registryWithBuiltIns();
    const definition = registry.get("studio.image_generation", "1.0.0");
    expect(definition).not.toBeNull();

    const result = validateNodeConfig(definition!, {
      provider: "legacy-provider",
      count: 1,
      aspectRatio: "16:9",
    });

    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("preserves unknown keys while rebuilding config", () => {
    const registry = registryWithBuiltIns();
    const definition = registry.get("studio.text_generation", "1.0.0");
    expect(definition).not.toBeNull();

    const baseConfig = {
      modelId: "openai/gpt-5-mini",
      custom_internal_key: "keep-me",
    };

    const merged = mergeNodeConfigWithDefaults(definition!, baseConfig);
    expect(merged.modelId).toBe("openai/gpt-5-mini");

    const unknown = getUnknownNodeConfigKeys(definition!, baseConfig);
    expect(unknown.custom_internal_key).toBe("keep-me");

    const rebuilt = rebuildConfigWithUnknownKeys(definition!, baseConfig, {
      custom_internal_key: "still-here",
      next_unknown: 42,
    });

    expect(rebuilt.modelId).toBe("openai/gpt-5-mini");
    expect(rebuilt.custom_internal_key).toBe("still-here");
    expect(rebuilt.next_unknown).toBe(42);
  });

  it("validates media ingest source path field types", () => {
    const registry = registryWithBuiltIns();
    const definition = registry.get("studio.media_ingest", "1.0.0");
    expect(definition).not.toBeNull();

    const invalid = validateNodeConfig(definition!, {
      sourcePath: "",
    });
    expect(invalid.isValid).toBe(false);
    expect(invalid.errors.some((error) => error.fieldKey === "sourcePath")).toBe(true);

    const valid = validateNodeConfig(definition!, {
      sourcePath: "/media/video.mp4",
    });
    expect(valid.isValid).toBe(true);
  });

  it("accepts optional audio extract output path config", () => {
    const registry = registryWithBuiltIns();
    const definition = registry.get("studio.audio_extract", "1.0.0");
    expect(definition).not.toBeNull();

    const withDefaultPath = validateNodeConfig(definition!, {
      ffmpegCommand: "ffmpeg",
      outputFormat: "wav",
      timeoutMs: 120_000,
      maxOutputBytes: 512 * 1024,
    });
    expect(withDefaultPath.isValid).toBe(true);

    const withCustomPath = validateNodeConfig(definition!, {
      ffmpegCommand: "ffmpeg",
      outputFormat: "mp3",
      outputPath: "/outputs/audio/output-name.mp3",
      timeoutMs: 120_000,
      maxOutputBytes: 512 * 1024,
    });
    expect(withCustomPath.isValid).toBe(true);
  });

  it("flags required dataset node fields when missing", () => {
    const registry = registryWithBuiltIns();
    const definition = registry.get("studio.dataset", "1.0.0");
    expect(definition).not.toBeNull();

    const result = validateNodeConfig(definition!, {
      workingDirectory: "",
      customQuery: "",
      refreshHours: 6,
      timeoutMs: 60_000,
      maxOutputBytes: 512 * 1024,
    });

    expect(result.isValid).toBe(false);
    expect(result.errors.some((error) => error.fieldKey === "workingDirectory")).toBe(true);
    expect(result.errors.some((error) => error.fieldKey === "customQuery")).toBe(true);
  });

  it("passes valid custom-query dataset config values", () => {
    const registry = registryWithBuiltIns();
    const definition = registry.get("studio.dataset", "1.0.0");
    expect(definition).not.toBeNull();

    const result = validateNodeConfig(definition!, {
      workingDirectory: "/workspace/adapter-project",
      customQuery: "SELECT 1;",
      adapterCommand: "node",
      adapterArgs: ["scripts/db-query.js", "{{query}}"],
      refreshHours: 6,
      timeoutMs: 60_000,
      maxOutputBytes: 512 * 1024,
    });

    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("flags dataset adapter command when explicitly blank", () => {
    const registry = registryWithBuiltIns();
    const definition = registry.get("studio.dataset", "1.0.0");
    expect(definition).not.toBeNull();

    const result = validateNodeConfig(definition!, {
      workingDirectory: "/workspace/adapter-project",
      customQuery: "SELECT 1;",
      adapterCommand: "",
      refreshHours: 6,
      timeoutMs: 60_000,
      maxOutputBytes: 512 * 1024,
    });

    expect(result.isValid).toBe(false);
    expect(result.errors.some((error) => error.fieldKey === "adapterCommand")).toBe(true);
  });

  it("requires a Pi model id for text generation nodes", () => {
    const registry = registryWithBuiltIns();
    const definition = registry.get("studio.text_generation", "1.0.0");
    expect(definition).not.toBeNull();

    const missingModel = validateNodeConfig(definition!, {
      systemPrompt: "You are local",
      modelId: "",
    });
    expect(missingModel.isValid).toBe(false);
    expect(missingModel.errors.some((error) => error.fieldKey === "modelId")).toBe(true);

    const validModel = validateNodeConfig(definition!, {
      modelId: "openai@@gpt-5-mini",
    });
    expect(validModel.isValid).toBe(true);
  });

  it("passes valid HTTP API config", () => {
    const registry = registryWithBuiltIns();
    const definition = registry.get("studio.http_request", "1.0.0");
    expect(definition).not.toBeNull();

    const result = validateNodeConfig(definition!, {
      method: "POST",
      url: "https://api.resend.com/contacts",
      bearerToken: "re_test_123",
      bodyMode: "auto",
      body: {
        email: "first@example.com",
      },
      maxRetries: 3,
    });

    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts note selector items with path and optional enabled", () => {
    const registry = registryWithBuiltIns();
    const definition = registry.get("studio.note", "1.0.0");
    expect(definition).not.toBeNull();

    const result = validateNodeConfig(definition!, {
      notes: {
        items: [
          { path: "Inbox/Launch Plan.md", enabled: true },
          { path: "Inbox/Offer.md" },
        ],
      },
    });

    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects note selector entries with blank paths", () => {
    const registry = registryWithBuiltIns();
    const definition = registry.get("studio.note", "1.0.0");
    expect(definition).not.toBeNull();

    const result = validateNodeConfig(definition!, {
      notes: {
        items: [{ path: "", enabled: true }],
      },
    });

    expect(result.isValid).toBe(false);
    expect(result.errors.some((error) => error.message.includes("non-empty path"))).toBe(true);
  });

  it("rejects out-of-range HTTP retry values", () => {
    const registry = registryWithBuiltIns();
    const definition = registry.get("studio.http_request", "1.0.0");
    expect(definition).not.toBeNull();

    const result = validateNodeConfig(definition!, {
      method: "POST",
      url: "https://api.resend.com/contacts",
      maxRetries: -1,
    });

    expect(result.isValid).toBe(false);
    expect(result.errors.some((error) => error.fieldKey === "maxRetries")).toBe(true);
  });

  it("rejects invalid HTTP body mode values", () => {
    const registry = registryWithBuiltIns();
    const definition = registry.get("studio.http_request", "1.0.0");
    expect(definition).not.toBeNull();

    const result = validateNodeConfig(definition!, {
      method: "POST",
      url: "https://api.resend.com/contacts",
      bodyMode: "xml",
      maxRetries: 0,
    });

    expect(result.isValid).toBe(false);
    expect(result.errors.some((error) => error.fieldKey === "bodyMode")).toBe(true);
  });
});
