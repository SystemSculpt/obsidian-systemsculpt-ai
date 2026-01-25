import { App, setIcon, Platform } from "obsidian";
import { ChatRole } from "../../../types";
import { PlatformContext } from "../../../services/PlatformContext";

type ToolbarOptions = {
  app: App;
  messageEl: HTMLElement;
  role: ChatRole;
  messageId: string;
};

function getMessageText(messageEl: HTMLElement): string {
  // Prefer unified content parts when present to avoid duplicating the
  // legacy container text. Fallback to the legacy container otherwise.
  const contentParts = Array.from(
    messageEl.querySelectorAll<HTMLElement>(".systemsculpt-content-part")
  );
  if (contentParts.length > 0) {
    return contentParts
      .map((el) => (el.textContent || "").trim())
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  const legacy = messageEl.querySelector<HTMLElement>(
    ".systemsculpt-message-content"
  );
  return (legacy?.textContent || "").trim();
}

function createIconButton(
  name: string,
  ariaLabel: string,
  onClick: (ev: MouseEvent) => void
): HTMLElement {
  const btn = document.createElement("button");
  btn.className = "systemsculpt-toolbar-btn";
  btn.setAttribute("type", "button");
  btn.setAttribute("aria-label", ariaLabel);
  setIcon(btn, name);
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    onClick(ev);
  });
  return btn;
}

