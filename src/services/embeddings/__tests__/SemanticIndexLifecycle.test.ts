import { SemanticIndexLifecycle } from "../SemanticIndexLifecycle";

describe("SemanticIndexLifecycle", () => {
  it("immediately publishes one immutable canonical snapshot to every observer", () => {
    const lifecycle = new SemanticIndexLifecycle();
    const observed: unknown[] = [];
    const unsubscribe = lifecycle.subscribe((snapshot) => observed.push(snapshot));

    const updated = lifecycle.update({
      phase: "reconciling",
      ready: true,
      total: 4,
      completed: 2,
      pending: 2,
      generation: {
        id: "semantic-v1",
        namespace: "systemsculpt:managed:semantic-v1:v2:1536",
        dimensions: 1536,
      },
    });

    expect(observed).toHaveLength(2);
    expect(observed[1]).toBe(updated);
    expect(updated).toMatchObject({ phase: "reconciling", ready: true, total: 4, completed: 2, pending: 2 });
    expect(Object.isFrozen(updated)).toBe(true);

    unsubscribe();
    lifecycle.update({ phase: "idle", pending: 0 });
    expect(observed).toHaveLength(2);
  });

  it("drops updates that change nothing an observer can see", () => {
    const lifecycle = new SemanticIndexLifecycle();
    const observed: unknown[] = [];
    lifecycle.subscribe((snapshot) => observed.push(snapshot));
    const first = lifecycle.update({ phase: "idle", ready: true, total: 3, completed: 3 });

    const second = lifecycle.update({ phase: "idle", ready: true, total: 3, completed: 3, lastError: null });

    expect(second).toBe(first);
    expect(observed).toHaveLength(2);
    lifecycle.clearListeners();
  });

  it("coalesces progress-only updates to about four per second but publishes phase changes at once", () => {
    jest.useFakeTimers();
    try {
      const lifecycle = new SemanticIndexLifecycle();
      const observed: Array<{ phase: string; completed: number }> = [];
      lifecycle.subscribe((snapshot) => observed.push({ phase: snapshot.phase, completed: snapshot.completed }));
      lifecycle.update({ phase: "reconciling", ready: true, total: 100, completed: 0 });
      for (let completed = 1; completed <= 50; completed += 1) lifecycle.update({ completed });

      expect(observed).toHaveLength(2);
      expect(lifecycle.getSnapshot().completed).toBe(50);
      jest.advanceTimersByTime(250);
      expect(observed).toHaveLength(3);
      expect(observed[2]).toEqual({ phase: "reconciling", completed: 50 });

      lifecycle.update({ completed: 51 });
      lifecycle.update({ phase: "idle", completed: 100 });
      expect(observed.at(-1)).toEqual({ phase: "idle", completed: 100 });
      jest.advanceTimersByTime(1_000);
      expect(observed.at(-1)).toEqual({ phase: "idle", completed: 100 });
      lifecycle.clearListeners();
    } finally {
      jest.useRealTimers();
    }
  });
});
