import { ManagedAdmission } from "./ManagedAdmission";
import { ManagedCapabilityClient } from "./ManagedCapabilityClient";
import { HostedTransportAdapter } from "./adapters/HostedTransportAdapter";

export type ManagedCapabilityClientFactoryOptions = Readonly<{
  baseUrl: string; pluginVersion: string; licenseKey: () => string;
}>;

export type ManagedCapabilityClientGraph = Readonly<{
  transport: HostedTransportAdapter;
  admission: ManagedAdmission;
  client: ManagedCapabilityClient;
}>;

export class ManagedCapabilityClientFactory {
  static createGraph(options: ManagedCapabilityClientFactoryOptions): ManagedCapabilityClientGraph {
    const transport = new HostedTransportAdapter({ baseUrl: options.baseUrl, pluginVersion: options.pluginVersion, licenseKey: options.licenseKey });
    const admission = new ManagedAdmission({ transport, licenseKey: options.licenseKey });
    const client = new ManagedCapabilityClient({ admission, transport });
    return Object.freeze({ transport, admission, client });
  }

  static create(options: ManagedCapabilityClientFactoryOptions): ManagedCapabilityClient {
    return this.createGraph(options).client;
  }
}
