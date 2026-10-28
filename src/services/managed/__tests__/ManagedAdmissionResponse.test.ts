import { decodeManagedAdmissionResponse } from "../ManagedAdmissionResponse";

const envelope = (code: string, fields: Record<string, unknown> = {}) => ({
  contract_version: "admission-v1",
  code,
  message: "Admission response.",
  request_id: "request-1",
  ...fields,
});

describe("managed admission response", () => {
  it.each(["invalid", "expired", "revoked"])("preserves the authoritative %s rejection reason", (reason) => {
    expect(decodeManagedAdmissionResponse(403, envelope("license_rejected", { reason })))
      .toEqual({ outcome: "license_rejected", reason });
  });

  it.each([undefined, null, false, "expired", [], 403])(
    "treats a malformed body %p as unavailable, not an invalid paid license",
    (body) => {
      expect(decodeManagedAdmissionResponse(403, body)).toEqual({ outcome: "temporarily_unavailable" });
    },
  );

  it.each([
    { contract_version: "admission-v2" },
    { message: null },
    { request_id: 123 },
    { reason: "cancelled" },
    { reason: false },
    { reason: "expired", extra: true },
  ])("never infers license rejection from malformed metadata %p", (fields) => {
    expect(decodeManagedAdmissionResponse(403, envelope("license_rejected", fields)))
      .toEqual({ outcome: "temporarily_unavailable" });
  });

  it.each(["license_key", "licenseKey", "credential", "token"])(
    "never returns credential material carried in %s",
    (field) => {
      expect(decodeManagedAdmissionResponse(403, envelope("license_rejected", {
        reason: "revoked",
        [field]: "test-credential-canary",
      }))).toEqual({ outcome: "temporarily_unavailable" });
    },
  );
});
