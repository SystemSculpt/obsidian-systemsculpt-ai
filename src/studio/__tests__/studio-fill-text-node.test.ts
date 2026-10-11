import { readStudioFillTextLook, studioFillTextLookConfig } from "../StudioFillTextNode";

describe("fill text node look", () => {
  it("is plain, centred and uncoloured until the config says otherwise", () => {
    expect(readStudioFillTextLook({ layout: "fill", value: "Hi" })).toEqual({
      style: "plain",
      align: "center",
      color: null,
    });
  });

  it("reads a saved style, alignment and colour, tidied the way image captions are", () => {
    expect(readStudioFillTextLook({ textStyle: "meme", textAlign: "left", textColor: "#FF3B30" })).toEqual({
      style: "meme",
      align: "left",
      color: "#ff3b30",
    });
    expect(readStudioFillTextLook({ textStyle: " Banner ", textAlign: "RIGHT", textColor: " #abc " })).toEqual({
      style: "banner",
      align: "right",
      color: "#abc",
    });
  });

  it("ignores values it does not know", () => {
    expect(readStudioFillTextLook({ textStyle: "comic", textAlign: "justify", textColor: "red" })).toEqual({
      style: "plain",
      align: "center",
      color: null,
    });
    expect(readStudioFillTextLook({ textStyle: 3, textAlign: null, textColor: "" })).toEqual({
      style: "plain",
      align: "center",
      color: null,
    });
  });

  it("saves a change under the keys it is read from", () => {
    const config: Record<string, unknown> = {};
    for (const [key, value] of studioFillTextLookConfig({ style: "outline", align: "right", color: "#0a84ff" })) {
      config[key] = value;
    }

    expect(config).toEqual({ textStyle: "outline", textAlign: "right", textColor: "#0a84ff" });
    expect(readStudioFillTextLook(config)).toEqual({ style: "outline", align: "right", color: "#0a84ff" });
  });

  it("saves only what changed, and no colour of its own as an empty value", () => {
    expect(studioFillTextLookConfig({ align: "left" })).toEqual([["textAlign", "left"]]);
    expect(studioFillTextLookConfig({ color: null })).toEqual([["textColor", ""]]);
    expect(readStudioFillTextLook({ textColor: "" }).color).toBeNull();
    expect(studioFillTextLookConfig({})).toEqual([]);
  });
});
