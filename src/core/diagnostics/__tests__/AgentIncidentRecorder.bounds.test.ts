import { canonicalJsonStringify } from "../AgentIncidentCanonicalJson";
import { deriveAgentIncidentMissingFields } from "../AgentIncidentCompleteness";
import {
  AgentIncidentRecorder,
  type AgentIncidentCaptureContext,
  type AgentIncidentReport,
} from "../AgentIncidentRecorder";
import * as schema from "../AgentIncidentSchema";

// Exercise every existing eviction stage without changing production limits.
jest.mock("../AgentIncidentSchema", () => ({ __esModule: true, ...jest.requireActual("../AgentIncidentSchema") }));
jest.mock("../AgentIncidentCanonicalJson", () => {
  const actual = jest.requireActual<typeof import("../AgentIncidentCanonicalJson")>("../AgentIncidentCanonicalJson");
  return { ...actual, canonicalJsonStringify: jest.fn(actual.canonicalJsonStringify) };
});

const correlation = {
  conversationId: `conversation_${"1".repeat(32)}`,
  requestId: "user-76712c65-86b6-4408-8dfc-6de89d79a479",
};

function captureReport(
  eventCount = schema.AGENT_INCIDENT_MAX_EVENTS,
  detailed = true,
  environment?: AgentIncidentCaptureContext["environment"],
): AgentIncidentReport {
  const recorder = new AgentIncidentRecorder({
    now: () => Date.UTC(2026, 7, 13, 14, 1),
    createReportId: () => `report_${"4".repeat(32)}`,
  });
  for (let sequence = 1; sequence <= eventCount; sequence += 1) {
    const code = sequence === 1 ? "run_started"
      : sequence === eventCount ? "run_finished_failed"
        : detailed && sequence <= schema.AGENT_INCIDENT_MAX_TOOLS + 1 ? "local_tool_started" : "phase_working";
    recorder.record({
      timestamp: new Date(Date.UTC(2026, 7, 13, 14, 0, 0, sequence)).toISOString(),
      severity: "info",
      phase: "response",
      code,
      sequence,
      conversation_id: correlation.conversationId,
      request_id: correlation.requestId,
      command_kind: "submit",
      command_segment_ordinal: schema.AGENT_INCIDENT_MAX_TRANSPORT_SEGMENTS,
      ...(code === "local_tool_started" ? {
        tool_execution_ordinal: sequence - 1,
        tool_name: "multi_edit",
        tool_item_count: 10_000,
      } : {}),
      ...(code === "run_finished_failed" ? {
        incident_id: `incident_${"3".repeat(32)}`,
        failure_code: "response_failed",
      } : {}),
    });
  }
  if (detailed) {
    for (let ordinal = 1; ordinal <= schema.AGENT_INCIDENT_MAX_TRANSPORT_SEGMENTS; ordinal += 1) {
      recorder.attachTransportSegment(correlation, {
        commandKind: "submit",
        commandSegmentOrdinal: ordinal,
        closeReason: "response_rejected",
        durationMs: 35_695,
        receivedBytes: 4_096,
        nonEmptyRawChunkCount: 8,
        sseEventCount: 7,
        acceptedFrameCount: 6,
        deliveredFrameCount: 6,
        metricsTruncated: false,
      });
    }
    recorder.attachResourceSamples(correlation, Array.from(
      { length: schema.AGENT_INCIDENT_MAX_RESOURCE_SAMPLES },
      (_, index) => ({
        captured_at: new Date(Date.UTC(2026, 7, 13, 14, 0, index)).toISOString(),
        heap_used_mb: index + 200,
        cpu_percent: index,
      }),
    ));
  }
  return recorder.finalize(correlation, {
    failureAuthority: "server",
    environment,
    rendering: {
      failureSurfaceDomCommitted: false,
      failureSurfacePaintOpportunityObserved: false,
    },
  })!;
}

function withExactSelfSize(report: AgentIncidentReport): AgentIncidentReport {
  let result = { ...report, capture_quality: { ...report.capture_quality, report_bytes: 0 } };
  for (;;) {
    const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
    if (result.capture_quality.report_bytes === bytes) return result;
    result = { ...result, capture_quality: { ...result.capture_quality, report_bytes: bytes } };
  }
}

