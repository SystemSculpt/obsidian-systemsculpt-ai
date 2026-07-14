import { Platform } from "obsidian";
import { cliCommandNode } from "../../../studio/nodes/cliCommandNode";
import { terminalNode } from "../../../studio/nodes/terminalNode";
import { textNode } from "../../../studio/nodes/textNode";
import { textOutputNode } from "../../../studio/nodes/textOutputNode";
import { textGenerationNode } from "../../../studio/nodes/textGenerationNode";
import {
  assertStudioNodeHostAvailable,
  collectStudioHostUnavailableNodes,
  formatStudioHostUnavailableNodesNotice,
  resolveStudioNodeHostAvailability,
} from "../../../studio/StudioHostCapabilities";
import { buildNodeInsertMenuItems, prettifyNodeKind } from "../StudioViewHelpers";

describe("buildNodeInsertMenuItems", () => {
  const platform = Platform as typeof Platform & { isDesktopApp: boolean };
  const definitions = [textNode, textOutputNode, terminalNode, textGenerationNode, cliCommandNode];

  beforeEach(() => {
    platform.isDesktopApp = true;
  });

  it("omits the dataflow studio.text_output node from the insert menu", () => {
    const items = buildNodeInsertMenuItems(definitions);

    expect(items.some((item) => item.definition.kind === "studio.text_output")).toBe(false);
  });

  it("keeps the legacy terminal node hidden", () => {
    const items = buildNodeInsertMenuItems(definitions);

    expect(items.some((item) => item.definition.kind === "studio.terminal")).toBe(false);
  });

  it("offers the visual text node under the Text display name", () => {
    const items = buildNodeInsertMenuItems(definitions);
    const textItem = items.find((item) => item.definition.kind === "studio.text");

    expect(textItem).toBeDefined();
    expect(textItem?.title).toBe("Text");
    expect(textItem?.summary.toLowerCase()).not.toContain("label");
  });

  it("keeps visible definitions with their display names and summaries", () => {
    const items = buildNodeInsertMenuItems(definitions);
    const generationItem = items.find(
      (item) => item.definition.kind === "studio.text_generation"
    );

    expect(generationItem?.title).toBe(prettifyNodeKind("studio.text_generation"));
    expect(generationItem?.summary.length).toBeGreaterThan(0);
  });

  it("keeps portable nodes available and omits local-machine nodes on mobile", () => {
    platform.isDesktopApp = false;

    const items = buildNodeInsertMenuItems(definitions);

    expect(items.some((item) => item.definition.kind === "studio.text_generation")).toBe(true);
    expect(items.some((item) => item.definition.kind === "studio.cli_command")).toBe(false);
    expect(resolveStudioNodeHostAvailability(textGenerationNode)).toEqual({
      available: true,
      reason: null,
    });
    expect(resolveStudioNodeHostAvailability(cliCommandNode)).toEqual({
      available: false,
      reason: "This node requires Obsidian Desktop.",
    });
    expect(() => assertStudioNodeHostAvailable(cliCommandNode)).toThrow(
      "studio.cli_command: This node requires Obsidian Desktop.",
    );
  });

  it("collects and formats desktop-only run blockers in project order", () => {
    platform.isDesktopApp = false;

    const blocked = collectStudioHostUnavailableNodes(
      {
        graph: {
          nodes: [
            { id: "one", kind: "studio.text_generation", title: "Portable Prompt" },
            { id: "two", kind: "studio.cli_command", title: "Shell Step" },
            { id: "three", kind: "studio.dataset", title: "Dataset Pull" },
          ],
        },
      } as any,
      (node) =>
        definitions.find((definition) => definition.kind === node.kind) as
          | typeof definitions[number]
          | null
    );

    expect(blocked).toEqual([
      {
        nodeId: "two",
        label: "Shell Step",
        kind: "studio.cli_command",
        reason: "This node requires Obsidian Desktop.",
      },
    ]);
    expect(
      formatStudioHostUnavailableNodesNotice([
        ...blocked,
        {
          nodeId: "three",
          label: "Dataset Pull",
          kind: "studio.dataset",
          reason: "This node requires Obsidian Desktop.",
        },
      ])
    ).toBe(
      "Desktop-only nodes: Shell Step (studio.cli_command), Dataset Pull (studio.dataset)."
    );
  });
});

describe("node display names", () => {
  it("names the visual text node Text and the dataflow text node Text Output", () => {
    expect(prettifyNodeKind("studio.text")).toBe("Text");
    expect(prettifyNodeKind("studio.text_output")).toBe("Text Output");
  });
});
