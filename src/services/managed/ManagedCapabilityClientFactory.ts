import { ManagedAdmission } from "./ManagedAdmission";
import { ManagedCapabilityClient } from "./ManagedCapabilityClient";
import type { ManagedDisclosureAcceptance } from "./ManagedTypes";
import { HostedTransportAdapter } from "./adapters/HostedTransportAdapter";

export type ManagedCapabilityClientFactoryOptions = Readonly<{
  baseUrl: string; pluginVersion: string; licenseKey: () => string;
  disclosureAcceptance: () => ManagedDisclosureAcceptance | null;
}>;

export class ManagedCapabilityClientFactory {
  static create(options: ManagedCapabilityClientFactoryOptions): ManagedCapabilityClient {
    const transport = new HostedTransportAdapter({ baseUrl: options.baseUrl, pluginVersion: options.pluginVersion, licenseKey: options.licenseKey });
    const admission = new ManagedAdmission({ transport, licenseKey: options.licenseKey, disclosureAcceptance: options.disclosureAcceptance });
    return new ManagedCapabilityClient({ admission, transport });
  }
}
