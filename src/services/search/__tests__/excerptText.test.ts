import { markdownExcerptText } from "../excerptText";

describe("markdownExcerptText", () => {
  it("shows the words without Markdown and keeps a heading apart from the sentence after it", () => {
    expect(markdownExcerptText("## Where the ferry crossed\nThe old crossing ran over the creek."))
      .toBe("Where the ferry crossed · The old crossing ran over the creek.");
    expect(markdownExcerptText("**Distance:** 1.5 miles · **Time:** about 45 minutes"))
      .toBe("Distance: 1.5 miles · Time: about 45 minutes");
    expect(markdownExcerptText("- [ ] Ask [[Harbourmaster — Ines|Ines]] about the *tide* board\n- [x] Book `lifeboat` station"))
      .toBe("Ask Ines about the tide board · Book lifeboat station");
    expect(markdownExcerptText("> [!info|systemsculpt] Audio note\n> See [the map](https://example.com) ^audio-seg-000007"))
      .toBe("Audio note · See the map");
    expect(markdownExcerptText("A soft\nwrapped line\n\nNext paragraph")).toBe("A soft wrapped line · Next paragraph");
  });

  it("leaves snake_case, maths and plain text alone", () => {
    expect(markdownExcerptText("Set max_tokens to 2 * 3 * 4")).toBe("Set max_tokens to 2 * 3 * 4");
    expect(markdownExcerptText("Plain words.")).toBe("Plain words.");
  });
});
