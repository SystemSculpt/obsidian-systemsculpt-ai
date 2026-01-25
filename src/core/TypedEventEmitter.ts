/**
 * Typed EventEmitter for type-safe event handling
 * Based on the existing EventEmitter but with full TypeScript support
 */

type EventMap = Record<string, any>;

type EventKey<T extends EventMap> = string & keyof T;
type EventReceiver<T> = (params: T) => void;

interface Emitter<T extends EventMap> {
  on<K extends EventKey<T>>(eventName: K, fn: EventReceiver<T[K]>): () => void;
  once<K extends EventKey<T>>(eventName: K, fn: EventReceiver<T[K]>): () => void;
  off<K extends EventKey<T>>(eventName: K): void;
  emit<K extends EventKey<T>>(eventName: K, params: T[K]): void;
  clear(): void;
}

/**
 * Type-safe event emitter that ensures compile-time validation of event names and payloads
 */
export class TypedEventEmitter<T extends EventMap> implements Emitter<T> {
  private events: Record<string, Array<EventReceiver<any>>> = {};

  /**
   * Register an event listener
   * @param eventName Event name (must be a key of T)
   * @param fn Function to call when event is emitted
   * @returns Unsubscribe function
   */
  public on<K extends EventKey<T>>(eventName: K, fn: EventReceiver<T[K]>): () => void {
    if (!this.events[eventName]) {
      this.events[eventName] = [];
    }
    this.events[eventName].push(fn);
    
    // Return unsubscribe function
    return () => {
      this.events[eventName] = this.events[eventName].filter(l => l !== fn);
    };
  }

  /**
   * Register a one-time event listener
   * @param eventName Event name (must be a key of T)
   * @param fn Function to call when event is emitted
   * @returns Unsubscribe function
   */
  public once<K extends EventKey<T>>(eventName: K, fn: EventReceiver<T[K]>): () => void {
    const remove = this.on(eventName, (params: T[K]) => {
      remove();
      fn(params);
    });
    return remove;
  }

  /**
   * Emit an event
   * @param eventName Event name (must be a key of T)
   * @param params Event parameters (must match T[K])
   */
  public emit<K extends EventKey<T>>(eventName: K, params: T[K]): void {
    const callbacks = this.events[eventName];
    if (callbacks) {
      callbacks.forEach(callback => callback(params));
    }
  }

  /**
   * Remove all listeners for an event
   * @param eventName Event name (must be a key of T)
   */
  public off<K extends EventKey<T>>(eventName: K): void {
    delete this.events[eventName];
  }

  /**
   * Remove all event listeners
   */
  public clear(): void {
    this.events = {};
  }

  /**
   * Get the number of listeners for an event
   * @param eventName Event name
   * @returns Number of listeners
   */
  public listenerCount<K extends EventKey<T>>(eventName: K): number {
    return this.events[eventName]?.length || 0;
  }

  /**
   * Get all event names that have listeners
   * @returns Array of event names
   */
  public eventNames(): string[] {
    return Object.keys(this.events);
  }
}