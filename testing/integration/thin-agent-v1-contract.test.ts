/**
 * @jest-environment node
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  canonicalizeThinAgentCapabilityManifest,
  parseThinAgentBootstrapRequest,
  parseThinAgentBootstrapResponse,
  parseThinAgentCapabilityManifest,
  parseThinAgentContextRequest,
  parseThinAgentContextResponse,
  parseThinAgentDataPart,
  THIN_AGENT_DATA_PART_TYPES,
  ThinAgentContractError,
} from "../../src/services/managed/ThinAgentV1Contract";
import {
  DEFAULT_THIN_AGENT_INPUT_LIMITS,
} from "../../src/services/managed/ThinAgentInputLimits";

const FIXTURE_PATH = resolve(
  "testing/fixtures/managed/thin-agent-v1/thin-agent-v1.json",
);
const fixtureBytes = readFileSync(FIXTURE_PATH);
const fixture = JSON.parse(fixtureBytes.toString("utf8"));

describe("thin-agent-v1 application contract", () => {
  it("keeps the canonical cross-repository fixture byte-identical", () => {
    expect(createHash("sha256").update(fixtureBytes).digest("hex"))
      .toBe("d07636678261e6b9012aade13a2d2683c0e0a0dc681141596f88ef7d98ccba22");
    expect(fixtureBytes.toString("utf8"))
      .not.toMatch(/\b(?:connection|ticket|websocket|native)\b/i);
    expect(fixture.endpoints).toMatchObject({
      messages: { method: "GET", path: "/api/plugin/agent/connect/get-messages" },
      turn: { method: "POST", path: "/api/plugin/agent/turn" },
    });
    expect(fixture.transport_semantics).toMatchObject({
      snapshot_first: true,
      turn_submission: "streaming_http_post",
      per_request_response_scope: true,
      queued_cancel_replay: "durable_acknowledgement",
    });
  });

  it("canonicalizes capability ordering and verifies the fixture hash", () => {
    const reordered = {
      capabilities: [{ version: 1, id: "obsidian.vault" }],
      contract_version: "thin-agent-capabilities-v1",
    };
    expect(canonicalizeThinAgentCapabilityManifest(reordered))
      .toBe(fixture.capability_manifest_canonical_json);
    expect(`sha256:${createHash("sha256")
      .update(canonicalizeThinAgentCapabilityManifest(reordered), "utf8")
      .digest("hex")}`).toBe(fixture.capability_manifest_sha256);
  });

  it("records the server-owned released twelve-tool catalog identity", () => {
    expect(fixture.capability_semantics).toMatchObject({
      client_authored_model_tool_schema: false,
      obsidian_vault_v1_maps_to_canonical_local_tool_count: 12,
      server_tool_catalog_canonical_bytes: 13_475,
      server_tool_catalog_sha256:
        "d0df90f4939a33ab8b242d18821a2fde7c3f626dbcd6b24948f98987f50d3228",
    });
  });

  it("rejects unknown capability versions and client-authored tool authority", () => {
    expect(() => parseThinAgentCapabilityManifest({
      contract_version: "thin-agent-capabilities-v1",
      capabilities: [{ id: "obsidian.vault", version: 2 }],
    })).toThrow(ThinAgentContractError);
    expect(() => parseThinAgentCapabilityManifest({
      contract_version: "thin-agent-capabilities-v1",
      capabilities: [{
        id: "obsidian.vault",
        version: 1,
        description: "Client-authored prompt text",
      }],
    })).toThrow(ThinAgentContractError);
  });

  it("accepts canonical create and fork bootstraps without client history", async () => {
    expect(parseThinAgentBootstrapRequest(fixture.bootstrap.request))
      .toMatchObject({
        conversation_id: fixture.bootstrap.request.conversation_id,
      });
    expect(parseThinAgentBootstrapRequest(fixture.bootstrap.fork_request))
      .toMatchObject({
        fork: {
          source_conversation_id:
            fixture.bootstrap.fork_request.fork.source_conversation_id,
          before_message_id:
            fixture.bootstrap.fork_request.fork.before_message_id,
        },
      });
  });

  it("parses server-owned thin-client picker limits from bootstrap", () => {
    expect(parseThinAgentBootstrapResponse(fixture.bootstrap.response))
      .toMatchObject({
        client_input_limits: {
          imageMimeTypes: ["image/png", "image/jpeg", "image/webp"],
          maxContentBlocksPerMessage: 16,
          maxImagesPerTurn: 6,
          maxImageBytes: 6 * 1024 * 1024,
          maxTotalImageBytes: 16 * 1024 * 1024,
          maxTextBytesPerBlock: 1024 * 1024,
          maxTotalTextBytes: 2 * 1024 * 1024,
          maxDocumentBytes: 25 * 1024 * 1024,
        },
      });
  });

  it("parses the opaque staged context response and keeps raw context out of the turn body", () => {
    expect(parseThinAgentContextResponse(fixture.context_staging.response))
      .toEqual(fixture.context_staging.response);
    expect(fixture.context_staging.turn_body).toEqual({
      context_ref: fixture.context_staging.response.context_ref,
    });
    expect(fixture.context_staging.turn_body).not.toHaveProperty("context_sources");
    expect(() => parseThinAgentContextResponse({
      ...fixture.context_staging.response,
      context_sources: fixture.context_staging.request.context_sources,
    })).toThrow(ThinAgentContractError);
    expect(() => parseThinAgentContextResponse({
      ...fixture.context_staging.response,
      context_ref: "raw context is forbidden",
    })).toThrow(ThinAgentContractError);
    expect(() => parseThinAgentContextResponse({
      ...fixture.context_staging.response,
      bytes: 1,
    })).toThrow(ThinAgentContractError);
    expect(parseThinAgentContextResponse({
      ...fixture.context_staging.response,
      bytes: 2,
    })).toMatchObject({ bytes: 2 });
  });

  it("validates staged context with the server's UTF-8, path, and document semantics", () => {
    const maxBlock = DEFAULT_THIN_AGENT_INPUT_LIMITS.maxTextBytesPerBlock;
    const first = {
      kind: "text" as const,
      path: "a",
      content: "x".repeat(maxBlock - 1),
    };
    const second = {
      kind: "text" as const,
      path: "b",
      content: "y".repeat(maxBlock - 1),
    };
    expect(parseThinAgentContextRequest({
      contract_version: "thin-agent-v1",
      root_message_id: "message_context_boundary",
      context_sources: [first, second],
    }, DEFAULT_THIN_AGENT_INPUT_LIMITS).context_sources).toHaveLength(2);
    expect(() => parseThinAgentContextRequest({
      contract_version: "thin-agent-v1",
      root_message_id: "message_context_boundary",
      context_sources: [first, { ...second, path: "bb" }],
    }, DEFAULT_THIN_AGENT_INPUT_LIMITS)).toThrow(ThinAgentContractError);

    expect(parseThinAgentContextRequest({
      contract_version: "thin-agent-v1",
      root_message_id: "message_context_multibyte",
      context_sources: [{
        kind: "text",
        path: "é",
        content: "é".repeat(maxBlock / 2),
      }],
    }, DEFAULT_THIN_AGENT_INPUT_LIMITS).context_sources).toHaveLength(1);
    expect(() => parseThinAgentContextRequest({
      contract_version: "thin-agent-v1",
      root_message_id: "message_context_multibyte",
      context_sources: [{
        kind: "text",
        path: "é",
        content: `${"é".repeat(maxBlock / 2)}é`,
      }],
    }, DEFAULT_THIN_AGENT_INPUT_LIMITS)).toThrow(ThinAgentContractError);

    const validDocument = {
      kind: "document_ref" as const,
      path: "document.pdf",
      document_id: "123e4567-e89b-12d3-a456-426614174000",
    };
    expect(parseThinAgentContextRequest({
      contract_version: "thin-agent-v1",
      root_message_id: "message_context_document",
      context_sources: [validDocument],
    }, DEFAULT_THIN_AGENT_INPUT_LIMITS).context_sources).toEqual([validDocument]);
    for (const invalid of [
      { ...validDocument, document_id: "document-1" },
      { ...validDocument, path: "p".repeat(1_025) },
      { ...validDocument, path: "bad\0path" },
    ]) {
      expect(() => parseThinAgentContextRequest({
        contract_version: "thin-agent-v1",
        root_message_id: "message_context_document",
        context_sources: [invalid],
      }, DEFAULT_THIN_AGENT_INPUT_LIMITS)).toThrow(ThinAgentContractError);
    }
  });

  it.each([
    "capability_manifest_sha256",
    "history",
    "messages",
    "plugin_version",
    "resume_cursor",
    "session_id",
    "transcript",
  ])(
    "rejects forbidden bootstrap field %s",
    (field) => {
      expect(() => parseThinAgentBootstrapRequest({
        ...fixture.bootstrap.request,
        [field]: field === "messages" ? [] : "forbidden",
      })).toThrow(ThinAgentContractError);
    },
  );

  it("rejects malformed or mismatched bootstrap identities", () => {
    expect(() => parseThinAgentBootstrapRequest({
      ...fixture.bootstrap.request,
      client_id: "client-user@example.com",
    })).toThrow(ThinAgentContractError);
    expect(() => parseThinAgentBootstrapResponse(
      fixture.bootstrap.response,
      {
        conversation_id: "conversation_99999999999999999999999999999999",
      },
    )).toThrow(ThinAgentContractError);
    expect(() => parseThinAgentBootstrapResponse({
      ...fixture.bootstrap.response,
      session: { id: "session-invalid" },
    })).toThrow(ThinAgentContractError);
    for (const retiredFields of [
      {
        connection: {
          ticket: "legacy.ticket.signature",
          expires_at: "2030-01-01T00:01:00.000Z",
        },
      },
      { connection: { future_server_field: true } },
      { ticket: "legacy.ticket.signature" },
      { future_server_field: { ticket: "legacy.ticket.signature" } },
      { future_server_field: [{ ticket: "legacy.ticket.signature" }] },
    ]) {
      expect(() => parseThinAgentBootstrapResponse({
        ...fixture.bootstrap.response,
        ...retiredFields,
      })).toThrow(ThinAgentContractError);
    }
  });

  it("accepts additive response and known data fields while ignoring unknown parts", () => {
    expect(parseThinAgentBootstrapResponse({
      ...fixture.bootstrap.response,
      future_server_field: {
        safe: true,
        connection: { additive_nested_field: true },
      },
    }, {
      conversation_id: fixture.bootstrap.request.conversation_id,
    })).toMatchObject({
      session: { id: fixture.bootstrap.response.session.id },
    });

    const terminal = parseThinAgentDataPart({
      ...fixture.data_parts[0],
      data: { ...fixture.data_parts[0].data, future_field: "ignored" },
    });
    expect(terminal).toMatchObject({
      kind: "known",
      type: "data-systemsculpt-run-terminal",
      data: {
        root_message_id: fixture.data_parts[0].data.root_message_id,
        outcome: "succeeded",
        code: "completed",
      },
    });
    expect(terminal).not.toHaveProperty("data.future_field");
    expect(parseThinAgentDataPart({
      type: "data-systemsculpt-future-event",
      data: { version: 1 },
    })).toEqual({
      kind: "unknown",
      type: "data-systemsculpt-future-event",
    });
  });

  it("distinguishes invalid known payloads from safe unknown additions", () => {
    expect(THIN_AGENT_DATA_PART_TYPES).toEqual([
      "data-systemsculpt-run-terminal",
      "data-systemsculpt-client-tool-request",
    ]);
    expect(parseThinAgentDataPart({
      type: "data-systemsculpt-run-terminal",
      data: {
        ...fixture.data_parts[0].data,
        version: 2,
      },
    })).toEqual({
      kind: "invalid",
      type: "data-systemsculpt-run-terminal",
    });
    expect(parseThinAgentDataPart({
      type: "data-systemsculpt-attachment-ref",
      data: { version: 1 },
    })).toEqual({
      kind: "unknown",
      type: "data-systemsculpt-attachment-ref",
    });
  });

  it("parses only complete first-party client-tool requests with canonical JSON input", () => {
    const canonical = fixture.data_parts[2];
    const parsed = parseThinAgentDataPart({
      ...canonical,
      providerExecuted: false,
      data: {
        ...canonical.data,
        future_field: "ignored",
        providerExecuted: false,
        target: {
          ...canonical.data.target,
          future_target_field: "ignored",
        },
        input: {
          z: [null, true, 4, "value"],
          a: { nested: "kept" },
        },
      },
    });
    expect(parsed).toEqual({
      kind: "known",
      type: "data-systemsculpt-client-tool-request",
      data: {
        version: 1,
        tool_call_id: "call_fixture_read",
        tool_name: "read",
        target: { id: "obsidian.vault", version: 1 },
        input: {
          a: { nested: "kept" },
          z: [null, true, 4, "value"],
        },
      },
    });
    expect(parsed).not.toHaveProperty("providerExecuted");
    expect(parsed).not.toHaveProperty("data.providerExecuted");
    expect(parsed).not.toHaveProperty("data.future_field");
    expect(parsed).not.toHaveProperty("data.target.future_target_field");
    if (parsed?.kind === "known"
      && parsed.type === "data-systemsculpt-client-tool-request") {
      expect(Object.keys(parsed.data.input as object)).toEqual(["a", "z"]);
      expect(Object.isFrozen(parsed.data.input)).toBe(true);
      expect(Object.isFrozen((parsed.data.input as Record<string, unknown>).a))
        .toBe(true);
    }
    expect(canonical).not.toHaveProperty("toolCallId");
  });

  it("rejects malformed, non-JSON, cyclic, and over-deep client-tool requests", () => {
    const valid = fixture.data_parts[2].data;
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    let tooDeep: unknown = "leaf";
    for (let depth = 0; depth < 66; depth += 1) {
      tooDeep = { value: tooDeep };
    }
    const sparse = new Array(2);
    sparse[0] = "present";
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get: () => "not JSON data",
    });

    for (const data of [
      { ...valid, version: 2 },
      { ...valid, tool_call_id: undefined },
      { ...valid, tool_call_id: " invalid " },
      { ...valid, tool_call_id: "x".repeat(513) },
      { ...valid, tool_name: undefined },
      { ...valid, tool_name: "read file" },
      { ...valid, tool_name: `r${"x".repeat(128)}` },
      { ...valid, target: undefined },
      { ...valid, target: { id: "vendor.vault", version: 1 } },
      { ...valid, target: { id: "obsidian.vault", version: 2 } },
      { ...valid, input: undefined },
      { ...valid, input: Number.NaN },
      { ...valid, input: Number.POSITIVE_INFINITY },
      { ...valid, input: BigInt(1) },
      { ...valid, input: Symbol("input") },
      { ...valid, input: () => ({}) },
      { ...valid, input: new Date(0) },
      { ...valid, input: cycle },
      { ...valid, input: tooDeep },
      { ...valid, input: sparse },
      { ...valid, input: accessor },
    ]) {
      expect(parseThinAgentDataPart({
        type: "data-systemsculpt-client-tool-request",
        data,
      })).toEqual({
        kind: "invalid",
        type: "data-systemsculpt-client-tool-request",
      });
    }
  });

  it("strictly validates terminal outcome fields", () => {
    expect(parseThinAgentDataPart(fixture.data_parts[1])).toMatchObject({
      kind: "known",
      data: {
        outcome: "failed",
        code: "service_temporarily_unavailable",
        retryable: true,
      },
    });
    for (const data of [
      { ...fixture.data_parts[0].data, root_message_id: undefined },
      { ...fixture.data_parts[0].data, root_message_id: " invalid " },
      { ...fixture.data_parts[0].data, incident_id: "incident_44444444444444444444444444444444" },
      { ...fixture.data_parts[0].data, outcome: "cancelled", code: "completed" },
      {
        ...fixture.data_parts[1].data,
        incident_id: undefined,
      },
    ]) {
      expect(parseThinAgentDataPart({
        type: "data-systemsculpt-run-terminal",
        data,
      })).toEqual({
        kind: "invalid",
        type: "data-systemsculpt-run-terminal",
      });
    }
  });

  it("records authoritative branch, retry, and account isolation semantics", () => {
    expect(fixture.bootstrap_semantics).toMatchObject({
      client_conversation_is_execution_authority: false,
      server_session_is_execution_authority: true,
      same_account_exact_retry: {
        status: 200,
        session_id: "same_as_first_success",
      },
      cross_account_fork_source: {
        status: 404,
        code: "fork_source_not_found",
        indistinguishable_from_missing_source: true,
      },
      missing_source_message: {
        status: 409,
        code: "fork_boundary_not_found",
      },
      fork_copy_boundary: "server_history_strictly_before_before_message_id",
    });
  });
});
