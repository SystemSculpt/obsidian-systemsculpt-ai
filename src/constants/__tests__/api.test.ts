/**
 * @jest-environment node
 */
import {
  DEVELOPMENT_MODE,
  getServerUrl,
  API_BASE_URL,
  SYSTEMSCULPT_API_ENDPOINTS,
  SYSTEMSCULPT_API_HEADERS,
} from "../api";

describe("DEVELOPMENT_MODE", () => {
  it("is set to PRODUCTION", () => {
    expect(DEVELOPMENT_MODE).toBe("PRODUCTION");
  });
});

describe("getServerUrl", () => {
  it("returns production URL in production mode", () => {
    const result = getServerUrl(
      "https://api.example.com",
      "http://localhost:3000"
    );
    // Since DEVELOPMENT_MODE is PRODUCTION
    expect(result).toBe("https://api.example.com");
  });
});

describe("API_BASE_URL", () => {
  it("uses production API URL", () => {
    expect(API_BASE_URL).toBe("https://api.systemsculpt.com/api/v1");
  });
});

describe("SYSTEMSCULPT_API_ENDPOINTS", () => {
  describe("PLUGINS", () => {
    it("builds LATEST endpoint with plugin ID", () => {
      const endpoint = SYSTEMSCULPT_API_ENDPOINTS.PLUGINS.LATEST("my-plugin");
      expect(endpoint).toBe("/plugins/my-plugin/latest");
    });

    it("builds RELEASES endpoint with plugin ID", () => {
      const endpoint = SYSTEMSCULPT_API_ENDPOINTS.PLUGINS.RELEASES("my-plugin");
      expect(endpoint).toBe("/plugins/my-plugin/releases");
    });
  });

  describe("LICENSE", () => {
    it("returns VALIDATE endpoint", () => {
      const endpoint = SYSTEMSCULPT_API_ENDPOINTS.LICENSE.VALIDATE();
      expect(endpoint).toBe("/license/validate");
    });
  });

  describe("MODELS", () => {
    it("has LIST endpoint", () => {
      expect(SYSTEMSCULPT_API_ENDPOINTS.MODELS.LIST).toBe("/models");
    });

    it("builds GET endpoint with model ID", () => {
      const endpoint = SYSTEMSCULPT_API_ENDPOINTS.MODELS.GET("gpt-4");
      expect(endpoint).toBe("/models/gpt-4");
    });
  });

  describe("AGENT", () => {
    it("has BASE endpoint", () => {
      expect(SYSTEMSCULPT_API_ENDPOINTS.AGENT.BASE).toBe("/api/v2/agent");
    });

    it("has SESSIONS endpoint", () => {
      expect(SYSTEMSCULPT_API_ENDPOINTS.AGENT.SESSIONS).toBe("/api/v2/agent/sessions");
    });

    it("builds SESSION_TURNS endpoint", () => {
      expect(SYSTEMSCULPT_API_ENDPOINTS.AGENT.SESSION_TURNS("sess_1")).toBe(
        "/api/v2/agent/sessions/sess_1/turns"
      );
    });

    it("builds SESSION_TOOL_RESULTS endpoint", () => {
      expect(SYSTEMSCULPT_API_ENDPOINTS.AGENT.SESSION_TOOL_RESULTS("sess_1")).toBe(
        "/api/v2/agent/sessions/sess_1/tool-results"
      );
    });

    it("builds SESSION_CONTINUE endpoint", () => {
      expect(SYSTEMSCULPT_API_ENDPOINTS.AGENT.SESSION_CONTINUE("sess_1")).toBe(
        "/api/v2/agent/sessions/sess_1/continue"
      );
    });
  });

  describe("EMBEDDINGS", () => {
    it("has GENERATE endpoint", () => {
      expect(SYSTEMSCULPT_API_ENDPOINTS.EMBEDDINGS.GENERATE).toBe("/embeddings");
    });
  });

  describe("SYSTEM_PROMPTS", () => {
    it("builds GET endpoint with ID", () => {
      const endpoint = SYSTEMSCULPT_API_ENDPOINTS.SYSTEM_PROMPTS.GET("prompt-1");
      expect(endpoint).toBe("/system-prompts/prompt-1");
    });

    it("has LIST endpoint", () => {
      expect(SYSTEMSCULPT_API_ENDPOINTS.SYSTEM_PROMPTS.LIST).toBe("/system-prompts");
    });
  });

  describe("DOCUMENTS", () => {
    it("has PROCESS endpoint", () => {
      expect(SYSTEMSCULPT_API_ENDPOINTS.DOCUMENTS.PROCESS).toBe("/documents/process");
    });

    it("builds GET endpoint with document ID", () => {
      const endpoint = SYSTEMSCULPT_API_ENDPOINTS.DOCUMENTS.GET("doc-123");
      expect(endpoint).toBe("/documents/doc-123");
    });

    it("builds DOWNLOAD endpoint with document ID", () => {
      const endpoint = SYSTEMSCULPT_API_ENDPOINTS.DOCUMENTS.DOWNLOAD("doc-123");
      expect(endpoint).toBe("/documents/doc-123/download");
    });
  });
});

describe("SYSTEMSCULPT_API_HEADERS", () => {
  describe("DEFAULT", () => {
    it("has Content-Type header", () => {
      expect(SYSTEMSCULPT_API_HEADERS.DEFAULT["Content-Type"]).toBe("application/json");
    });

    it("has Accept header", () => {
      expect(SYSTEMSCULPT_API_HEADERS.DEFAULT.Accept).toBe("application/json");
    });

    it("has X-SystemSculpt-Client header", () => {
      expect(SYSTEMSCULPT_API_HEADERS.DEFAULT["X-SystemSculpt-Client"]).toBe("obsidian-plugin");
    });
  });

  describe("WITH_LICENSE", () => {
    it("includes default headers", () => {
      const headers = SYSTEMSCULPT_API_HEADERS.WITH_LICENSE("my-license-key");
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers.Accept).toBe("application/json");
      expect(headers["X-SystemSculpt-Client"]).toBe("obsidian-plugin");
    });

    it("adds license key header", () => {
      const headers = SYSTEMSCULPT_API_HEADERS.WITH_LICENSE("my-license-key");
      expect(headers["x-license-key"]).toBe("my-license-key");
    });

    it("works with empty license key", () => {
      const headers = SYSTEMSCULPT_API_HEADERS.WITH_LICENSE("");
      expect(headers["x-license-key"]).toBe("");
    });
  });
});
