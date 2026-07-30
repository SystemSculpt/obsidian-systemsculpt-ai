import {
  AbstractChat,
  type ChatInit,
  type ChatState,
  type ChatStatus,
  type UIMessage,
} from "ai";

class HeadlessChatState<UI_MESSAGE extends UIMessage>
implements ChatState<UI_MESSAGE> {
  private readonly listeners = new Set<() => void>();
  private currentStatus: ChatStatus = "ready";
  private currentError: Error | undefined;
  private currentMessages: UI_MESSAGE[];

  constructor(
    messages: UI_MESSAGE[],
    private readonly onObserverError?: (error: unknown) => void,
  ) {
    this.currentMessages = messages;
  }

  public get status(): ChatStatus {
    return this.currentStatus;
  }

  public set status(value: ChatStatus) {
    this.currentStatus = value;
    this.notify();
  }

  public get error(): Error | undefined {
    return this.currentError;
  }

  public set error(value: Error | undefined) {
    this.currentError = value;
    this.notify();
  }

  public get messages(): UI_MESSAGE[] {
    return this.currentMessages;
  }

  public set messages(value: UI_MESSAGE[]) {
    this.currentMessages = value;
    this.notify();
  }

  public pushMessage = (message: UI_MESSAGE): void => {
    this.currentMessages = [...this.currentMessages, message];
    this.notify();
  };

  public popMessage = (): void => {
    this.currentMessages = this.currentMessages.slice(0, -1);
    this.notify();
  };

  public replaceMessage = (index: number, message: UI_MESSAGE): void => {
    this.currentMessages = [
      ...this.currentMessages.slice(0, index),
      message,
      ...this.currentMessages.slice(index + 1),
    ];
    this.notify();
  };

  public snapshot = <T>(value: T): T => structuredClone(value);

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.listeners.delete(listener);
        this.onObserverError?.(error);
      }
    }
  }
}

/**
 * Official AI SDK chat behavior with the smallest non-React observable state
 * required by Obsidian. Streaming, tools, approvals, and transport lifecycle
 * remain implemented by AbstractChat.
 */
export class ThinAgentHeadlessChat<
  UI_MESSAGE extends UIMessage = UIMessage,
> extends AbstractChat<UI_MESSAGE> {
  private readonly headlessState: HeadlessChatState<UI_MESSAGE>;

  constructor(
    { messages = [], ...init }: ChatInit<UI_MESSAGE>,
    onObserverError?: (error: unknown) => void,
  ) {
    const state = new HeadlessChatState(messages, onObserverError);
    super({ ...init, state });
    this.headlessState = state;
  }

  public subscribe(listener: () => void): () => void {
    return this.headlessState.subscribe(listener);
  }
}
