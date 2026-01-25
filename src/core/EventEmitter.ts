/**
 * Enhanced EventEmitter with namespace support for provider isolation
 * Supports both legacy events and namespaced events (e.g., "systemsculpt:modelUpdated")
 */
export class EventEmitter {
  private events: Record<string, Array<(...args: any[]) => void>> = {};
  
  // Track event listeners by namespace for easier management
  private namespaceListeners: Record<string, Set<string>> = {};

  /**
   * Register an event listener
   * @param event Event name (supports namespacing like "systemsculpt:modelUpdated")
   * @param listener Function to call when event is emitted
   * @returns Unsubscribe function
   */
  public on(event: string, listener: (...args: any[]) => void): () => void {
    if (!this.events[event]) {
      this.events[event] = [];
    }
    this.events[event].push(listener);
    
    // Track namespace for management
    this.trackNamespace(event);
    
    // Return unsubscribe function
    return () => {
      this.events[event] = this.events[event].filter(l => l !== listener);
      this.cleanupNamespace(event);
    };
  }

  /**
   * Register a one-time event listener
   * @param event Event name
   * @param listener Function to call when event is emitted
   * @returns Unsubscribe function
   */
  public once(event: string, listener: (...args: any[]) => void): () => void {
    const remove = this.on(event, (...args: any[]) => {
      remove();
      listener(...args);
    });
    return remove;
  }

  /**
   * Emit an event
   * @param event Event name
   * @param args Arguments to pass to listeners
   */
  public emit(event: string, ...args: any[]): void {
    const callbacks = this.events[event];
    if (callbacks) {
      callbacks.forEach(callback => callback(...args));
    }
  }

  /**
   * Remove all listeners for an event
   * @param event Event name
   */
  public off(event: string): void {
    delete this.events[event];
  }

  /**
   * Remove all event listeners
   */
  public clear(): void {
    this.events = {};
    this.namespaceListeners = {};
  }

  /**
   * Track namespace for an event
   */
  private trackNamespace(event: string): void {
    const namespace = this.getNamespace(event);
    if (namespace) {
      if (!this.namespaceListeners[namespace]) {
        this.namespaceListeners[namespace] = new Set();
      }
      this.namespaceListeners[namespace].add(event);
    }
  }

  /**
   * Clean up namespace tracking when event listeners are removed
   */
  private cleanupNamespace(event: string): void {
    const namespace = this.getNamespace(event);
    if (namespace && this.namespaceListeners[namespace]) {
      // If this event has no more listeners, remove from namespace tracking
      if (!this.events[event] || this.events[event].length === 0) {
        this.namespaceListeners[namespace].delete(event);
        
        // If namespace has no more events, remove it
        if (this.namespaceListeners[namespace].size === 0) {
          delete this.namespaceListeners[namespace];
        }
      }
    }
  }

  /**
   * Extract namespace from event name (everything before first colon)
   */
  private getNamespace(event: string): string | null {
    const parts = event.split(':');
    return parts.length > 1 ? parts[0] : null;
  }

  /**
   * Remove all listeners for a specific namespace
   * @param namespace The namespace to clear (e.g., "systemsculpt", "custom")
   */
  public clearNamespace(namespace: string): void {
    if (this.namespaceListeners[namespace]) {
      const events = Array.from(this.namespaceListeners[namespace]);
      events.forEach(event => {
        delete this.events[event];
      });
      delete this.namespaceListeners[namespace];
    }
  }

  /**
   * Get all events in a namespace
   * @param namespace The namespace to query
   * @returns Array of event names in the namespace
   */
  public getNamespaceEvents(namespace: string): string[] {
    return this.namespaceListeners[namespace] ? Array.from(this.namespaceListeners[namespace]) : [];
  }

  /**
   * Emit an event with provider context
   * @param event Event name
   * @param providerType Optional provider type context
   * @param args Arguments to pass to listeners
   */
  public emitWithProvider(event: string, providerType: 'systemsculpt' | 'custom', ...args: any[]): void {
    // Emit the original event
    this.emit(event, ...args);
    
    // Also emit a namespaced version for provider-specific listeners
    const namespacedEvent = `${providerType}:${event}`;
    this.emit(namespacedEvent, ...args);
  }

  /**
   * Listen to events from a specific provider only
   * @param event Base event name (without namespace)
   * @param providerType Provider type to listen to
   * @param listener Function to call when event is emitted
   * @returns Unsubscribe function
   */
  public onProvider(event: string, providerType: 'systemsculpt' | 'custom', listener: (...args: any[]) => void): () => void {
    const namespacedEvent = `${providerType}:${event}`;
    return this.on(namespacedEvent, listener);
  }
} 