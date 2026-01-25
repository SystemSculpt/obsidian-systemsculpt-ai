import { ChatRole } from "../../../types";

const GROUP_CLASS = "systemsculpt-message-group";
const GROUP_ROLE_DATA_ATTR = "role";
const SENTINEL_CLASS = "systemsculpt-scroll-sentinel";
const LOAD_MORE_CLASS = "systemsculpt-load-more";

export interface AppendMessageOptions {
  breakGroup?: boolean;
}

export interface AppendMessageResult {
  groupEl: HTMLElement;
  isNewGroup: boolean;
}

function isHTMLElement(node: Element | null): node is HTMLElement {
  return !!node && node instanceof HTMLElement;
}

function findLastGroup(container: HTMLElement | DocumentFragment): HTMLElement | null {
  let last = container.lastElementChild as HTMLElement | null;
  while (isHTMLElement(last)) {
    if (last.classList.contains(SENTINEL_CLASS) || last.classList.contains(LOAD_MORE_CLASS)) {
      last = last.previousElementSibling as HTMLElement | null;
      continue;
    }
    if (last.classList.contains(GROUP_CLASS)) {
      return last;
    }
    last = last.previousElementSibling as HTMLElement | null;
  }
  return null;
}

function insertGroup(container: HTMLElement | DocumentFragment, groupEl: HTMLElement): void {
  if (container instanceof HTMLElement) {
    const lastChild = container.lastElementChild;
    if (isHTMLElement(lastChild) && lastChild.classList.contains(SENTINEL_CLASS)) {
      container.insertBefore(groupEl, lastChild);
      return;
    }
  }
  container.appendChild(groupEl);
}

export function appendMessageToGroupedContainer(
  container: HTMLElement | DocumentFragment,
  messageEl: HTMLElement,
  role: ChatRole,
  options: AppendMessageOptions = {}
): AppendMessageResult {
  const { breakGroup = false } = options;

  let groupEl: HTMLElement | null = null;
  if (!breakGroup) {
    const lastGroup = findLastGroup(container);
    if (lastGroup && lastGroup.dataset[GROUP_ROLE_DATA_ATTR] === role) {
      groupEl = lastGroup;
    }
  }

  const isNewGroup = !groupEl;
  if (!groupEl) {
    groupEl = document.createElement("div");
    groupEl.classList.add(GROUP_CLASS, `systemsculpt-${role}-group`);
    groupEl.dataset[GROUP_ROLE_DATA_ATTR] = role;
    insertGroup(container, groupEl);
  }

  groupEl.appendChild(messageEl);
  return { groupEl, isNewGroup };
}

export function removeGroupIfEmpty(groupEl: HTMLElement): void {
  if (!groupEl.classList.contains(GROUP_CLASS)) {
    return;
  }
  const hasMessageChildren = Array.from(groupEl.children).some((child) =>
    (child as HTMLElement).classList?.contains?.("systemsculpt-message")
  );
  if (!hasMessageChildren) {
    groupEl.remove();
  }
}