function expectedRetention(
  baseline: AgentIncidentReport,
  timelineCount: number,
  transportCount: number,
  resourceCount: number,
  rendering: boolean,
): AgentIncidentReport {
  const timeline = [...baseline.timeline.slice(0, 16), ...baseline.timeline.slice(-(timelineCount - 16))];
  const transport = transportCount === 16 ? baseline.transport_segments.slice(0, 16)
    : [...baseline.transport_segments.slice(0, 16), ...baseline.transport_segments.slice(-(transportCount - 16))];
  const resources = resourceCount === 0 ? [] : baseline.resource_samples.slice(-resourceCount);
  const timelineDrops = baseline.timeline.length - timeline.length;
  const transportDrops = baseline.transport_segments.length - transport.length;
  const resourceDrops = baseline.resource_samples.length - resources.length;
  const { rendering: originalRendering, ...withoutRendering } = baseline;
  let expected: AgentIncidentReport = {
    ...withoutRendering,
    ...(rendering ? { rendering: originalRendering } : {}),
    timeline,
    transport_segments: transport,
    resource_samples: resources,
    run_summary: { ...baseline.run_summary, retained_timeline_event_count: timeline.length },
    capture_quality: {
      ...baseline.capture_quality,
      complete: false,
      truncated: true,
      retained_event_count: timeline.length,
      dropped_event_count: timelineDrops,
      dropped_events: { ...baseline.capture_quality.dropped_events, byte_limit: timelineDrops },
      dropped_transport_segment_count: transportDrops,
      dropped_resource_sample_count: resourceDrops,
      collection_failures: [{
        code: "report_size_reduction",
        count: timelineDrops + transportDrops + resourceDrops + (rendering ? 0 : 1),
      }],
    },
  };
  expected = {
    ...expected,
    capture_quality: {
      ...expected.capture_quality,
      missing_fields: deriveAgentIncidentMissingFields({
        incident: expected.incident,
        correlation: expected.correlation,
        environment: expected.environment,
        summary: expected.run_summary,
        runState: expected.run_state,
        rendering: expected.rendering,
        timeline,
        resourceLength: resources.length,
        transportSegments: transport,
      }),
    },
  };
  // Set a ceiling exactly equal to this retention shape, including the digits
  // of both maximum_report_bytes and report_bytes.
  for (;;) {
    expected = withExactSelfSize(expected);
    const bytes = expected.capture_quality.report_bytes;
    if (expected.capture_quality.limits.maximum_report_bytes === bytes) return expected;
    expected = {
      ...expected,
      capture_quality: {
        ...expected.capture_quality,
        limits: { ...expected.capture_quality.limits, maximum_report_bytes: bytes },
      },
    };
  }
}

