import {
  parseThinAgentBootstrapRequest,
  parseThinAgentBootstrapResponse,
  parseThinAgentCapabilityManifest,
  parseThinAgentContextRequest,
  parseThinAgentDataPart,
  type ThinAgentBootstrapRequest,
} from "../ThinAgentV1Contract";
import {
  DEFAULT_THIN_AGENT_INPUT_LIMITS,
  thinAgentInputLimitsWireValue,
} from "../ThinAgentInputLimits";

const bootstrap: ThinAgentBootstrapRequest = {
  contract_version: "thin-agent-v1",
  conversation_id: `conversation_${"a".repeat(32)}`,
  client_id: `client_${"b".repeat(32)}`,
  plugin_build_id: `sha256:${"c".repeat(64)}`,
  capability_manifest: {
    contract_version: "thin-agent-capabilities-v1",
    capabilities: [{ id: "obsidian.vault", version: 1 }],
  },
};
const fork = {
  source_conversation_id: `conversation_${"d".repeat(32)}`,
  before_message_id: "message_before_edit",
};
const context = {
  contract_version: "thin-agent-v1",
  root_message_id: "message_context",
  context_sources: [{ kind: "text", path: "Plan.md", content: "Keep this note." }],
};
const toolPart = {
  type: "data-systemsculpt-client-tool-request",
  data: {
    version: 1,
    tool_call_id: "call_read_note",
    tool_name: "read",
    target: { id: "obsidian.vault", version: 1 },
    input: { path: "Plan.md" },
  },
};

