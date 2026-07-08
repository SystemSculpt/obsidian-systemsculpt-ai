import { terminalNode } from "../../../studio/nodes/terminalNode";
import { textNode } from "../../../studio/nodes/textNode";
import { textOutputNode } from "../../../studio/nodes/textOutputNode";
import { textGenerationNode } from "../../../studio/nodes/textGenerationNode";
import { buildNodeInsertMenuItems, prettifyNodeKind } from "../StudioViewHelpers";

describe("buildNodeInsertMenuItems", () => {
  const definitions = [textNode, textOutputNode, terminalNode, textGenerationNode];

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
});

describe("node display names", () => {
  it("names the visual text node Text and the dataflow text node Text Output", () => {
    expect(prettifyNodeKind("studio.text")).toBe("Text");
    expect(prettifyNodeKind("studio.text_output")).toBe("Text Output");
  });
});
