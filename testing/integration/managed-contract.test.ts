import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";

const fixtureRoot = join(process.cwd(), "testing", "fixtures");
const managedRoot = join(fixtureRoot, "managed");
const settingsRoot = join(fixtureRoot, "settings");

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function managedFixture(name: string): any {
  return readJson(join(managedRoot, name));
}

const canonicalHashes: Record<string, string> = {
  "admission-v1.json": "fc9938f0c6d6584815b1a59813cad2649554eadda0455fd789f604877fa01fcd",
  "managed-capabilities-v2.schema.json": "79c8f10d0cd00479573dc4b119347d5f99884bb368f460b82746db6f92d40b2d",
  "managed-capabilities-v2.json": "92cf74114b087016d699242b926a5e2c7b7d258b0f048ceafe036917219c6a09",
};

const forbiddenSettingsKey = /(provider|model|endpoint|api.?key|oauth|pi(auth|session)?|session|fallback|readwise|mcpservers|catalog|licensevalid|lastvalidated|serverurl)/i;

function walkKeys(value: unknown, path: string[] = []): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((entry, index) => walkKeys(entry, [...path, String(index)]));
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    [...path, key].join("."),
    ...walkKeys(child, [...path, key]),
  ]);
}

describe("managed product contract fixtures", () => {
  it.each(Object.entries(canonicalHashes))("keeps %s byte-identical to the immutable website artifact", (name, hash) => {
    const bytes = readFileSync(join(managedRoot, name));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
  });

  it("describes the exact admission-v1 server outcomes without client-composed states", () => {
    const admission = managedFixture("admission-v1.json");
    expect(admission.contract_version).toBe("admission-v1");
    expect(Object.keys(admission.responses)).toEqual([
      "allowed",
      "license_required",
      "license_rejected",
      "temporarily_unavailable",
      "rate_limited",
    ]);
    expect(admission.responses.rate_limited.status).toBe(429);
    expect(admission.conditional_response_headers["Retry-After"]).toEqual([
      "rate_limited",
      "temporarily_unavailable",
    ]);
    expect(admission.responses).not.toHaveProperty("disclosure_required");
    expect(admission.responses).not.toHaveProperty("capability_unavailable");
  });

  it("publishes five first-party descriptors and preserves all descriptor fields", () => {
    const contract = managedFixture("managed-capabilities-v2.json");
    expect(contract.contract_version).toBe("managed-capabilities-v2");
    expect(contract.disclosure_version).toBeNull();
    expect(contract.capabilities.map((entry: any) => entry.alias)).toEqual([
      "systemsculpt/chat",
      "systemsculpt/embeddings",
      "systemsculpt/transcription",
      "systemsculpt/documents",
      "systemsculpt/images",
    ]);
    for (const descriptor of contract.capabilities) {
      expect(Object.keys(descriptor).sort()).toEqual([
        "alias", "auth", "availability", "background_eligible", "cancellation_supported",
        "endpoint", "limits", "metering", "mode", "request_contracts",
      ].sort());
      expect(descriptor.auth).toBe("license");
      expect(descriptor.alias).toMatch(/^systemsculpt\//);
      expect(descriptor.endpoint).toMatch(/^\/api\//);
    }
  });

  it("keeps three nested request contracts instead of flattening them", () => {
    const contract = managedFixture("managed-capabilities-v2.json");
    const chat = contract.capabilities[0];
    const embeddings = contract.capabilities[1];
    expect(chat.request_contracts.map((entry: any) => entry.capability)).toEqual(["chat_turn", "text_generation"]);
    expect(chat.request_contracts[0].purpose).toEqual({ presence: "forbidden", values: [] });
    expect(chat.request_contracts[1].purpose).toEqual({
      presence: "required",
      values: ["transcript_postprocess", "workflow_automation"],
    });
    expect(embeddings.request_contracts).toHaveLength(1);
    const request = embeddings.request_contracts[0];
    expect(request.capability).toBe("embeddings");
    expect(request.request.required_headers).toContain("idempotency-key");
    expect(request.request.body).toEqual({ input: "string|string[]", additional_properties: false });
    expect(request.response.index_schema_version).toBe(1);
    expect(request.response.index_namespace).toBe("systemsculpt:managed:v1:<dimensions>");
    expect(contract.capabilities).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ alias: "chat_turn" }),
      expect.objectContaining({ alias: "text_generation" }),
      expect.objectContaining({ alias: "embeddings" }),
    ]));
  });

  it("locks the exact chat_turn request, SSE, terminal-failure, and HTTP error contract", () => {
    const contract = managedFixture("managed-capabilities-v2.json");
    const chatTurn = contract.capabilities[0].request_contracts[0];

    expect(chatTurn.cancellation_supported).toBe(false);
    expect(chatTurn.request).toEqual(expect.objectContaining({
      method: "POST",
      path: "/api/v1/chat/completions",
      required_headers: [
        "x-license-key", "x-plugin-version", "x-systemsculpt-contract",
        "x-systemsculpt-capability", "idempotency-key",
      ],
    }));
    expect(chatTurn.request.body).toEqual({
      schema: "managed_chat_request_v1",
      required_fields: ["model", "messages", "stream"],
      optional_fields: ["tools", "tool_choice"],
      additional_properties: false,
      model: "ai-agent",
      stream: true,
      messages: "managed_chat_messages_v1",
      tools: "managed_chat_tools_v1",
      tool_choice: ["auto", "none", "required"],
    });

    const messages = chatTurn.request.definitions.managed_chat_messages_v1;
    expect(Object.keys(messages.roles)).toEqual(["system", "developer", "user", "assistant", "tool"]);
    expect(messages.roles.assistant.at_least_one).toEqual(["content", "reasoning_content", "tool_calls"]);
    expect(messages.user_content_blocks.image_url.image_url.url).toBe("data_url");
    expect(messages.user_content_blocks.input_image.image_url).toBe("data_url");
    expect(messages.tool_calls.function.arguments).toEqual({
      wire_type: "string", encoding: "json", decoded_type: "non_array_object",
    });
    expect(chatTurn.request.definitions.managed_chat_tools_v1.item.function.parameters).toBe("json_schema_object");

    expect(chatTurn.response).toEqual(expect.objectContaining({
      status: 200,
      content_type: "text/event-stream",
      request_id_header: "x-request-id",
      frame_delimiter: "\n\n",
      data_prefix: "data: ",
      json_frames: ["managed_chat_delta_v1", "managed_chat_error_v1"],
      successful_terminal_marker: "data: [DONE]\n\n",
      successful_terminal_marker_count: 1,
      cancellation_behavior: "client_abort_stops_waiting_server_work_may_continue",
    }));
    expect(chatTurn.response.definitions.managed_chat_delta_v1).toEqual({
      format: "openai_chat_completion_chunk",
      model_alias: "systemsculpt/ai-agent",
      allowed_delta_fields: ["role", "content", "reasoning_content", "tool_calls"],
      implementation_identity_forbidden: true,
    });
    expect(chatTurn.response.definitions.managed_chat_error_v1).toEqual({
      required_fields: ["error"],
      error_required_fields: ["code", "message"],
      bounded: true,
      implementation_identity_forbidden: true,
    });
    expect(chatTurn.response.terminal_failures).toEqual([
      { code: "malformed_frame", retry_same_idempotency_key: false },
      { code: "missing_terminal_marker", retry_same_idempotency_key: false },
      { code: "empty_successful_stream", retry_same_idempotency_key: false },
      { code: "in_stream_error", retry_same_idempotency_key: false },
    ]);
    expect(chatTurn.errors).toEqual({
      statuses: [400, 401, 403, 402, 409, 426, 429, 502, 503],
      conflict_codes: [
        "operation_in_progress", "operation_already_completed", "operation_terminal", "settlement_pending",
      ],
      bounded_first_party_messages: true,
    });
  });

  it("ships a schema that locks the descriptor and nested request-contract structure", () => {
    const schema = managedFixture("managed-capabilities-v2.schema.json");
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.properties.capabilities.minItems).toBe(5);
    expect(schema.properties.capabilities.maxItems).toBe(5);
    const descriptor = schema.properties.capabilities.items;
    expect(descriptor.required).toEqual(expect.arrayContaining([
      "alias", "endpoint", "mode", "availability", "auth", "metering",
      "cancellation_supported", "background_eligible", "limits", "request_contracts",
    ]));
    const requestContracts = descriptor.properties.request_contracts.items.oneOf;
    expect(requestContracts).toHaveLength(3);
    expect(requestContracts.map((entry: any) => entry.properties.capability.const)).toEqual([
      "chat_turn", "text_generation", "embeddings",
    ]);
    expect(requestContracts[0].required).toEqual(expect.arrayContaining([
      "cancellation_supported", "request", "response", "errors",
    ]));
  });

  it("covers every deterministic managed lifecycle scenario", () => {
    const scenarios = managedFixture("scenarios.json");
    expect(scenarios.map((entry: any) => entry.id)).toEqual([
      "success", "authoritative_rejection", "transient_auth_unavailable", "rate_limited",
      "credits_exhausted", "capability_unavailable", "malformed_contract",
      "stream_cancellation", "malformed_stream_frame", "missing_stream_terminal_marker",
      "empty_successful_stream", "in_stream_error", "job_cancellation", "job_resume",
      "platform_unsupported", "contract_version_mismatch",
    ]);
    expect(new Set(scenarios.map((entry: any) => entry.expected))).toEqual(new Set([
      "allowed", "license_rejected", "temporarily_unavailable", "rate_limited",
      "credits_exhausted", "capability_unavailable", "malformed_contract",
      "cancelled", "malformed_frame", "missing_terminal_marker", "empty_successful_stream",
      "in_stream_error", "resumed", "platform_unsupported", "contract_version_mismatch",
    ]));
  });
});

