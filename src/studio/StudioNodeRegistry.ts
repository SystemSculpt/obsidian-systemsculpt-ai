import type { StudioNodeDefinition } from "./types";

export class StudioNodeRegistry {
  private readonly definitions = new Map<string, StudioNodeDefinition>();

  private key(kind: string, version: string): string {
    return `${kind}@${version}`;
  }

  register(definition: StudioNodeDefinition): void {
    this.definitions.set(this.key(definition.kind, definition.version), definition);
  }

  get(kind: string, version: string): StudioNodeDefinition | null {
    return this.definitions.get(this.key(kind, version)) || null;
  }

  list(): StudioNodeDefinition[] {
    return Array.from(this.definitions.values());
  }
}

