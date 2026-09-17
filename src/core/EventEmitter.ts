type Listener = (...args: unknown[]) => void;

/** One listener registry; namespaces are views of the event names, not state. */
export class EventEmitter {
  private readonly events = new Map<string, Listener[]>();

  public on(event: string, listener: Listener): () => void {
    const listeners = this.events.get(event) ?? [];
    listeners.push(listener);
    this.events.set(event, listeners);
    return () => {
      const remaining = this.events.get(event)?.filter(callback => callback !== listener);
      if (remaining?.length) this.events.set(event, remaining);
      else this.events.delete(event);
    };
  }

  public once(event: string, listener: Listener): () => void {
    const remove = this.on(event, (...args) => {
      remove();
      listener(...args);
    });
    return remove;
  }

  public emit(event: string, ...args: unknown[]): void {
    this.events.get(event)?.forEach(callback => callback(...args));
  }

  public off(event: string): void {
    this.events.delete(event);
  }

  public clear(): void {
    this.events.clear();
  }

  public clearNamespace(namespace: string): void {
    for (const event of this.getNamespaceEvents(namespace)) this.events.delete(event);
  }

  public getNamespaceEvents(namespace: string): string[] {
    return [...this.events.keys()].filter(event => (
      namespace.length > 0 && event.startsWith(`${namespace}:`)
      && event.indexOf(":") === namespace.length
    ));
  }
}
