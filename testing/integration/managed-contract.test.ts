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
  "managed-capabilities-v2.schema.json": "b26a08c5298ba77d05706b627cd144c6e5feec2680fd86d29521fc0497863271",
  "managed-capabilities-v2.json": "0718fd290caca0c3da309f2c6fe501efc956c674900e533b18a3f907eac5c02c",
  "managed-image-output-v1.schema.json": "373a093908d1c00151e7b1505c7c84befe35d364d164bafa096da8601789581c",
  "managed-image-output-v1.json": "fda81d995879f64896eaaafafe98b6f1fb0d9334bbc889e3db80ed1cc50069af",
  "managed-job-protocol-v1.json": "91ec1771c44d5bb02cf6dd750f1bad4ea1d5fce29a1534c8a74d2370b7deb904",
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
      const expectedKeys = [
        "alias", "auth", "availability", "background_eligible", "cancellation_supported",
        "endpoint", "limits", "metering", "mode", "request_contracts",
      ];
      if (descriptor.alias === "systemsculpt/embeddings") expectedKeys.push("generation");
      expect(Object.keys(descriptor).sort()).toEqual(expectedKeys.sort());
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
    expect(embeddings.limits).toEqual({ max_texts: 128, max_chars_per_text: 8000, max_total_chars: 200000 });
    const generation = {
      id: "semantic-v1",
      index_schema_version: 2,
      index_namespace: "systemsculpt:managed:semantic-v1:v2:<dimensions>",
    };
    expect(embeddings.generation).toEqual(generation);
    expect(request.response.generation).toEqual(generation);
    expect(request.response.one_of).toEqual([
      {
        shape: "single",
        required_fields: ["embedding", "dimensions", "generation"],
        optional_fields: ["tokenCount"],
        forbidden_fields: ["embeddings"],
      },
      {
        shape: "batch",
        required_fields: ["embeddings", "dimensions", "generation"],
        optional_fields: ["tokenCount"],
        forbidden_fields: ["embedding"],
      },
    ]);
    expect(request.response).not.toHaveProperty("index_schema_version");
    expect(request.response).not.toHaveProperty("index_namespace");
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
      path: "/api/plugin/chat/completions",
      required_headers: [
        "x-license-key", "x-plugin-version", "x-systemsculpt-contract",
        "x-systemsculpt-capability", "idempotency-key",
      ],
    }));
    expect(chatTurn.request.body).toEqual({
      schema: "managed_chat_request_v1",
      required_fields: ["model", "messages", "stream"],
      optional_fields: ["tools", "tool_choice", "plugins", "session"],
      additional_properties: false,
      model: "ai-agent",
      stream: true,
      messages: "managed_chat_messages_v1",
      tools: "managed_chat_tools_v1",
      tool_choice: ["auto", "none", "required"],
      plugins: "managed_chat_plugins_v1",
      session: "managed_chat_session_v1",
    });

    const messages = chatTurn.request.definitions.managed_chat_messages_v1;
    expect(Object.keys(messages.roles)).toEqual(["user", "assistant", "tool"]);
    expect(messages.roles.assistant.optional_fields).toEqual([
      "content", "reasoning_summary", "tool_calls",
    ]);
    expect(messages.roles.assistant.reasoning_summary).toEqual({
      wire_type: "string", max_chars: 16000,
    });
    expect(messages.roles.assistant.at_least_one).toEqual(["content", "tool_calls"]);
    expect(messages.user_content_blocks.image_url.image_url.url).toBe("data_url");
    expect(messages.user_content_blocks.input_image.image_url).toBe("data_url");
    expect(messages.tool_calls.function.arguments).toEqual({
      wire_type: "string", encoding: "json", decoded_type: "non_array_object",
    });
    expect(chatTurn.request.definitions.managed_chat_tools_v1.item.function.parameters).toBe("json_schema_object");
    expect(chatTurn.request.definitions.managed_chat_plugins_v1).toEqual({
      type: "array",
      min_items: 1,
      max_items: 1,
      additional_properties: false,
      items: { required_fields: ["id"], optional_fields: [], id: ["web"] },
      scope: "active_agent_turn",
      tool_result_continuation: "server_inherit_or_exact_match",
      new_user_turn_behavior: "reset_unless_explicit",
    });
    expect(chatTurn.request.definitions.managed_chat_session_v1).toEqual({
      type: "object",
      one_of: [
        { shape: "create", required_fields: ["mode"], optional_fields: [], mode: "create" },
        {
          shape: "resume",
          required_fields: ["id", "revision"],
          optional_fields: [],
          id: "mchat_<32 lowercase hex>",
          revision: "nonnegative_integer",
        },
      ],
      absence_behavior: "full_history_compatibility",
      create_behavior: "full_history_snapshot_and_pin_tools",
      resume_behavior: "delta_user_or_tool_messages_only",
    });

    expect(chatTurn.response).toEqual(expect.objectContaining({
      status: 200,
      content_type: "text/event-stream",
      request_id_header: "x-request-id",
      session_id_header: "x-systemsculpt-session-id",
      session_revision_header: "x-systemsculpt-session-revision",
      frame_delimiter: "\n\n",
      data_prefix: "data: ",
      json_frames: ["managed_chat_delta_v1", "managed_chat_session_commit_v1", "managed_chat_error_v1"],
      successful_terminal_marker: "data: [DONE]\n\n",
      successful_terminal_marker_count: 1,
      cancellation_behavior: "client_abort_stops_waiting_server_work_may_continue",
      transport_disconnect_behavior: "same_body_same_idempotency_key_replay_until_committed_or_bounded_failure",
    }));
    expect(chatTurn.response.definitions.managed_chat_delta_v1).toEqual({
      format: "openai_chat_completion_chunk",
      model_alias: "systemsculpt/ai-agent",
      allowed_delta_fields: ["role", "reasoning_summary", "content", "tool_calls"],
      implementation_identity_forbidden: true,
    });
    expect(chatTurn.response.definitions.managed_chat_error_v1).toEqual({
      required_fields: ["error"],
      error_required_fields: ["code", "message"],
      error_optional_fields: ["session_id", "current_revision", "retry_same_idempotency_key"],
      bounded: true,
      implementation_identity_forbidden: true,
    });
    expect(chatTurn.response.definitions.managed_chat_session_commit_v1).toEqual({
      required_fields: ["object", "session_id", "revision", "state"],
      object: "systemsculpt.chat.session",
      revision: "positive_integer",
      state: "committed",
    });
    expect(chatTurn.response.terminal_failures).toEqual([
      { code: "malformed_frame", retry_same_idempotency_key: false },
      { code: "missing_terminal_marker", retry_same_idempotency_key: true },
      { code: "empty_successful_stream", retry_same_idempotency_key: false },
      { code: "in_stream_error", retry_same_idempotency_key: "error_frame_boolean" },
    ]);
    expect(chatTurn.errors).toEqual({
      statuses: [400, 401, 403, 402, 404, 409, 410, 426, 429, 502, 503],
      conflict_codes: [
        "operation_in_progress", "operation_already_completed", "operation_terminal", "settlement_pending",
      ],
      session_codes: [
        "session_not_found", "session_expired", "session_revision_conflict", "session_turn_conflict",
        "session_limit_exceeded", "session_storage_limit_exceeded", "session_state_unavailable",
        "session_storage_unavailable", "session_turn_superseded", "session_finalization_failed",
        "idempotency_key_reused",
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

  it("defines an explicit deterministic v6 managed-only output on the current settings schema", () => {
    const expected = readJson(join(settingsRoot, "expected-v6-managed-settings.json"));
    expect(expected.schemaVersion).toBe(6);
    expect(expected.licenseKey).toBe("license-sentinel");
    expect(expected.managedMigrationState.phase).toBe("auth_cleanup_pending");
    expect(expected.managedMigrationState.receipt.targetSchemaVersion).toBe(6);
    expect(expected.folders).not.toHaveProperty("systemPrompts");
    expect(expected.folders).not.toHaveProperty("webResearch");
    expect(expected.ui).not.toHaveProperty("hideSystemMessagesInChat");
    const forbidden = walkKeys(expected).filter((path) => forbiddenSettingsKey.test(path.split(".").at(-1)!));
    expect(forbidden).toEqual([]);
    expect(expected).toEqual(expect.objectContaining({
      featureFlags: expect.any(Object), folders: expect.any(Object), exclusions: expect.any(Object),
      prompts: expect.any(Object), outputs: expect.any(Object), ui: expect.any(Object),
      workflows: expect.any(Object), studioGraph: expect.any(Object),
    }));
  });
});
