import fixture from "../../../../testing/fixtures/managed/managed-capabilities-v2.json";
import { PlatformRequestClient, type PlatformRequestInput } from "../../PlatformRequestClient";
import { ManagedAdmission } from "../ManagedAdmission";
import { ManagedCapabilityClient } from "../ManagedCapabilityClient";
import { HostedTransportAdapter } from "../adapters/HostedTransportAdapter";

class AdmissionResponse extends Response {
  public constructor() { super(JSON.stringify({ code: "allowed" }), { status: 200, headers: { "content-type": "application/json" } }); }
  public override clone(): Response { return new AdmissionResponse(); }
  public override async json(): Promise<{ code: "allowed" }> { return { code: "allowed" }; }
}

export class DeterministicManagedRequestClient extends PlatformRequestClient {
  public readonly inputs: PlatformRequestInput[] = [];
  public override async request(input: PlatformRequestInput): Promise<Response> {
    this.inputs.push(input);
    if (input.url.endsWith("/api/plugin/config")) {
      return new Response(JSON.stringify(fixture), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (input.url.endsWith("/api/plugin/license/validate")) {
      return new AdmissionResponse();
    }
    throw new Error(`Unexpected managed test request: ${input.url}`);
  }
}

export function createDeterministicManagedChatClient(options?: {
  licenseKey?: () => string;
}) {
  const requestClient = new DeterministicManagedRequestClient();
  const licenseKey = options?.licenseKey ?? (() => "fixture-license");
  const transport = new HostedTransportAdapter({
    baseUrl: "https://api.test",
    pluginVersion: "5.11.0-test",
    licenseKey,
    requestClient,
  });
  const admission = new ManagedAdmission({ transport, licenseKey });
  return Object.freeze({
    client: new ManagedCapabilityClient({ admission, transport }),
    admission,
    transport,
    requestClient,
  });
}
