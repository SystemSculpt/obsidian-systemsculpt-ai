export function managedAbortError(message = "Aborted"): DOMException {
  return new DOMException(message, "AbortError");
}

export function throwIfManagedAborted(signal?: AbortSignal, message?: string): void {
  if (signal?.aborted) throw managedAbortError(message);
}
