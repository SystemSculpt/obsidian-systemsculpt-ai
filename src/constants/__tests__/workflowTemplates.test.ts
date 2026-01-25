/**
 * @jest-environment node
 */
import {
  WORKFLOW_AUTOMATIONS,
  WorkflowAutomationDefinition,
} from "../workflowTemplates";

describe("WORKFLOW_AUTOMATIONS", () => {
  it("is a non-empty array", () => {
    expect(Array.isArray(WORKFLOW_AUTOMATIONS)).toBe(true);
    expect(WORKFLOW_AUTOMATIONS.length).toBeGreaterThan(0);
  });

  it("contains 3 workflow automations", () => {
    expect(WORKFLOW_AUTOMATIONS.length).toBe(3);
  });

  describe("all workflows have required properties", () => {
    it.each(WORKFLOW_AUTOMATIONS)("$id has all required properties", (workflow) => {
      expect(workflow.id).toBeDefined();
      expect(typeof workflow.id).toBe("string");
      expect(workflow.title).toBeDefined();
      expect(typeof workflow.title).toBe("string");
      expect(workflow.subtitle).toBeDefined();
      expect(typeof workflow.subtitle).toBe("string");
      expect(workflow.description).toBeDefined();
      expect(typeof workflow.description).toBe("string");
      expect(workflow.icon).toBeDefined();
      expect(typeof workflow.icon).toBe("string");
      expect(workflow.capturePlaceholder).toBeDefined();
      expect(typeof workflow.capturePlaceholder).toBe("string");
      expect(workflow.destinationPlaceholder).toBeDefined();
      expect(typeof workflow.destinationPlaceholder).toBe("string");
    });
  });

  describe("meeting-transcript workflow", () => {
    const workflow = WORKFLOW_AUTOMATIONS.find((w) => w.id === "meeting-transcript");

    it("exists", () => {
      expect(workflow).toBeDefined();
    });

    it("has correct id", () => {
      expect(workflow?.id).toBe("meeting-transcript");
    });

    it("has title about meeting transcripts", () => {
      expect(workflow?.title.toLowerCase()).toContain("meeting");
      expect(workflow?.title.toLowerCase()).toContain("transcript");
    });

    it("has mic icon", () => {
      expect(workflow?.icon).toBe("mic-2");
    });

    it("has capture placeholder containing Transcripts", () => {
      expect(workflow?.capturePlaceholder).toContain("Transcripts");
    });

    it("has destination placeholder containing Meetings", () => {
      expect(workflow?.destinationPlaceholder).toContain("Meetings");
    });

    it("description mentions summarize or decisions", () => {
      const desc = workflow?.description.toLowerCase() || "";
      expect(desc.includes("summarize") || desc.includes("decisions")).toBe(true);
    });
  });

  describe("web-clipping workflow", () => {
    const workflow = WORKFLOW_AUTOMATIONS.find((w) => w.id === "web-clipping");

    it("exists", () => {
      expect(workflow).toBeDefined();
    });

    it("has correct id", () => {
      expect(workflow?.id).toBe("web-clipping");
    });

    it("has title about web clipping", () => {
      expect(workflow?.title.toLowerCase()).toContain("web");
      expect(workflow?.title.toLowerCase()).toContain("clipping");
    });

    it("has globe icon", () => {
      expect(workflow?.icon).toBe("globe");
    });

    it("has capture placeholder containing Clippings", () => {
      expect(workflow?.capturePlaceholder).toContain("Clippings");
    });

    it("has destination placeholder containing Web", () => {
      expect(workflow?.destinationPlaceholder).toContain("Web");
    });
  });

  describe("idea-dump workflow", () => {
    const workflow = WORKFLOW_AUTOMATIONS.find((w) => w.id === "idea-dump");

    it("exists", () => {
      expect(workflow).toBeDefined();
    });

    it("has correct id", () => {
      expect(workflow?.id).toBe("idea-dump");
    });

    it("has title about ideas", () => {
      expect(workflow?.title.toLowerCase()).toContain("idea");
    });

    it("has lightbulb icon", () => {
      expect(workflow?.icon).toBe("lightbulb");
    });

    it("has capture placeholder containing Inbox", () => {
      expect(workflow?.capturePlaceholder).toContain("Inbox");
    });

    it("has destination placeholder containing Incubator", () => {
      expect(workflow?.destinationPlaceholder).toContain("Incubator");
    });
  });

  describe("workflow IDs are unique", () => {
    it("has no duplicate IDs", () => {
      const ids = WORKFLOW_AUTOMATIONS.map((w) => w.id);
      const uniqueIds = [...new Set(ids)];
      expect(uniqueIds.length).toBe(ids.length);
    });
  });

  describe("WorkflowAutomationDefinition interface", () => {
    it("can create a workflow definition", () => {
      const workflow: WorkflowAutomationDefinition = {
        id: "custom-workflow",
        title: "Custom Workflow",
        subtitle: "Custom subtitle",
        description: "Custom description",
        icon: "star",
        capturePlaceholder: "/capture",
        destinationPlaceholder: "/destination",
      };

      expect(workflow.id).toBe("custom-workflow");
      expect(workflow.title).toBe("Custom Workflow");
    });
  });
});
