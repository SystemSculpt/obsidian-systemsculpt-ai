import fixture from "../../../testing/fixtures/managed/managed-job-protocol-v1.json";
import { ManagedJobClient, MANAGED_JOB_DESCRIPTORS, MANAGED_JOB_OPERATION_STATUSES } from "../managed/ManagedJobClient";
import { HostedTransportAdapter } from "../managed/adapters/HostedTransportAdapter";

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

describe("managed document processing adapter contract", () => {
  it("matches the immutable Plan 019 document descriptor without an expired status", () => {
    const expected = fixture.descriptors.find((item) => item.capability === "document_processing")!;
    const actual = MANAGED_JOB_DESCRIPTORS.document_processing;
    expect(actual.statuses).toEqual([...expected.statuses.non_terminal, ...expected.statuses.terminal]);
    expect(actual.statuses).not.toContain("expired");
    expect(MANAGED_JOB_OPERATION_STATUSES.document_processing).toEqual(expected.status_discriminants);
    expect(Object.entries(actual.paths).map(([name, [method, path]]) => ({ name, method, path })))
      .toEqual(expected.operations.map(({ name, method, path }) => ({ name, method, path })));
  });

  it("resumes an existing document with status only and rejects server cancellation before transport", async () => {
    const request = jest.fn().mockResolvedValue(json({ document: { id: "document-1", status: "processing", error: null, progress: 0.5 } }));
    const transport = new HostedTransportAdapter({ baseUrl: "https://api.test", pluginVersion: "1.0.0", licenseKey: () => "license", requestClient: { request } as any });
    const client = new ManagedJobClient(transport);

    await expect(client.documents.resume("document-1")).resolves.toMatchObject({ document: { status: "processing" } });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0].url).toContain("/api/plugin/documents/document-1");
    await expect(client.documents.cancel()).rejects.toMatchObject({ code: "unsupported_operation" });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
