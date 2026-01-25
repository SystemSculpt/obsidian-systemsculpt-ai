export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  /**
   * Enqueue a task to run after all previously enqueued tasks finish.
   * Returns both the task promise and the number of tasks that were ahead
   * in the queue at the time this one was scheduled.
   */
  enqueue<T>(task: () => Promise<T> | T): { promise: Promise<T>; ahead: number } {
    const ahead = this.pending;
    this.pending++;

    const runTask = async (): Promise<T> => {
      try {
        return await task();
      } finally {
        this.pending = Math.max(0, this.pending - 1);
      }
    };

    const promise = this.tail.then(runTask);

    this.tail = promise.then(
      () => undefined,
      () => undefined
    );

    return { promise, ahead };
  }

  /**
   * Number of tasks currently running or waiting in the queue.
   */
  get size(): number {
    return this.pending;
  }

  /**
   * Reset the queue, dropping any pending tasks.
   */
  clear(): void {
    this.tail = Promise.resolve();
    this.pending = 0;
  }
}