describe("AgentIncidentRecorder report-size trimming", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.mocked(canonicalJsonStringify).mockClear();
  });

  it("canonicalizes retained evidence only once while trimming many report-size events", () => {
    const baseline = captureReport();
    expect(baseline.capture_quality.dropped_event_count).toBe(0);
    const expected = expectedRetention(baseline, 100, 64, 12, true);
    jest.replaceProperty(schema, "AGENT_INCIDENT_MAX_REPORT_BYTES", expected.capture_quality.report_bytes);
    jest.mocked(canonicalJsonStringify).mockClear();

    const report = captureReport();
    const fullReports = jest.mocked(canonicalJsonStringify).mock.calls
      .map(([value]) => value as AgentIncidentReport)
      .filter((value) => Array.isArray(value?.timeline) && value.timeline.length > 0);

    expect(fullReports).toHaveLength(1);
    expect(report).toEqual(expected);
    expect(report.timeline.slice(0, 16)).toEqual(baseline.timeline.slice(0, 16));
    expect(report.timeline.slice(16)).toEqual(baseline.timeline.slice(-84));
    expect(report.timeline.at(-1)?.code).toBe("run_finished_failed");
    expect(report.capture_quality.report_bytes).toBe(withExactSelfSize(report).capture_quality.report_bytes);
    expect(report.capture_quality.report_bytes).toBeLessThanOrEqual(schema.AGENT_INCIDENT_MAX_REPORT_BYTES);
  });

  it.each([
    ["transport", 20, 12, true],
    ["resources", 16, 3, true],
    ["rendering", 16, 0, false],
  ] as const)("preserves exact counters and completeness when reducing %s", (_stage, transports, resources, rendering) => {
    const baseline = captureReport();
    const expected = expectedRetention(baseline, 17, transports, resources, rendering);
    jest.replaceProperty(schema, "AGENT_INCIDENT_MAX_REPORT_BYTES", expected.capture_quality.report_bytes);

    const report = captureReport();

    expect(report).toEqual(expected);
    expect(report.capture_quality.report_bytes).toBeLessThanOrEqual(schema.AGENT_INCIDENT_MAX_REPORT_BYTES);
    expect(report.timeline.at(-1)?.code).toBe("run_finished_failed");
  });

  it("counts self-size digits before deciding whether another event fits", () => {
    const baseline = captureReport(80, false);
    const limit = withExactSelfSize({
      ...baseline,
      capture_quality: {
        ...baseline.capture_quality,
        limits: { ...baseline.capture_quality.limits, maximum_report_bytes: 10_000 },
      },
    }).capture_quality.report_bytes - 1;
    jest.replaceProperty(schema, "AGENT_INCIDENT_MAX_REPORT_BYTES", limit);

    const report = captureReport(80, false);

    expect(report.capture_quality.dropped_events.byte_limit).toBe(1);
    expect(report.capture_quality.collection_failures).toContainEqual({ code: "report_size_reduction", count: 1 });
    expect(report.capture_quality.report_bytes).toBe(withExactSelfSize(report).capture_quality.report_bytes);
    expect(report.capture_quality.report_bytes).toBeLessThanOrEqual(limit);
  });

  it("resolves a decimal-width carry without serializing the whole report again", () => {
    let report: AgentIncidentReport | undefined;
    for (let count = 2; count <= schema.AGENT_INCIDENT_MAX_EVENTS && !report; count += 1) {
      for (const includeBuild of [false, true]) {
        const environment = {
          pluginVersion: "1.0",
          obsidianVersion: "1.0",
          ...(includeBuild ? { pluginBuildId: `sha256:${"5".repeat(64)}` } : {}),
        };
        const baseline = captureReport(count, false, environment);
        const zeroBytes = new TextEncoder().encode(JSON.stringify({
          ...baseline,
          capture_quality: { ...baseline.capture_quality, report_bytes: 0 },
        })).byteLength;
        const padding = 9_997 - zeroBytes;
        if (padding < 0 || padding > 122) continue;
        jest.mocked(canonicalJsonStringify).mockClear();
        report = captureReport(count, false, {
          ...environment,
          pluginVersion: `${"1".repeat(1 + Math.min(padding, 61))}.0`,
          obsidianVersion: `${"1".repeat(1 + Math.max(padding - 61, 0))}.0`,
        });
        break;
      }
    }
    expect(report?.capture_quality.report_bytes).toBe(10_001);
    expect(report?.capture_quality.report_bytes).toBe(withExactSelfSize(report!).capture_quality.report_bytes);
    const fullReports = jest.mocked(canonicalJsonStringify).mock.calls
      .filter(([value]) => Array.isArray((value as AgentIncidentReport)?.timeline)
        && (value as AgentIncidentReport).timeline.length > 0);
    expect(fullReports).toHaveLength(1);
  });

  it("does not invoke inherited toJSON hooks during report-size eviction", () => {
    const expected = expectedRetention(captureReport(), 100, 64, 12, true);
    jest.replaceProperty(schema, "AGENT_INCIDENT_MAX_REPORT_BYTES", expected.capture_quality.report_bytes);
    const arrayDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    const objectDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    let hookCalls = 0;
    let report: AgentIncidentReport;
    try {
      const hook = () => { hookCalls += 1; throw new Error("private-toJSON-canary"); };
      Object.defineProperty(Array.prototype, "toJSON", { configurable: true, value: hook });
      Object.defineProperty(Object.prototype, "toJSON", { configurable: true, value: hook });
      report = captureReport();
    } finally {
      if (arrayDescriptor) Object.defineProperty(Array.prototype, "toJSON", arrayDescriptor);
      else delete (Array.prototype as { toJSON?: unknown }).toJSON;
      if (objectDescriptor) Object.defineProperty(Object.prototype, "toJSON", objectDescriptor);
      else delete (Object.prototype as { toJSON?: unknown }).toJSON;
    }
    expect(hookCalls).toBe(0);
    expect(report!).toEqual(expected);
  });
});
