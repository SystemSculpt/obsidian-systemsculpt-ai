/**
 * @jest-environment jsdom
 */

import { appendMessageToGroupedContainer, removeGroupIfEmpty } from "../utils/MessageGrouping";
import type { ChatRole } from "../../../types";

describe("MessageGrouping", () => {
  const createMessage = (role: ChatRole, id: string) => {
    const el = document.createElement("div");
    el.classList.add("systemsculpt-message", `systemsculpt-${role}-message`);
    el.dataset.messageId = id;
    return el;
  };

  test("creates and reuses groups for consecutive roles", () => {
    const container = document.createElement("div");

    const first = createMessage("assistant", "a-1");
    const { groupEl: firstGroup, isNewGroup: firstNew } = appendMessageToGroupedContainer(container, first, "assistant");

    expect(firstNew).toBe(true);
    expect(container.querySelectorAll(".systemsculpt-message-group").length).toBe(1);
    expect(firstGroup.children.length).toBe(1);

    const second = createMessage("assistant", "a-2");
    const { groupEl: secondGroup, isNewGroup: secondNew } = appendMessageToGroupedContainer(container, second, "assistant");

    expect(secondNew).toBe(false);
    expect(secondGroup).toBe(firstGroup);
    expect(firstGroup.children.length).toBe(2);

    const third = createMessage("user", "u-1");
    const { groupEl: thirdGroup, isNewGroup: thirdNew } = appendMessageToGroupedContainer(container, third, "user");

    expect(thirdNew).toBe(true);
    expect(thirdGroup).not.toBe(firstGroup);
    expect(container.querySelectorAll(".systemsculpt-message-group").length).toBe(2);
  });

  test("inserts groups before scroll sentinel", () => {
    const container = document.createElement("div");
    const sentinel = document.createElement("div");
    sentinel.classList.add("systemsculpt-scroll-sentinel");
    container.appendChild(sentinel);

    const message = createMessage("assistant", "a-1");
    appendMessageToGroupedContainer(container, message, "assistant");

    expect(container.children.length).toBe(2);
    expect(container.firstElementChild?.classList.contains("systemsculpt-message-group")).toBe(true);
    expect(container.lastElementChild).toBe(sentinel);
  });

  test("supports DocumentFragment staging", () => {
    const frag = document.createDocumentFragment();

    appendMessageToGroupedContainer(frag, createMessage("assistant", "a-1"), "assistant");
    appendMessageToGroupedContainer(frag, createMessage("assistant", "a-2"), "assistant");
    appendMessageToGroupedContainer(frag, createMessage("user", "u-1"), "user");

    const groups = Array.from(frag.children).filter((node) =>
      (node as HTMLElement).classList?.contains?.("systemsculpt-message-group")
    );
    expect(groups.length).toBe(2);
    expect((groups[0] as HTMLElement).children.length).toBe(2);
    expect((groups[1] as HTMLElement).children.length).toBe(1);
  });

  test("removeGroupIfEmpty prunes empty containers", () => {
    const container = document.createElement("div");
    const { groupEl } = appendMessageToGroupedContainer(container, createMessage("assistant", "a-1"), "assistant");

    const message = groupEl.firstElementChild as HTMLElement;
    expect(message).toBeTruthy();

    message.remove();
    removeGroupIfEmpty(groupEl);

    expect(container.querySelector(".systemsculpt-message-group")).toBeNull();
  });
});
