/** @jest-environment jsdom */
import { AgentChatView } from "../AgentChatView";
import { AgentChatSession, type AgentChatSessionOptions } from "../../../chat/managed/ChatSession";

jest.mock("../../../chat/managed/ChatSession", () => ({ AgentChatSession: jest.fn() }));

it("binds managed recovery to the view visibility and rebinds its observer on window migration", () => {
  const observers: Array<{ disconnect: jest.Mock; observe: jest.Mock; refresh: () => void }> = [];
  const Observer = jest.fn().mockImplementation((refresh: () => void) => {
    const observer = { disconnect: jest.fn(), observe: jest.fn(), refresh };
    observers.push(observer);
    return observer;
  });
  Object.defineProperty(window, "IntersectionObserver", { configurable: true, value: Observer });
  const root = document.body.createDiv();
  const shown = jest.spyOn(root, "isShown").mockReturnValue(true);
  const detachMigration = jest.fn();
  let migrate = () => {};
  root.onWindowMigrated = listener => { migrate = listener; return detachMigration; };
  const leafEvent = {};
  const workspace = { on: jest.fn(() => leafEvent), offref: jest.fn() };
  const view = {
    containerEl: root,
    app: { workspace },
    plugin: { settings: { textExecutionBackend: "systemsculpt" }, manifest: { version: "test" } },
    agentBaseUrl: "https://systemsculpt.test",
  };
  const prototype = AgentChatView.prototype as unknown as { createAgentSession(): unknown };
  prototype.createAgentSession.call(view);
  const options = jest.mocked(AgentChatSession).mock.calls.at(-1)![0] as AgentChatSessionOptions;
  const activity = options.recoveryEnvironment!;
  const refresh = jest.fn();
  const detach = activity.subscribe(refresh);
  expect(activity.ownerWindow()).toBe(window);
  expect(activity.isVisible()).toBe(true);
  expect(observers[0].observe).toHaveBeenCalledWith(root);
  shown.mockReturnValue(false);
  observers[0].refresh();
  expect(activity.isVisible()).toBe(false);
  expect(workspace.on).toHaveBeenCalledWith("active-leaf-change", refresh);
  migrate();
  expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
  expect(observers[1].observe).toHaveBeenCalledWith(root);
  detach();
  expect(observers[1].disconnect).toHaveBeenCalledTimes(1);
  expect(detachMigration).toHaveBeenCalledTimes(1);
  expect(workspace.offref).toHaveBeenCalledWith(leafEvent);
  root.remove();
  Reflect.deleteProperty(window, "IntersectionObserver");
  jest.restoreAllMocks();
});
