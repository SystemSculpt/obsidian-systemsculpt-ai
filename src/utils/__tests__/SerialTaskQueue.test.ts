import { SerialTaskQueue } from "../../utils/SerialTaskQueue";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("SerialTaskQueue", () => {
  it("runs tasks strictly sequentially", async () => {
    const queue = new SerialTaskQueue();
    const startOrder: number[] = [];
    const finishOrder: number[] = [];

    const first = queue.enqueue(async () => {
      startOrder.push(1);
      await delay(5);
      finishOrder.push(1);
      return "first";
    });

    const second = queue.enqueue(async () => {
      startOrder.push(2);
      finishOrder.push(2);
      return "second";
    });

    await expect(first.promise).resolves.toBe("first");
    await expect(second.promise).resolves.toBe("second");

    expect(startOrder).toEqual([1, 2]);
    expect(finishOrder).toEqual([1, 2]);
  });

  it("reports how many tasks are queued ahead", async () => {
    const queue = new SerialTaskQueue();

    const first = queue.enqueue(async () => "first");
    const second = queue.enqueue(async () => "second");
    const third = queue.enqueue(async () => "third");

    expect(first.ahead).toBe(0);
    expect(second.ahead).toBe(1);
    expect(third.ahead).toBe(2);

    await Promise.all([first.promise, second.promise, third.promise]);
  });

  it("continues processing after a rejection", async () => {
    const queue = new SerialTaskQueue();

    const first = queue.enqueue(async () => {
      throw new Error("boom");
    });

    const second = queue.enqueue(async () => "ok");

    await expect(first.promise).rejects.toThrow("boom");
    await expect(second.promise).resolves.toBe("ok");
    expect(queue.size).toBe(0);
  });
});
