import fixture from "../../../../testing/fixtures/managed/managed-capabilities-v2.json";
import type { ManagedCapabilityCatalogContract } from "../ManagedTypes";
import {
  managedChatInputLimitsFromCatalog,
} from "../ManagedChatInputLimits";

const catalog = fixture as unknown as ManagedCapabilityCatalogContract;

describe("ManagedChatInputLimits", () => {
  it("maps the negotiated chat and document descriptors into one input contract", () => {
    expect(managedChatInputLimitsFromCatalog(catalog)).toEqual({
      imageMimeTypes: ["image/png", "image/jpeg", "image/webp"],
      maxContentBlocksPerMessage: 16,
      maxImagesPerTurn: 6,
      maxImageBytes: 6 * 1024 * 1024,
      maxTotalImageBytes: 16 * 1024 * 1024,
      maxTextBytesPerBlock: 1024 * 1024,
      maxTotalTextBytes: 2 * 1024 * 1024,
      maxCreateRequestBytes: catalog.capabilities[0].limits.max_request_bytes,
      maxDeltaRequestBytes: catalog.capabilities[0].limits.max_delta_request_bytes
        ?? catalog.capabilities[0].limits.max_request_bytes,
      maxToolsJsonBytes: 512 * 1024,
      maxDocumentBytes: 25 * 1024 * 1024,
    });
  });

  it("fails closed when a required advertised limit is malformed", () => {
    const broken = {
      ...catalog,
      capabilities: catalog.capabilities.map((descriptor) => descriptor.alias === "systemsculpt/chat"
        ? { ...descriptor, limits: { ...descriptor.limits, max_image_bytes: 0 } }
        : descriptor),
    } as ManagedCapabilityCatalogContract;

    expect(() => managedChatInputLimitsFromCatalog(broken)).toThrow("max_image_bytes");
  });
});
