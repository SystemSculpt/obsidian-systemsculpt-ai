/** @jest-environment node */
import { SystemSculptEnvironment } from "../SystemSculptEnvironment";
import { API_BASE_URL } from "../../../constants/api";

describe("SystemSculptEnvironment", () => {
  it("uses the compiled API base without persisted configuration", () => {
    expect(SystemSculptEnvironment.resolveBaseUrl()).toBe(API_BASE_URL);
  });

  it("builds anonymous managed headers", () => {
    expect(SystemSculptEnvironment.buildHeaders()).toMatchObject({
      "Content-Type": "application/json",
      Accept: "application/json",
    });
  });

  it("adds the managed license header", () => {
    expect(SystemSculptEnvironment.buildHeaders("license-key")["x-license-key"])
      .toBe("license-key");
  });
});
