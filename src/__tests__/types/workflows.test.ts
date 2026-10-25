/**
 * @jest-environment node
 */
import {
  createDefaultWorkflowEngineSettings,
  type WorkflowEngineSettings,
} from "../../types/workflows";

describe("createDefaultWorkflowEngineSettings", () => {
  it("has enabled set to true", () => {
    const settings = createDefaultWorkflowEngineSettings();
    expect(settings.enabled).toBe(true);
  });

  it("has inboxRoutingEnabled set to true", () => {
    const settings = createDefaultWorkflowEngineSettings();
    expect(settings.inboxRoutingEnabled).toBe(true);
  });

  it("has default inbox folder", () => {
    const settings = createDefaultWorkflowEngineSettings();
    expect(settings.inboxFolder).toContain("Inbox");
  });

  it("has empty processedNotesFolder", () => {
    const settings = createDefaultWorkflowEngineSettings();
    expect(settings.processedNotesFolder).toBe("");
  });

  it("has autoTranscribeInboxNotes enabled", () => {
    const settings = createDefaultWorkflowEngineSettings();
    expect(settings.autoTranscribeInboxNotes).toBe(true);
  });

  it("starts with an empty transcription skip map", () => {
    const settings = createDefaultWorkflowEngineSettings();
    expect(settings.skippedFiles).toEqual({});
  });

  it("returns a new object each time", () => {
    const settings1 = createDefaultWorkflowEngineSettings();
    const settings2 = createDefaultWorkflowEngineSettings();
    expect(settings1).not.toBe(settings2);
    expect(settings1).toEqual(settings2);
  });
});

describe("WorkflowEngineSettings type", () => {
  it("can create custom settings", () => {
    const settings: WorkflowEngineSettings = {
      enabled: false,
      inboxRoutingEnabled: false,
      inboxFolder: "/custom/inbox",
      processedNotesFolder: "/processed",
      autoTranscribeInboxNotes: false,
      skippedFiles: {},
    };

    expect(settings.enabled).toBe(false);
    expect(settings.skippedFiles).toEqual({});
  });
});
