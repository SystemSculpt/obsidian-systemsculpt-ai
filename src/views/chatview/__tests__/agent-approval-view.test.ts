/** @jest-environment jsdom */
import { AgentChatView } from "../AgentChatView";
import type { AgentToolPart } from "../../../chat/ChatConversation";
import { Notice } from "obsidian";

jest.mock("obsidian", () => ({ ...jest.requireActual("obsidian"), Notice: jest.fn() }));

const prototype = AgentChatView.prototype as any;
const tool: AgentToolPart = { id: "tool", callId: "tool", messageId: "message", order: 0, kind: "tool", name: "Edit", input: { file_path: "/vault/Plan.md" }, location: "vault", state: "approval-required", approvalId: "approval", native: { agent: "claude", workingDirectory: "/vault" } };

it("forwards native session trust without adding a hosted vault-policy grant", () => {
  const respondToApproval = jest.fn(() => true);
  const view = { agent: { getSnapshot: () => ({ parts: [tool] }), respondToApproval }, sessionTrustedToolNames: new Set() };
  expect(prototype.respondToToolApproval.call(view, "approval", true, true)).toBe(true);
  expect(respondToApproval).toHaveBeenCalledWith("approval", true, "manual", { rememberForSession: true, answers: undefined });
  expect(view.sessionTrustedToolNames.size).toBe(0);
});

it("retains hosted remember-for-chat behavior, including rollback when a request expired", () => {
  const hosted = { ...tool, name: "edit", native: undefined };
  const respondToApproval = jest.fn(() => false);
  const view = { agent: { getSnapshot: () => ({ parts: [hosted] }), respondToApproval }, sessionTrustedToolNames: new Set() };
  expect(prototype.respondToToolApproval.call(view, "approval", true, true)).toBe(false);
  expect(respondToApproval).toHaveBeenCalledWith("approval", true);
  expect(view.sessionTrustedToolNames.size).toBe(0);
  respondToApproval.mockReturnValue(true);
  prototype.respondToToolApproval.call(view, "approval", true, true);
  expect(view.sessionTrustedToolNames.has("edit")).toBe(true);
});

it("puts one clickable waiting Notice in the chat's owner document and reveals that leaf", async () => {
  const owner = document.implementation.createHTMLDocument("Chat window");
  const otherWindowNotices = document.body.createDiv({ cls: "notice-container" });
  const noticeContainer = document.body.createDiv({ cls: "notice" });
  const hide = jest.fn(() => noticeContainer.remove());
  (Notice as unknown as jest.Mock).mockImplementationOnce((message: string) => {
    // Obsidian rejects a DocumentFragment from another window's realm.
    expect(typeof message).toBe("string");
    noticeContainer.textContent = message;
    otherWindowNotices.appendChild(noticeContainer);
    return { noticeEl: noticeContainer, hide };
  });
  const revealLeaf = jest.fn(async () => undefined);
  const focusPendingApproval = jest.fn();
  const view = { containerEl: owner.body.createDiv(), app: { workspace: { revealLeaf } }, leaf: {}, workspace: { renderer: { focusPendingApproval } }, approvalNotice: null };
  prototype.showApprovalNotice.call(view, tool);
  prototype.showApprovalNotice.call(view, tool);
  const button = owner.querySelector<HTMLButtonElement>('[data-testid="chat.approval.notice"]')!;
  expect(button.textContent).toBe("Claude Code is waiting for your approval");
  expect(owner.querySelectorAll('[data-testid="chat.approval.notice"]')).toHaveLength(1);
  expect(otherWindowNotices.querySelector("button")).toBeNull();
  button.click();
  await Promise.resolve();
  expect(hide).toHaveBeenCalledTimes(1);
  expect(revealLeaf).toHaveBeenCalledWith(view.leaf);
  expect(focusPendingApproval).toHaveBeenCalledTimes(1);
  otherWindowNotices.remove();
});
