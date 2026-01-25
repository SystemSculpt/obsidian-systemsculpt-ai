describe("SystemSculptProvider request sanitization", () => {
  let requestUrlMock: jest.Mock;

  beforeEach(async () => {
    jest.resetModules();

    const obsidian = await import("obsidian");
    requestUrlMock = obsidian.requestUrl as jest.Mock;
    requestUrlMock.mockReset();
  });

  it("sanitizes suspicious payloads so the request body avoids WAF-trigger keywords", async () => {
    requestUrlMock.mockImplementation(async (req: any) => {
      const body = String(req?.body || "");
      if (/phpunit/i.test(body)) {
        return { status: 403, text: "<html><body>Forbidden</body></html>", headers: { "content-type": "text/html" } };
      }
      return {
        status: 200,
        text: JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }),
        headers: { "content-type": "application/json" },
      };
    });

    const { SystemSculptProvider } = await import("../embeddings/providers/SystemSculptProvider");
    const provider = new SystemSculptProvider("fake-license", "https://api.systemsculpt.com/api/v1");

    const embeddings = await provider.generateEmbeddings(["This contains phpunit and should be sanitized."]);
    expect(embeddings).toEqual([[0.1, 0.2, 0.3]]);

    const call = requestUrlMock.mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    expect(String(call.body)).not.toMatch(/phpunit/i);
  });

  it("redacts high-entropy blobs (e.g. long base64 strings) to reduce WAF false positives", async () => {
    const blob = `${"A".repeat(210)}==`;

    requestUrlMock.mockImplementation(async (req: any) => {
      const body = String(req?.body || "");
      if (/[A-Za-z0-9+/]{200,}={0,2}/.test(body)) {
        return { status: 403, text: "<html><body>Forbidden</body></html>", headers: { "content-type": "text/html" } };
      }
      return {
        status: 200,
        text: JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }),
        headers: { "content-type": "application/json" },
      };
    });

    const { SystemSculptProvider } = await import("../embeddings/providers/SystemSculptProvider");
    const provider = new SystemSculptProvider("fake-license", "https://api.systemsculpt.com/api/v1");

    const embeddings = await provider.generateEmbeddings([`This contains a blob ${blob} and should be redacted.`]);
    expect(embeddings).toEqual([[0.1, 0.2, 0.3]]);

    const call = requestUrlMock.mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    const sentBody = String(call.body);
    expect(sentBody).not.toContain(blob);
    expect(sentBody).toMatch(/\[base64:\d+\]/);
  });

	  it("redacts PEM blocks (private keys/certificates) to reduce WAF false positives", async () => {
	    const pemType = "RSA " + "PRIVATE KEY";
	    const pemBlock = `-----BEGIN ${pemType}-----\n${"A".repeat(64)}\n-----END ${pemType}-----`;

	    requestUrlMock.mockImplementation(async (req: any) => {
	      const body = String(req?.body || "");
	      if (new RegExp("BEGIN RSA " + "PRIVATE KEY", "i").test(body)) {
	        return { status: 403, text: "<html><body>Forbidden</body></html>", headers: { "content-type": "text/html" } };
	      }
	      return {
	        status: 200,
        text: JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }),
        headers: { "content-type": "application/json" },
      };
    });

    const { SystemSculptProvider } = await import("../embeddings/providers/SystemSculptProvider");
    const provider = new SystemSculptProvider("fake-license", "https://api.systemsculpt.com/api/v1");

    const embeddings = await provider.generateEmbeddings([`This contains a PEM block:\n\n${pemBlock}\n\nand should be redacted.`]);
    expect(embeddings).toEqual([[0.1, 0.2, 0.3]]);

	    const call = requestUrlMock.mock.calls[0]?.[0];
	    expect(call).toBeTruthy();
	    const sentBody = String(call.body);
	    expect(sentBody).not.toContain("BEGIN RSA " + "PRIVATE KEY");
	    expect(sentBody).toMatch(/\[pem:\d+\]/);
	  });

  it("sanitizes curl commands to avoid WAF trigger", async () => {
    requestUrlMock.mockImplementation(async (req: any) => {
      const body = String(req?.body || "");
      if (/\bcurl\b/i.test(body)) {
        return { status: 403, text: "<html><body>Forbidden</body></html>", headers: { "content-type": "text/html" } };
      }
      return {
        status: 200,
        text: JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }),
        headers: { "content-type": "application/json" },
      };
    });

    const { SystemSculptProvider } = await import("../embeddings/providers/SystemSculptProvider");
    const provider = new SystemSculptProvider("fake-license", "https://api.systemsculpt.com/api/v1");

    const embeddings = await provider.generateEmbeddings(["Run curl https://example.com to fetch data."]);
    expect(embeddings).toEqual([[0.1, 0.2, 0.3]]);

    const call = requestUrlMock.mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    expect(String(call.body)).not.toMatch(/\bcurl\b/i);
    expect(String(call.body)).toContain("http client");
  });

  it("sanitizes wget commands to avoid WAF trigger", async () => {
    requestUrlMock.mockImplementation(async (req: any) => {
      const body = String(req?.body || "");
      if (/\bwget\b/i.test(body)) {
        return { status: 403, text: "<html><body>Forbidden</body></html>", headers: { "content-type": "text/html" } };
      }
      return {
        status: 200,
        text: JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }),
        headers: { "content-type": "application/json" },
      };
    });

    const { SystemSculptProvider } = await import("../embeddings/providers/SystemSculptProvider");
    const provider = new SystemSculptProvider("fake-license", "https://api.systemsculpt.com/api/v1");

    const embeddings = await provider.generateEmbeddings(["Use wget to download the file."]);
    expect(embeddings).toEqual([[0.1, 0.2, 0.3]]);

    const call = requestUrlMock.mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    expect(String(call.body)).not.toMatch(/\bwget\b/i);
    expect(String(call.body)).toContain("downloader");
  });

  it("sanitizes CVE identifiers to avoid WAF trigger", async () => {
    requestUrlMock.mockImplementation(async (req: any) => {
      const body = String(req?.body || "");
      if (/CVE-\d{4}-\d+/i.test(body)) {
        return { status: 403, text: "<html><body>Forbidden</body></html>", headers: { "content-type": "text/html" } };
      }
      return {
        status: 200,
        text: JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }),
        headers: { "content-type": "application/json" },
      };
    });

    const { SystemSculptProvider } = await import("../embeddings/providers/SystemSculptProvider");
    const provider = new SystemSculptProvider("fake-license", "https://api.systemsculpt.com/api/v1");

    const embeddings = await provider.generateEmbeddings(["This document references CVE-2023-12345."]);
    expect(embeddings).toEqual([[0.1, 0.2, 0.3]]);

    const call = requestUrlMock.mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    expect(String(call.body)).not.toMatch(/CVE-\d{4}-\d+/i);
    expect(String(call.body)).toContain("[security-id]");
  });

  it("sanitizes /etc/passwd paths to avoid WAF trigger", async () => {
    requestUrlMock.mockImplementation(async (req: any) => {
      const body = String(req?.body || "");
      if (/\/etc\/passwd/i.test(body)) {
        return { status: 403, text: "<html><body>Forbidden</body></html>", headers: { "content-type": "text/html" } };
      }
      return {
        status: 200,
        text: JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }),
        headers: { "content-type": "application/json" },
      };
    });

    const { SystemSculptProvider } = await import("../embeddings/providers/SystemSculptProvider");
    const provider = new SystemSculptProvider("fake-license", "https://api.systemsculpt.com/api/v1");

    const embeddings = await provider.generateEmbeddings(["Check /etc/passwd for user accounts."]);
    expect(embeddings).toEqual([[0.1, 0.2, 0.3]]);

    const call = requestUrlMock.mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    expect(String(call.body)).not.toMatch(/\/etc\/passwd/i);
    expect(String(call.body)).toContain("/system/users");
  });
});