export function attachMessageToolbar(options: ToolbarOptions): void {
  const { messageEl, role, messageId } = options;

  if (messageEl.querySelector(".systemsculpt-message-toolbar")) return;

  // Prefer to anchor toolbar to the last rendered content container so overlay
  // positioning is stable across grouped messages and unified parts
  const contentParts = messageEl.querySelectorAll<HTMLElement>(
    ".systemsculpt-content-part"
  );
  const anchor = contentParts.length
    ? contentParts[contentParts.length - 1]
    : (messageEl.querySelector(
        ".systemsculpt-message-content"
      ) as HTMLElement | null) || messageEl;

  const toolbar = document.createElement("div");
  toolbar.className = "systemsculpt-message-toolbar";
  const platform = PlatformContext.get();
  const uiVariant = platform.uiVariant();
  const isMobile = Platform.isMobile || uiVariant === "mobile";
  toolbar.classList.add(`platform-ui-${isMobile ? "mobile" : "desktop"}`);

  if (messageEl.classList.contains("systemsculpt-user-message")) {
    toolbar.classList.add("is-user");
  } else if (messageEl.classList.contains("systemsculpt-assistant-message")) {
    toolbar.classList.add("is-assistant");
  }

  if (isMobile) toolbar.classList.add("is-mobile");

  const copyBtn = createIconButton("copy", "Copy message", async () => {
    const text = getMessageText(messageEl) || messageEl.dataset.content || "";
    try {
      await navigator.clipboard.writeText(text);
      setIcon(copyBtn, "check");
      copyBtn.classList.add("ss-success");
      copyBtn.setAttribute("aria-label", "Copied");
      setTimeout(() => {
        setIcon(copyBtn, "copy");
        copyBtn.classList.remove("ss-success");
        copyBtn.setAttribute("aria-label", "Copy message");
      }, 1200);
    } catch {}
  });

  // On mobile, show a compact "more" toggle to expand actions
  if (isMobile) {
    const moreBtn = createIconButton("more-horizontal", "More", () => {
      toolbar.classList.toggle("ss-open");
    });
    moreBtn.classList.add("systemsculpt-toolbar-more");
    toolbar.appendChild(moreBtn);
  }

  toolbar.appendChild(copyBtn);

  if (role === "user") {
    const resendBtn = createIconButton("refresh-ccw", "Resend", () => {});
    let isConfirmingResend = false;
    let confirmTimer: number | null = null;

    const resetConfirm = () => {
      if (!isConfirmingResend) return;
      isConfirmingResend = false;
      if (confirmTimer) {
        window.clearTimeout(confirmTimer);
        confirmTimer = null;
      }
      setIcon(resendBtn, "refresh-ccw");
      resendBtn.classList.remove("ss-confirm");
      resendBtn.setAttribute("aria-label", "Resend");
      resendBtn.removeAttribute("title");
    };

    resendBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!isConfirmingResend) {
        isConfirmingResend = true;
        setIcon(resendBtn, "help-circle");
        resendBtn.classList.add("ss-confirm");
        resendBtn.setAttribute("aria-label", "Confirm resend");
        resendBtn.setAttribute("title", "Are you sure?");
        confirmTimer = window.setTimeout(() => {
          resetConfirm();
        }, 2500);
        return;
      }
      const content = messageEl.dataset.content || getMessageText(messageEl) || "";
      messageEl.dispatchEvent(
        new CustomEvent("resubmit", {
          bubbles: true,
          detail: { messageId, content },
        })
      );
      resetConfirm();
    });

    toolbar.addEventListener("mouseleave", () => {
      resetConfirm();
    });

    toolbar.appendChild(resendBtn);
  }

  if (role === "assistant") {
    const replyBtn = createIconButton("corner-down-left", "Reply", () => {
      const content = getMessageText(messageEl);
      messageEl.dispatchEvent(
        new CustomEvent("reply", {
          bubbles: true,
          detail: { messageId, content },
        })
      );
    });
    toolbar.appendChild(replyBtn);
  }

  const deleteBtn = createIconButton("trash", "Delete message", () => {
    messageEl.dispatchEvent(
      new CustomEvent("delete", { bubbles: true, detail: { messageId } })
    );
  });

  toolbar.appendChild(deleteBtn);

  anchor.appendChild(toolbar);

  let lastLayoutSignature: string | null = null;

  const updateToolbarPosition = () => {
    const container = messageEl.closest(
      ".systemsculpt-messages-container"
    ) as HTMLElement | null;

    const containerRect =
      container?.getBoundingClientRect() ||
      document.body.getBoundingClientRect();

    toolbar.style.setProperty("--ss-toolbar-shift-x", "0px");

    const anchorRect = anchor.getBoundingClientRect();
    const availableBelow = containerRect.bottom - anchorRect.bottom;
    const requiredClearance = toolbar.offsetHeight + 12;
    const shouldFlip = availableBelow < requiredClearance;

    toolbar.classList.toggle("ss-flip-up", shouldFlip);

    const toolbarRect = toolbar.getBoundingClientRect();
    const horizontalPadding = 8;
    const minLeft = containerRect.left + horizontalPadding;
    const maxRight = containerRect.right - horizontalPadding;

    const leftOverflow = Math.max(0, minLeft - toolbarRect.left);
    const rightOverflow = Math.max(0, toolbarRect.right - maxRight);

    let horizontalShift = 0;
    if (leftOverflow > 0 && rightOverflow > 0) {
      const toolbarCenter = (toolbarRect.left + toolbarRect.right) / 2;
      const containerCenter = (minLeft + maxRight) / 2;
      horizontalShift = containerCenter - toolbarCenter;
    } else if (leftOverflow > 0) {
      horizontalShift = leftOverflow;
    } else if (rightOverflow > 0) {
      horizontalShift = -rightOverflow;
    }

    if (horizontalShift !== 0) {
      toolbar.style.setProperty(
        "--ss-toolbar-shift-x",
        `${Math.round(horizontalShift)}px`
      );
    }

    const layoutSignature = `${shouldFlip ? "up" : "down"}:${Math.round(
      horizontalShift
    )}:${Math.round(toolbarRect.width)}`;
    if (layoutSignature !== lastLayoutSignature) {
      lastLayoutSignature = layoutSignature;
    }
  };

  anchor.addEventListener("mouseenter", updateToolbarPosition, { passive: true });
  toolbar.addEventListener("mouseenter", updateToolbarPosition, { passive: true });

  // Ensure initial layout is correct once the toolbar is in the DOM.
  requestAnimationFrame(() => {
    updateToolbarPosition();
  });

  void messageId;
}
