class ChatIdAllocationError extends Error {
  constructor(public readonly chatId: string, public readonly cause: unknown) {
    super(`Failed to exclusively create chat ${chatId}`);
    this.name = "ChatIdAllocationError";
  }
}

export class ChatIdAllocator<T> {
  constructor(
    private readonly createExclusive: (chatId: string) => Promise<T | null>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async allocate(): Promise<{ chatId: string; value: T }> {
    const now = this.now();
    const prefix = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("-") + ` ${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}`;

    let suffix = 1;
    while (true) {
      const chatId = suffix === 1 ? prefix : `${prefix}-${suffix}`;
      let value: T | null;
      try {
        value = await this.createExclusive(chatId);
      } catch (cause) {
        throw new ChatIdAllocationError(chatId, cause);
      }
      if (value !== null) {
        return { chatId, value };
      }
      suffix += 1;
    }
  }
}