describe("ThinAgentV1Contract", () => {
  it("rejects duplicate vault capabilities instead of negotiating ambiguous support", () => {
    expect(() => parseThinAgentCapabilityManifest({
      ...bootstrap.capability_manifest,
      capabilities: [
        { id: "obsidian.vault", version: 1 },
        { id: "obsidian.vault", version: 1 },
      ],
    })).toThrow(expect.objectContaining({
      name: "ThinAgentContractError",
      code: "invalid_capabilities",
      message: "Client capabilities must be unique.",
    }));
  });

  it.each([
    ["absent manifest", undefined],
    ["non-record manifest", []],
    ["missing capabilities", { contract_version: "thin-agent-capabilities-v1" }],
    ["unsupported manifest version", { ...bootstrap.capability_manifest, contract_version: "future" }],
    ["absent capability list", { ...bootstrap.capability_manifest, capabilities: undefined }],
    ["empty capability list", { ...bootstrap.capability_manifest, capabilities: [] }],
    ["malformed capability", { ...bootstrap.capability_manifest, capabilities: [null] }],
    ["unsupported capability", { ...bootstrap.capability_manifest, capabilities: [{ id: "obsidian.vault", version: 2 }] }],
  ])("fails startup closed for %s", (_label, manifest) => {
    expect(() => parseThinAgentBootstrapRequest({
      ...bootstrap,
      capability_manifest: manifest,
    })).toThrow(expect.objectContaining({
      name: "ThinAgentContractError",
      code: "invalid_capabilities",
    }));
  });

  it("explains that an unsupported chat contract needs a plugin update", () => {
    expect(() => parseThinAgentBootstrapRequest({
      ...bootstrap,
      contract_version: "unsupported-contract",
    })).toThrow(expect.objectContaining({
      code: "unsupported_contract",
      message: "This SystemSculpt version is not supported. Update the plugin and try again.",
    }));
  });

  it("keeps an edited-message fork distinct from a fresh chat", () => {
    const fresh = parseThinAgentBootstrapRequest(bootstrap);
    const edited = parseThinAgentBootstrapRequest({ ...bootstrap, fork });
    expect(fresh).not.toHaveProperty("fork");
    expect(edited.fork).toEqual(fork);
    expect(edited.fork).not.toBe(fork);
    expect(Object.isFrozen(edited.fork)).toBe(true);
  });

  it.each([
    ["null fork", null],
    ["self fork", { ...fork, source_conversation_id: bootstrap.conversation_id }],
    ["invalid source", { ...fork, source_conversation_id: "not-a-conversation" }],
    ["missing boundary", { source_conversation_id: fork.source_conversation_id }],
    ["invalid boundary", { ...fork, before_message_id: " message " }],
    ["extra history", { ...fork, messages: [] }],
  ])("rejects %s instead of silently starting a different chat", (_label, invalidFork) => {
    expect(() => parseThinAgentBootstrapRequest({
      ...bootstrap,
      fork: invalidFork,
    })).toThrow(expect.objectContaining({ code: "invalid_fork" }));
  });

  it.each([
    ["missing", undefined],
    ["zero", { ...thinAgentInputLimitsWireValue(DEFAULT_THIN_AGENT_INPUT_LIMITS), max_image_bytes: 0 }],
    ["inconsistent", { ...thinAgentInputLimitsWireValue(DEFAULT_THIN_AGENT_INPUT_LIMITS), max_total_text_bytes: 1 }],
  ])("reports %s attachment limits as a bootstrap failure", (_label, limits) => {
    expect(() => parseThinAgentBootstrapResponse({
      contract_version: "thin-agent-v1",
      conversation_id: bootstrap.conversation_id,
      session: { id: `session_${"e".repeat(32)}` },
      access: { token: "fixture.access.signature", expires_at: "2030-01-01T00:00:00.000Z" },
      accepted_capabilities: bootstrap.capability_manifest.capabilities,
      client_input_limits: limits,
    })).toThrow(expect.objectContaining({
      code: "invalid_bootstrap",
      message: "SystemSculpt returned invalid attachment limits.",
    }));
  });

  it.each([
    ["non-record request", null],
    ["unsupported contract", { ...context, contract_version: "future" }],
    ["missing message identity", { ...context, root_message_id: undefined }],
    ["invalid message identity", { ...context, root_message_id: " message " }],
    ["non-array sources", { ...context, context_sources: {} }],
    ["unnegotiated request field", { ...context, history: [] }],
    ["too many sources", {
      ...context,
      context_sources: Array.from(
        { length: DEFAULT_THIN_AGENT_INPUT_LIMITS.maxContentBlocksPerMessage + 1 },
        () => context.context_sources[0],
      ),
    }],
  ])("rejects context with %s without dropping selected notes", (_label, request) => {
    expect(() => parseThinAgentContextRequest(request, DEFAULT_THIN_AGENT_INPUT_LIMITS))
      .toThrow(expect.objectContaining({
        code: "invalid_context",
        message: "The selected vault context request is invalid.",
      }));
  });

  it("rejects a mixed selection as a whole instead of submitting only valid notes", () => {
    const request = {
      ...context,
      context_sources: [
        ...context.context_sources,
        { kind: "image", path: "photo.png", data_url: "data:image/png;base64,not-base64" },
      ],
    };
    const original = JSON.stringify(request);
    expect(() => parseThinAgentContextRequest(request, DEFAULT_THIN_AGENT_INPUT_LIMITS))
      .toThrow(expect.objectContaining({ code: "invalid_context" }));
    expect(JSON.stringify(request)).toBe(original);
  });

  it.each(["data-systemsculpt-run-terminal", "data-systemsculpt-client-tool-request"])(
    "distinguishes malformed %s payloads from unknown server additions",
    (type) => {
      for (const data of [undefined, null, [], "not a record", 1]) {
        expect(parseThinAgentDataPart({ type, data })).toEqual({ kind: "invalid", type });
      }
      expect(parseThinAgentDataPart({ type: "data-future-server-event", data: null }))
        .toEqual({ kind: "unknown", type: "data-future-server-event" });
    },
  );

  it("returns an invalid tool request when inspecting its input throws", () => {
    const input = new Proxy({}, {
      ownKeys() { throw new Error("Unavailable input"); },
    });
    expect(parseThinAgentDataPart({ ...toolPart, data: { ...toolPart.data, input } }))
      .toEqual({ kind: "invalid", type: toolPart.type });
  });

  it("does not execute accessor properties while validating tool arguments", () => {
    const getter = jest.fn(() => "Plan.md");
    const input = ["placeholder"];
    Object.defineProperty(input, "0", { enumerable: true, get: getter });
    expect(parseThinAgentDataPart({ ...toolPart, data: { ...toolPart.data, input } }))
      .toEqual({ kind: "invalid", type: toolPart.type });
    expect(getter).not.toHaveBeenCalled();
  });

  it("snapshots tool arguments without losing JSON keys or letting later mutations change them", () => {
    const input = {
      paths: ["Plan.md"],
      options: { includeContent: true, offset: -0, continuation: null },
    };
    Object.defineProperty(input, "__proto__", {
      enumerable: true,
      value: { path: "literal-key.md" },
    });
    const parsed = parseThinAgentDataPart({ ...toolPart, data: { ...toolPart.data, input } });
    input.paths.push("Other.md");
    input.options.includeContent = false;
    expect(parsed).toMatchObject({
      kind: "known",
      data: { input: { paths: ["Plan.md"], options: { includeContent: true, offset: 0, continuation: null } } },
    });
    if (parsed?.kind !== "known" || parsed.type !== "data-systemsculpt-client-tool-request") {
      throw new Error("Expected a valid client tool request");
    }
    expect(parsed.data.input).not.toBe(input);
    expect(Object.isFrozen(parsed.data.input)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(parsed.data.input, "__proto__"))
      .toEqual({ value: { path: "literal-key.md" }, enumerable: true, writable: false, configurable: false });
    expect(Object.getPrototypeOf(parsed.data.input)).toBe(Object.prototype);
  });
});
