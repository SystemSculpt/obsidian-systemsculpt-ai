/**
 * @jest-environment node
 */
import {
  WORKFLOW_AUTOMATION_IDS,
  createDefaultWorkflowAutomationsState,
  createDefaultWorkflowEngineSettings,
  type WorkflowTrigger,
  type WorkflowCondition,
  type WorkflowStep,
  type WorkflowDefinition,
  type WorkflowAutomationState,
  type WorkflowEngineSettings,
  type WorkflowTriggerType,
  type WorkflowConditionType,
  type WorkflowStepType,
  type WorkflowTaskDestination,
} from "../../types/workflows";

describe("WORKFLOW_AUTOMATION_IDS", () => {
  it("has MEETING_TRANSCRIPT id", () => {
    expect(WORKFLOW_AUTOMATION_IDS.MEETING_TRANSCRIPT).toBe("meeting-transcript");
  });

  it("has WEB_CLIPPING id", () => {
    expect(WORKFLOW_AUTOMATION_IDS.WEB_CLIPPING).toBe("web-clipping");
  });

  it("has IDEA_DUMP id", () => {
    expect(WORKFLOW_AUTOMATION_IDS.IDEA_DUMP).toBe("idea-dump");
  });
});

describe("createDefaultWorkflowAutomationsState", () => {
  it("returns an object with all automation IDs", () => {
    const state = createDefaultWorkflowAutomationsState();
    expect(state[WORKFLOW_AUTOMATION_IDS.MEETING_TRANSCRIPT]).toBeDefined();
    expect(state[WORKFLOW_AUTOMATION_IDS.WEB_CLIPPING]).toBeDefined();
    expect(state[WORKFLOW_AUTOMATION_IDS.IDEA_DUMP]).toBeDefined();
  });

  it("meeting transcript has correct defaults", () => {
    const state = createDefaultWorkflowAutomationsState();
    const transcript = state[WORKFLOW_AUTOMATION_IDS.MEETING_TRANSCRIPT];

    expect(transcript.id).toBe(WORKFLOW_AUTOMATION_IDS.MEETING_TRANSCRIPT);
    expect(transcript.enabled).toBe(false);
    expect(transcript.sourceFolder).toContain("Transcripts");
    expect(transcript.destinationFolder).toContain("Meetings");
    expect(transcript.tasksDestination).toBe("central-note");
    expect(transcript.tasksNotePath).toContain("Central Tasks");
    expect(transcript.systemPrompt).toContain("meeting");
  });

  it("web clipping has correct defaults", () => {
    const state = createDefaultWorkflowAutomationsState();
    const clipping = state[WORKFLOW_AUTOMATION_IDS.WEB_CLIPPING];

    expect(clipping.id).toBe(WORKFLOW_AUTOMATION_IDS.WEB_CLIPPING);
    expect(clipping.enabled).toBe(false);
    expect(clipping.sourceFolder).toContain("Clippings");
    expect(clipping.destinationFolder).toContain("Web");
    expect(clipping.systemPrompt).toContain("clipping");
  });

  it("idea dump has correct defaults", () => {
    const state = createDefaultWorkflowAutomationsState();
    const idea = state[WORKFLOW_AUTOMATION_IDS.IDEA_DUMP];

    expect(idea.id).toBe(WORKFLOW_AUTOMATION_IDS.IDEA_DUMP);
    expect(idea.enabled).toBe(false);
    expect(idea.sourceFolder).toContain("Inbox");
    expect(idea.destinationFolder).toContain("Incubator");
    expect(idea.systemPrompt).toContain("idea");
  });

  it("returns a new object each time", () => {
    const state1 = createDefaultWorkflowAutomationsState();
    const state2 = createDefaultWorkflowAutomationsState();
    expect(state1).not.toBe(state2);
    expect(state1).toEqual(state2);
  });
});

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

  it("has central-note as task destination", () => {
    const settings = createDefaultWorkflowEngineSettings();
    expect(settings.taskDestination).toBe("central-note");
  });

  it("has default task note path", () => {
    const settings = createDefaultWorkflowEngineSettings();
    expect(settings.taskNotePath).toContain("Central Tasks");
  });

  it("has autoTranscribeInboxNotes enabled", () => {
    const settings = createDefaultWorkflowEngineSettings();
    expect(settings.autoTranscribeInboxNotes).toBe(true);
  });

  it("includes all default templates", () => {
    const settings = createDefaultWorkflowEngineSettings();
    expect(settings.templates[WORKFLOW_AUTOMATION_IDS.MEETING_TRANSCRIPT]).toBeDefined();
    expect(settings.templates[WORKFLOW_AUTOMATION_IDS.WEB_CLIPPING]).toBeDefined();
    expect(settings.templates[WORKFLOW_AUTOMATION_IDS.IDEA_DUMP]).toBeDefined();
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

  it("can create apply-template step with config", () => {
    const step: WorkflowStep = {
      id: "step-2",
      type: "apply-template",
      label: "Apply meeting template",
      config: {
        templatePath: "/templates/meeting.md",
      },
    };
    expect(step.type).toBe("apply-template");
    expect(step.config?.templatePath).toBe("/templates/meeting.md");
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
      name: "Meeting Processor",
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
      description: "Process meeting transcripts automatically",
    };

    expect(workflow.id).toBe("workflow-1");
    expect(workflow.name).toBe("Meeting Processor");
    expect(workflow.trigger.type).toBe("folder");
    expect(workflow.conditions).toHaveLength(1);
    expect(workflow.steps).toHaveLength(3);
    expect(workflow.description).toContain("meeting");
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

describe("WorkflowAutomationState type", () => {
  it("can create minimal state", () => {
    const state: WorkflowAutomationState = {
      id: "auto-1",
      enabled: true,
    };

    expect(state.id).toBe("auto-1");
    expect(state.enabled).toBe(true);
    expect(state.sourceFolder).toBeUndefined();
  });

  it("can create full state", () => {
    const state: WorkflowAutomationState = {
      id: "auto-2",
      enabled: false,
      sourceFolder: "/source",
      destinationFolder: "/dest",
      tasksDestination: "daily-note",
      tasksNotePath: "/daily.md",
      metadata: { key: "value" },
      systemPrompt: "Process this note",
    };

    expect(state.sourceFolder).toBe("/source");
    expect(state.tasksDestination).toBe("daily-note");
    expect(state.metadata?.key).toBe("value");
    expect(state.systemPrompt).toBe("Process this note");
  });
});

describe("WorkflowEngineSettings type", () => {
  it("can create custom settings", () => {
    const settings: WorkflowEngineSettings = {
      enabled: false,
      inboxRoutingEnabled: false,
      inboxFolder: "/custom/inbox",
      processedNotesFolder: "/processed",
      taskDestination: "daily-note",
      taskNotePath: "/daily/tasks.md",
      autoTranscribeInboxNotes: false,
      templates: {},
    };

    expect(settings.enabled).toBe(false);
    expect(settings.taskDestination).toBe("daily-note");
    expect(settings.templates).toEqual({});
  });
});
