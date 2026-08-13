import {
  isLocalReportId,
  normalizeFailedTerminalReceipt,
} from "../FailedTerminalReceipt";

const LOCAL_REPORT_ID = `report_${"a".repeat(32)}`;
const INCIDENT_ID = `incident_${"b".repeat(32)}`;
const SERVER_RUN_ID = `run_${"c".repeat(32)}`;
const BASE_RECEIPT = Object.freeze({
  terminalOutcome: "failed",
  terminalFailureCode: "agent_turn_failed",
  terminalRetryable: true,
} as const);

describe("failed terminal receipt metadata", () => {
  it.each([
    [
      "local receipt",
      { terminalReportId: LOCAL_REPORT_ID },
      { ...BASE_RECEIPT, terminalReportId: LOCAL_REPORT_ID },
    ],
    [
      "server receipt",
      { terminalIncidentId: INCIDENT_ID, terminalServerRunId: SERVER_RUN_ID },
      {
        ...BASE_RECEIPT,
        terminalIncidentId: INCIDENT_ID,
        terminalServerRunId: SERVER_RUN_ID,
      },
    ],
    [
      "combined receipt",
      {
        terminalReportId: LOCAL_REPORT_ID,
        terminalIncidentId: INCIDENT_ID,
        terminalServerRunId: SERVER_RUN_ID,
      },
      {
        ...BASE_RECEIPT,
        terminalReportId: LOCAL_REPORT_ID,
        terminalIncidentId: INCIDENT_ID,
        terminalServerRunId: SERVER_RUN_ID,
      },
    ],
    [
      "server receipt with an ignored invalid local ID",
      {
        terminalReportId: "report_invalid",
        terminalIncidentId: INCIDENT_ID,
        terminalServerRunId: SERVER_RUN_ID,
      },
      {
        ...BASE_RECEIPT,
        terminalIncidentId: INCIDENT_ID,
        terminalServerRunId: SERVER_RUN_ID,
      },
    ],
    [
      "local receipt with explicitly undefined server IDs",
      {
        terminalReportId: LOCAL_REPORT_ID,
        terminalIncidentId: undefined,
        terminalServerRunId: undefined,
      },
      { ...BASE_RECEIPT, terminalReportId: LOCAL_REPORT_ID },
    ],
  ])("normalizes a valid %s without changing its input", (_label, fields, expected) => {
    const candidate = Object.freeze({ ...BASE_RECEIPT, ...fields });
    const before = { ...candidate };

    expect(normalizeFailedTerminalReceipt(candidate)).toEqual(expected);
    expect(candidate).toEqual(before);
  });

  it.each([
    ["missing receipt ID", {}],
    ["different outcome", { terminalOutcome: "cancelled", terminalReportId: LOCAL_REPORT_ID }],
    ["invalid failure code", { terminalReportId: LOCAL_REPORT_ID, terminalFailureCode: "Agent Failed" }],
    ["non-boolean retryable value", { terminalReportId: LOCAL_REPORT_ID, terminalRetryable: "true" }],
    ["invalid local ID", { terminalReportId: "report_invalid" }],
    ["all-zero local ID", { terminalReportId: `report_${"0".repeat(32)}` }],
    [
      "partial incident ID",
      { terminalReportId: LOCAL_REPORT_ID, terminalIncidentId: INCIDENT_ID },
    ],
    [
      "partial server run ID",
      { terminalReportId: LOCAL_REPORT_ID, terminalServerRunId: SERVER_RUN_ID },
    ],
    [
      "invalid incident ID",
      { terminalIncidentId: "incident_invalid", terminalServerRunId: SERVER_RUN_ID },
    ],
    [
      "invalid server run ID",
      { terminalIncidentId: INCIDENT_ID, terminalServerRunId: "run_invalid" },
    ],
    [
      "all-zero incident ID",
      {
        terminalIncidentId: `incident_${"0".repeat(32)}`,
        terminalServerRunId: SERVER_RUN_ID,
      },
    ],
    [
      "all-zero server run ID",
      {
        terminalIncidentId: INCIDENT_ID,
        terminalServerRunId: `run_${"0".repeat(32)}`,
      },
    ],
    [
      "explicit null server ID with a local receipt",
      {
        terminalReportId: LOCAL_REPORT_ID,
        terminalIncidentId: null,
        terminalServerRunId: undefined,
      },
    ],
  ])("rejects a receipt with %s", (_label, fields) => {
    expect(normalizeFailedTerminalReceipt({ ...BASE_RECEIPT, ...fields })).toBeNull();
  });

  it.each([
    [LOCAL_REPORT_ID, true],
    [`report_${"0".repeat(32)}`, false],
    [`report_${"A".repeat(32)}`, false],
    [`report_${"a".repeat(31)}`, false],
    [`report_${"a".repeat(33)}`, false],
    ["report_invalid", false],
    [null, false],
  ])("classifies local report ID %p", (value, expected) => {
    expect(isLocalReportId(value)).toBe(expected);
  });
});
