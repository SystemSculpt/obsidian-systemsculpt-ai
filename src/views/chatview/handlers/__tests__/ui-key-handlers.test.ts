import { JSDOM } from "jsdom";
import {
  handleAgentSelectionDetection,
  handleAtMentionDetection,
  handleInputChange,
  handleKeyDown,
  handleSlashCommandDetection,
} from "../UIKeyHandlers";
import { LargeTextHelpers } from "../../../../constants/largeText";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
(global as any).window = dom.window;
(global as any).document = dom.window.document;

const createInput = () => {
  const input = document.createElement("textarea");
  input.value = "";
  input.selectionStart = 0;
  input.selectionEnd = 0;
  return input;
};

describe("UIKeyHandlers", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("sends on Enter when not generating", async () => {
    const input = createInput();
    const handleSendMessage = jest.fn(async () => {});
    const handleStopGeneration = jest.fn();
    const event = {
      key: "Enter",
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      preventDefault: jest.fn(),
    } as any;

    await handleKeyDown(
      {
        isChatReady: () => true,
        isGenerating: () => false,
        handleSendMessage,
        handleStopGeneration,
        input,
      },
      event
    );

    expect(event.preventDefault).toHaveBeenCalled();
    expect(handleSendMessage).toHaveBeenCalledTimes(1);
    expect(handleStopGeneration).not.toHaveBeenCalled();
  });

  it("blocks Enter while generating and shows notice", async () => {
    const input = createInput();
    const handleSendMessage = jest.fn(async () => {});
    const event = {
      key: "Enter",
      shiftKey: false,
      preventDefault: jest.fn(),
    } as any;

    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    await handleKeyDown(
      {
        isChatReady: () => true,
        isGenerating: () => true,
        handleSendMessage,
        handleStopGeneration: jest.fn(),
        input,
      },
      event
    );

    expect(event.preventDefault).toHaveBeenCalled();
    expect(handleSendMessage).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("stops generation on Escape", async () => {
    const input = createInput();
    const handleStopGeneration = jest.fn(async () => {});
    const event = {
      key: "Escape",
      preventDefault: jest.fn(),
    } as any;

    await handleKeyDown(
      {
        isChatReady: () => true,
        isGenerating: () => true,
        handleSendMessage: jest.fn(async () => {}),
        handleStopGeneration,
        input,
      },
      event
    );

    expect(event.preventDefault).toHaveBeenCalled();
    expect(handleStopGeneration).toHaveBeenCalledTimes(1);
  });

  it("stops generation on Cmd/Ctrl + .", async () => {
    const input = createInput();
    const handleStopGeneration = jest.fn(async () => {});
    const event = {
      key: ".",
      ctrlKey: true,
      metaKey: false,
      preventDefault: jest.fn(),
    } as any;

    await handleKeyDown(
      {
        isChatReady: () => true,
        isGenerating: () => true,
        handleSendMessage: jest.fn(async () => {}),
        handleStopGeneration,
        input,
      },
      event
    );

    expect(event.preventDefault).toHaveBeenCalled();
    expect(handleStopGeneration).toHaveBeenCalledTimes(1);
  });

  it("lets slash command menu consume keydown", async () => {
    const input = createInput();
    const handleSendMessage = jest.fn(async () => {});
    const slashCommandMenu = {
      handleKeydown: jest.fn(() => true),
      isOpen: jest.fn(() => true),
      show: jest.fn(),
      updateQuery: jest.fn(),
      hide: jest.fn(),
    };
    const event = {
      key: "Enter",
      shiftKey: false,
      preventDefault: jest.fn(),
    } as any;

    await handleKeyDown(
      {
        isChatReady: () => true,
        isGenerating: () => false,
        handleSendMessage,
        handleStopGeneration: jest.fn(),
        input,
        slashCommandMenu,
      },
      event
    );

    expect(slashCommandMenu.handleKeydown).toHaveBeenCalled();
    expect(handleSendMessage).not.toHaveBeenCalled();
  });

  it("resets pending large text when placeholder removed", () => {
    const input = createInput();
    input.value = "Hello world";

    const setPendingLargeTextContent = jest.fn();
    handleInputChange({
      input,
      adjustInputHeight: jest.fn(),
      setPendingLargeTextContent,
    } as any);

    expect(setPendingLargeTextContent).toHaveBeenCalledWith(null);
  });

  it("shows agent menu and hides slash menu for /agent prefix", () => {
    const input = createInput();
    input.value = "/agent ";
    input.selectionStart = input.value.length;

    const agentSelectionMenu = {
      isOpen: jest.fn(() => false),
      show: jest.fn(),
      hide: jest.fn(),
    };
    const slashCommandMenu = {
      isOpen: jest.fn(() => true),
      hide: jest.fn(),
    };

    handleAgentSelectionDetection({
      input,
      agentSelectionMenu,
      slashCommandMenu,
    });

    expect(agentSelectionMenu.show).toHaveBeenCalledWith(input.selectionStart);
    expect(slashCommandMenu.hide).toHaveBeenCalled();
  });

  it("shows slash command menu when leading slash typed", () => {
    const input = createInput();
    input.value = "/help";
    input.selectionStart = 5;

    const slashCommandMenu = {
      isOpen: jest.fn(() => false),
      show: jest.fn(),
      updateQuery: jest.fn(),
      hide: jest.fn(),
    };

    handleSlashCommandDetection({ input, slashCommandMenu });
    expect(slashCommandMenu.show).toHaveBeenCalledWith("help");
  });

  it("shows at-mention menu when @ token detected", () => {
    const input = createInput();
    input.value = "Hello @alpha";
    input.selectionStart = input.value.length;

    const atMentionMenu = {
      isOpen: jest.fn(() => false),
      show: jest.fn(),
      updateQuery: jest.fn(),
      hide: jest.fn(),
    };

    handleAtMentionDetection({ input, atMentionMenu });
    expect(atMentionMenu.show).toHaveBeenCalled();
  });

  it("keeps pending large text when placeholder present", () => {
    const input = createInput();
    input.value = LargeTextHelpers.createPlaceholder(3);

    const setPendingLargeTextContent = jest.fn();
    handleInputChange({
      input,
      adjustInputHeight: jest.fn(),
      setPendingLargeTextContent,
    } as any);

    expect(setPendingLargeTextContent).not.toHaveBeenCalled();
  });
});
