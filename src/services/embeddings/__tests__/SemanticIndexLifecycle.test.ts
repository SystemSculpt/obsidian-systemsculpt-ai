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
});
