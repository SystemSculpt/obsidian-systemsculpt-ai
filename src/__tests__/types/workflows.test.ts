/**
 * @jest-environment node
 */
import {
  createDefaultWorkflowEngineSettings,
  type WorkflowTrigger,
  type WorkflowCondition,
  type WorkflowStep,
  type WorkflowDefinition,
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

describe("WorkflowTrigger type", () => {
  it("can create folder trigger", () => {
    const trigger: WorkflowTrigger = {
      type: "folder",
      value: "/inbox",
    };
    expect(trigger.type).toBe("folder");
    expect(trigger.value).toBe("/inbox");
  });

  it("can create tag trigger", () => {
    const trigger: WorkflowTrigger = {
      type: "tag",
      value: "#process",
      description: "Process tagged notes",
    };
    expect(trigger.type).toBe("tag");
    expect(trigger.description).toBe("Process tagged notes");
  });

  it("can create command trigger", () => {
    const trigger: WorkflowTrigger = {
      type: "command",
      value: "run-workflow",
    };
    expect(trigger.type).toBe("command");
  });
});

describe("WorkflowCondition type", () => {
  it("can create folderRegex condition", () => {
    const condition: WorkflowCondition = {
      type: "folderRegex",
      value: "^inbox/.*",
    };
    expect(condition.type).toBe("folderRegex");
  });

  it("can create tag condition", () => {
    const condition: WorkflowCondition = {
      type: "tag",
      value: "meeting",
      description: "Must have meeting tag",
    };
    expect(condition.type).toBe("tag");
  });

  it("can create frontmatter condition", () => {
    const condition: WorkflowCondition = {
      type: "frontmatter",
      value: "status: draft",
    };
    expect(condition.type).toBe("frontmatter");
  });
});

describe("WorkflowStep type", () => {
  it("can create route-note step", () => {
    const step: WorkflowStep = {
      id: "step-1",
      type: "route-note",
      label: "Route to projects",
    };
    expect(step.type).toBe("route-note");
    expect(step.config).toBeUndefined();
  });

  it("can create write-note step with config", () => {
    const step: WorkflowStep = {
      id: "step-2",
      type: "write-note",
      label: "Write audio note",
      config: {
        targetPath: "/processed/meeting.md",
      },
    };
    expect(step.type).toBe("write-note");
    expect(step.config?.targetPath).toBe("/processed/meeting.md");
  });

  it("can create ai-preset step", () => {
    const step: WorkflowStep = {
      id: "step-3",
      type: "ai-preset",
      label: "Summarize with AI",
      config: {
        prompt: "Summarize this note",
        model: "gpt-4",
      },
    };
    expect(step.type).toBe("ai-preset");
    expect(step.config?.prompt).toBe("Summarize this note");
  });

  it("can create extract-tasks step", () => {
    const step: WorkflowStep = {
      id: "step-4",
      type: "extract-tasks",
      label: "Extract action items",
    };
    expect(step.type).toBe("extract-tasks");
  });
});

describe("WorkflowDefinition type", () => {
  it("can create a complete workflow", () => {
    const workflow: WorkflowDefinition = {
      id: "workflow-1",
      name: "Audio Processor",
      trigger: {
        type: "folder",
        value: "/inbox/meetings",
      },
      conditions: [
        { type: "tag", value: "meeting" },
      ],
      steps: [
        { id: "s1", type: "ai-preset", label: "Summarize" },
        { id: "s2", type: "extract-tasks", label: "Extract tasks" },
        { id: "s3", type: "route-note", label: "Move to archive" },
      ],
      description: "Process audio transcripts automatically",
    };

    expect(workflow.id).toBe("workflow-1");
    expect(workflow.name).toBe("Audio Processor");
    expect(workflow.trigger.type).toBe("folder");
    expect(workflow.conditions).toHaveLength(1);
    expect(workflow.steps).toHaveLength(3);
    expect(workflow.description).toContain("audio");
  });

  it("can create workflow without conditions", () => {
    const workflow: WorkflowDefinition = {
      id: "workflow-2",
      name: "Simple Workflow",
      trigger: { type: "command", value: "run" },
      steps: [{ id: "s1", type: "write-note", label: "Write output" }],
    };

    expect(workflow.conditions).toBeUndefined();
    expect(workflow.description).toBeUndefined();
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
