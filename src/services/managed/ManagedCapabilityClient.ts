import { ManagedAdmission } from "./ManagedAdmission";
import {
  ManagedTextGenerationAdapter,
  type ManagedTextGenerationOperation,
} from "./ManagedTextGenerationAdapter";
import { ManagedEmbeddingsIndexAdapter } from "../embeddings/gateway/ManagedEmbeddingsIndexAdapter";
import { HostedTransportAdapter } from "./adapters/HostedTransportAdapter";

export class ManagedCapabilityClient {
  private readonly textGeneration: ManagedTextGenerationAdapter;
  private readonly embeddingsIndex: ManagedEmbeddingsIndexAdapter;

  constructor(private readonly dependencies: { admission: ManagedAdmission; transport: HostedTransportAdapter }) {
    this.textGeneration = new ManagedTextGenerationAdapter(dependencies);
    this.embeddingsIndex = new ManagedEmbeddingsIndexAdapter(dependencies.transport);
  }
  getCatalog() { return this.dependencies.transport.getCatalog(); }
  getAdmission() { return this.dependencies.transport.getAdmission(); }
  generateText(operation: ManagedTextGenerationOperation) { return this.textGeneration.generate(operation); }
  getEmbeddingsIndex(): ManagedEmbeddingsIndexAdapter { return this.embeddingsIndex; }
}
