/**
 * @jest-environment jsdom
 */
import { App } from "obsidian";
import { MermaidPreviewModal } from "../MermaidPreviewModal";

describe("MermaidPreviewModal", () => {
  let app: App;
  let modal: MermaidPreviewModal;
  const sampleMermaidCode = `graph TD
    A[Start] --> B{Is it?}
    B -->|Yes| C[OK]
    B -->|No| D[End]`;

  beforeEach(() => {
    jest.clearAllMocks();
    app = new App();
    modal = new MermaidPreviewModal(app, sampleMermaidCode);
  });

  describe("initialization", () => {
    it("stores code", () => {
      expect((modal as any).code).toBe(sampleMermaidCode);
    });
  });

  describe("onOpen", () => {
    beforeEach(() => {
      modal.onOpen();
    });

    it("adds modal class", () => {
      expect(modal.modalEl.classList.contains("systemsculpt-mermaid-preview-modal")).toBe(true);
    });

    it("creates header", () => {
      const header = modal.contentEl.querySelector(".ss-mermaid-preview-header");
      expect(header).not.toBeNull();
    });

    it("creates title in header", () => {
      const h2 = modal.contentEl.querySelector("h2");
      expect(h2?.textContent).toBe("Mermaid Diagram");
    });

    it("creates close button in header", () => {
      const closeBtn = modal.contentEl.querySelector(".ss-mermaid-preview-close");
      expect(closeBtn).not.toBeNull();
    });

    it("creates diagram container", () => {
      const diagramContainer = modal.contentEl.querySelector(".ss-mermaid-preview-diagram");
      expect(diagramContainer).not.toBeNull();
    });

    it("diagram container has mermaid class", () => {
      const diagramContainer = modal.contentEl.querySelector(".ss-mermaid-preview-diagram");
      expect(diagramContainer?.classList.contains("mermaid")).toBe(true);
    });

    it("diagram container contains code", () => {
      const diagramContainer = modal.contentEl.querySelector(".ss-mermaid-preview-diagram");
      expect(diagramContainer?.textContent).toBe(sampleMermaidCode);
    });

    it("creates footer", () => {
      const footer = modal.contentEl.querySelector(".ss-mermaid-preview-footer");
      expect(footer).not.toBeNull();
    });

    it("creates copy button in footer", () => {
      const copyBtn = modal.contentEl.querySelector(".ss-mermaid-copy-btn");
      expect(copyBtn).not.toBeNull();
      expect(copyBtn?.textContent).toBe("Copy Code");
    });
  });

  describe("close button", () => {
    beforeEach(() => {
      modal.onOpen();
    });

    it("closes modal when close button clicked", () => {
      const closeSpy = jest.spyOn(modal, "close");
      const closeBtn = modal.contentEl.querySelector(".ss-mermaid-preview-close") as HTMLElement;
      closeBtn?.click();

      expect(closeSpy).toHaveBeenCalled();
    });
  });

  describe("copy button", () => {
    beforeEach(() => {
      modal.onOpen();
      // Mock clipboard API
      Object.assign(navigator, {
        clipboard: {
          writeText: jest.fn().mockResolvedValue(undefined),
        },
      });
    });

    it("copies code to clipboard when copy button clicked", async () => {
      const copyBtn = modal.contentEl.querySelector(".ss-mermaid-copy-btn") as HTMLElement;
      copyBtn?.click();

      await Promise.resolve(); // Wait for async clipboard operation

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(sampleMermaidCode);
    });
  });

  describe("mermaid initialization", () => {
    it("calls mermaid.init if available", () => {
      const mockInit = jest.fn();
      (globalThis as any).mermaid = {
        init: mockInit,
      };

      modal.onOpen();

      expect(mockInit).toHaveBeenCalled();
    });

    it("does not throw if mermaid is not available", () => {
      delete (globalThis as any).mermaid;

      expect(() => modal.onOpen()).not.toThrow();
    });

    it("does not throw if mermaid.init is not a function", () => {
      (globalThis as any).mermaid = {};

      expect(() => modal.onOpen()).not.toThrow();
    });

    it("handles mermaid.init errors gracefully", () => {
      (globalThis as any).mermaid = {
        init: jest.fn().mockImplementation(() => {
          throw new Error("Mermaid error");
        }),
      };

      expect(() => modal.onOpen()).not.toThrow();
    });
  });

  describe("onClose", () => {
    it("empties content", () => {
      modal.onOpen();
      modal.onClose();

      expect(modal.contentEl.children.length).toBe(0);
    });
  });

  describe("with different code", () => {
    it("handles simple sequence diagram", () => {
      const sequenceCode = "sequenceDiagram\n    A->>B: Hello";
      modal = new MermaidPreviewModal(app, sequenceCode);
      modal.onOpen();

      const diagramContainer = modal.contentEl.querySelector(".ss-mermaid-preview-diagram");
      expect(diagramContainer?.textContent).toBe(sequenceCode);
    });

    it("handles empty code", () => {
      modal = new MermaidPreviewModal(app, "");
      modal.onOpen();

      const diagramContainer = modal.contentEl.querySelector(".ss-mermaid-preview-diagram");
      expect(diagramContainer?.textContent).toBe("");
    });

    it("handles complex flowchart", () => {
      const complexCode = `flowchart TB
    subgraph TOP
        direction TB
        subgraph B1
            direction RL
            i1 -->f1
        end
    end`;
      modal = new MermaidPreviewModal(app, complexCode);
      modal.onOpen();

      const diagramContainer = modal.contentEl.querySelector(".ss-mermaid-preview-diagram");
      expect(diagramContainer?.textContent).toBe(complexCode);
    });
  });
});