describe("historical settings contract fixtures", () => {
  const inputs = [
    ["release-4-schema-v0", "4.0.0", "1020f95a241be990d94b3d6d0b7e500a04327564", 0],
    ["release-5.9.0-schema-v1", "5.9.0", "e97e8f98e6265bc0a965f24b36f954ac6e198209", 1],
    ["release-5.11-schema-v1", "5.11.0", "660e7feaf57eef322d0cc91accae3f903f73f7ce", 1],
  ] as const;

  it.each(inputs)("records truthful provenance for %s", (directory, release, commit, schema) => {
    const wrapper = readJson(join(settingsRoot, directory, "input.json"));
    expect(wrapper.source).toEqual({
      pluginRelease: release,
      commit,
      storedSchemaVersion: schema,
      inspectedWith: "git show",
      artifacts: expect.any(Array),
    });
    expect(wrapper.source.artifacts.length).toBeGreaterThan(0);
    if (schema === 0) expect(wrapper.settings).not.toHaveProperty("schemaVersion");
    else expect(wrapper.settings.schemaVersion).toBe(schema);
  });

  it.each(inputs)("uses only synthetic retired values in %s", (directory) => {
    const wrapper = readJson(join(settingsRoot, directory, "input.json"));
    const serialized = JSON.stringify(wrapper.settings);
    for (const url of serialized.match(/https?:[^\"\\]+/g) ?? []) expect(url).toBe("https://legacy.invalid");
    for (const key of serialized.match(/sentinel-[a-z-]+/g) ?? []) expect(key).toMatch(/^sentinel-/);
    expect(serialized.match(/legacy-(?:provider|model)/g) ?? []).not.toContain("production");
  });

  it("defines an explicit deterministic v6 managed-only output", () => {
    const expected = readJson(join(settingsRoot, "expected-v6-managed-settings.json"));
    expect(expected.schemaVersion).toBe(6);
    expect(expected.licenseKey).toBe("license-sentinel");
    expect(expected.managedMigrationState.phase).toBe("auth_cleanup_pending");
    const forbidden = walkKeys(expected).filter((path) => forbiddenSettingsKey.test(path.split(".").at(-1)!));
    expect(forbidden).toEqual([]);
    expect(expected).toEqual(expect.objectContaining({
      featureFlags: expect.any(Object), folders: expect.any(Object), exclusions: expect.any(Object),
      prompts: expect.any(Object), outputs: expect.any(Object), ui: expect.any(Object),
      workflows: expect.any(Object), studioGraph: expect.any(Object),
    }));
  });
});
