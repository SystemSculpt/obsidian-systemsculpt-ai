/**
 * @jest-environment node
 */
import {
  GITHUB_API,
  AI_PROVIDERS,
  LOCAL_SERVICES,
  SYSTEMSCULPT_WEBSITE,
  MCP_DOCS,
  SERVICE_HEADERS,
} from "../externalServices";

describe("GITHUB_API", () => {
  it("has correct base URL", () => {
    expect(GITHUB_API.BASE_URL).toBe("https://api.github.com");
  });

  it("builds correct releases URL", () => {
    const releasesUrl = GITHUB_API.RELEASES("SystemSculpt", "obsidian-plugin");
    expect(releasesUrl).toBe(
      "https://api.github.com/repos/SystemSculpt/obsidian-plugin/releases"
    );
  });

  it("builds correct release page URL", () => {
    const releaseUrl = GITHUB_API.RELEASE_URL("SystemSculpt", "obsidian-plugin");
    expect(releaseUrl).toBe(
      "https://github.com/SystemSculpt/obsidian-plugin/releases"
    );
  });
});

describe("AI_PROVIDERS", () => {
  describe("OPENAI", () => {
    it("has correct base URL", () => {
      expect(AI_PROVIDERS.OPENAI.BASE_URL).toBe("https://api.openai.com/v1");
    });

    it("has correct audio transcriptions URL", () => {
      expect(AI_PROVIDERS.OPENAI.AUDIO_TRANSCRIPTIONS).toBe(
        "https://api.openai.com/v1/audio/transcriptions"
      );
    });
  });

  describe("ANTHROPIC", () => {
    it("has correct base URL", () => {
      expect(AI_PROVIDERS.ANTHROPIC.BASE_URL).toBe("https://api.anthropic.com/v1");
    });

    it("has correct legacy base URL", () => {
      expect(AI_PROVIDERS.ANTHROPIC.LEGACY_BASE).toBe("https://api.anthropic.com");
    });
  });

  describe("OPENROUTER", () => {
    it("has correct base URL", () => {
      expect(AI_PROVIDERS.OPENROUTER.BASE_URL).toBe("https://openrouter.ai/api/v1");
    });

    it("has correct chat completions URL", () => {
      expect(AI_PROVIDERS.OPENROUTER.CHAT_COMPLETIONS).toBe(
        "https://openrouter.ai/api/v1/chat/completions"
      );
    });

    it("has correct models URL", () => {
      expect(AI_PROVIDERS.OPENROUTER.MODELS).toBe(
        "https://openrouter.ai/api/v1/models"
      );
    });
  });

  describe("MINIMAX", () => {
    it("has correct base URL", () => {
      expect(AI_PROVIDERS.MINIMAX.BASE_URL).toBe("https://api.minimax.io/v1");
    });
  });

  describe("MOONSHOT", () => {
    it("has correct base URL", () => {
      expect(AI_PROVIDERS.MOONSHOT.BASE_URL).toBe("https://api.moonshot.ai/v1");
    });
  });

  describe("GROQ", () => {
    it("has correct base URL", () => {
      expect(AI_PROVIDERS.GROQ.BASE_URL).toBe("https://api.groq.com/openai/v1");
    });

    it("has correct audio transcriptions URL", () => {
      expect(AI_PROVIDERS.GROQ.AUDIO_TRANSCRIPTIONS).toBe(
        "https://api.groq.com/openai/v1/audio/transcriptions"
      );
    });
  });
});

describe("LOCAL_SERVICES", () => {
  describe("OLLAMA", () => {
    it("has localhost base URL", () => {
      expect(LOCAL_SERVICES.OLLAMA.BASE_URL).toBe("http://localhost:11434/v1");
    });
  });

  describe("LM_STUDIO", () => {
    it("has localhost base URL", () => {
      expect(LOCAL_SERVICES.LM_STUDIO.BASE_URL).toBe("http://localhost:1234/v1");
    });
  });

  describe("LOCAL_AI", () => {
    it("has correct chat completions URL", () => {
      expect(LOCAL_SERVICES.LOCAL_AI.CHAT_COMPLETIONS).toBe(
        "http://localhost:8000/v1/chat/completions"
      );
    });

    it("has correct models URL", () => {
      expect(LOCAL_SERVICES.LOCAL_AI.MODELS).toBe(
        "http://localhost:8000/v1/models"
      );
    });
  });

  describe("LOCAL_WHISPER", () => {
    it("has correct audio transcriptions URL", () => {
      expect(LOCAL_SERVICES.LOCAL_WHISPER.AUDIO_TRANSCRIPTIONS).toBe(
        "http://localhost:9000/v1/audio/transcriptions"
      );
    });
  });
});

describe("SYSTEMSCULPT_WEBSITE", () => {
  it("has correct base URL", () => {
    expect(SYSTEMSCULPT_WEBSITE.BASE_URL).toBe("https://systemsculpt.com");
  });

  it("has correct lifetime URL", () => {
    expect(SYSTEMSCULPT_WEBSITE.LIFETIME).toBe("https://systemsculpt.com/lifetime");
  });

  it("has correct docs URL", () => {
    expect(SYSTEMSCULPT_WEBSITE.DOCS).toBe("https://systemsculpt.com/docs");
  });

  it("has correct support URL", () => {
    expect(SYSTEMSCULPT_WEBSITE.SUPPORT).toBe("https://systemsculpt.com/contact");
  });

  it("has correct license URL", () => {
    expect(SYSTEMSCULPT_WEBSITE.LICENSE).toContain("resources");
    expect(SYSTEMSCULPT_WEBSITE.LICENSE).toContain("license");
  });

  it("has correct feedback URL pointing to GitHub issues", () => {
    expect(SYSTEMSCULPT_WEBSITE.FEEDBACK).toContain("github.com");
    expect(SYSTEMSCULPT_WEBSITE.FEEDBACK).toContain("issues/new");
  });
});

describe("MCP_DOCS", () => {
  it("has correct base URL", () => {
    expect(MCP_DOCS.BASE_URL).toBe("https://modelcontextprotocol.io");
  });
});

describe("SERVICE_HEADERS", () => {
  describe("OPENROUTER", () => {
    it("has correct HTTP-Referer header", () => {
      expect(SERVICE_HEADERS.OPENROUTER["HTTP-Referer"]).toBe(
        SYSTEMSCULPT_WEBSITE.BASE_URL
      );
    });

    it("has correct X-Title header", () => {
      expect(SERVICE_HEADERS.OPENROUTER["X-Title"]).toBe("SystemSculpt AI");
    });
  });
});
