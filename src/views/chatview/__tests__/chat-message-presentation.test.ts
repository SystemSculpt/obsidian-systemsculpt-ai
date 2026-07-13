import { presentMessageContent } from "../ChatMessagePresentation";

describe("presentMessageContent", () => {
  it("keeps mixed images and text while preserving their order-independent labels", () => {
    const presented = presentMessageContent([
      { type: "text", text: "Compare these references." },
      { type: "image_url", image_url: { url: "data:image/png;base64,one" } },
      { type: "image_url", image_url: { url: "data:image/webp;base64,two" } },
    ]);
    expect(presented).toEqual({
      markdown: "Compare these references.",
      attachments: [
        { kind: "image", label: "Attached image 1", url: "data:image/png;base64,one" },
        { kind: "image", label: "Attached image 2", url: "data:image/webp;base64,two" },
      ],
    });
  });

  it("presents attached text files as compact files without echoing their payload", () => {
    const presented = presentMessageContent([{ type: "text", text: [
      "--- BEGIN ATTACHED FILE: data.csv (text/csv) ---",
      "secret,large,payload",
      "--- END ATTACHED FILE: data.csv ---",
    ].join("\n") }]);
    expect(presented.markdown).toBe("");
    expect(presented.attachments).toEqual([{ kind: "file", label: "data.csv", mimeType: "text/csv" }]);
  });

  it("marks unavailable hydrated attachments explicitly", () => {
    const presented = presentMessageContent([{ type: "text", text: [
      "--- BEGIN ATTACHED FILE: diagram.png (image/png) ---",
      "[[SYSTEMSCULPT_ATTACHMENT_UNAVAILABLE]]",
      "--- END ATTACHED FILE: diagram.png ---",
    ].join("\n") }]);
    expect(presented).toEqual({
      markdown: "",
      attachments: [{ kind: "file", label: "diagram.png", mimeType: "image/png", unavailable: true }],
    });
  });
});
