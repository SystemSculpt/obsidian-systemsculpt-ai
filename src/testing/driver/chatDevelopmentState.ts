import type { App } from "obsidian";

import { chatContainer, isVisible, queryElements, resolveTarget } from "./locators";
import {
  type ActionContext,
  activeChatView,
  asDriverActionError,
  composerDraft,
  type DevelopmentChatView,
  DriverActionError,
  type DriverActionHandlers,
  errorMessage,
  pointerSequence,
  requireTarget,
  revealActivityTarget,
  setNativeValue,
  sha256OfText,
  sleep,
  throwIfActionCancelled,
  validatedVaultPath,
} from "./actionCore";
import {
  canonicalToolCallId,
  endToolLifecycleCapture,
  startToolLifecycleCapture,
  toolLifecycleCaptures,
  toolLifecycleReport,
} from "./chatToolLifecycle";
import {
  captureRunSubmissionBaseline,
  chatSnapshot,
  completedSubmittedRun,
  pendingRunSubmissions,
  type RunSubmissionBaseline,
  waitForCondition,
  waitForVisibilitySafely,
} from "./snapshotsAndWaits";

/**
 * Development-test chats. A run that begins with a marker owns one chat and
 * the vault folder named after that marker; approvals, mutations and the
 * final reset may touch only what that ownership covers.
 */

const DEVELOPMENT_TEST_ROOT = "SystemSculpt/Development Tests";

const DEVELOPMENT_TEST_PREFIX = `${DEVELOPMENT_TEST_ROOT}/`;

const DEVELOPMENT_MARKER_PATTERN = /^SS-DEV-TEST-[A-Z0-9]{2,64}$/;

const DEVELOPMENT_MARKER_HANDOFF_TIMEOUT_MS = 1000;

interface DevelopmentChatOwnership {
  approvalClearedAfterGrant: boolean;
  approvalGranted: boolean;
  approvedDevelopmentDirectories: Set<string>;
  approvedDevelopmentPaths: Map<string, string>;
  approvedDevelopmentRootEstablished: boolean;
  approvedMutationCount: number;
  approvedTrashArtifacts: Map<string, ApprovedDevelopmentTrashArtifact>;
  cleanupProgress: DevelopmentCleanupProgress | null;
  initialApprovalMode: string;
  marker: string;
  ownedChatId: string | null;
  previousChatId: string;
  runObserved: boolean;
  submissionBaseline: RunSubmissionBaseline | null;
  submissionAttempted: boolean;
  toolCaptureOwned: boolean;
  view: DevelopmentChatView;
}

interface DevelopmentChatOwnershipReceipt {
  readonly chatSha256: string;
  readonly chatPath: string;
  readonly initialApprovalMode: string;
  readonly marker: string;
  readonly ownedChatId: string;
  readonly previousChatId: string;
  readonly version: 1;
}

interface ApprovedDevelopmentTrashArtifact {
  readonly candidates: readonly string[];
  readonly expectedText: string;
  mirroredDirectoriesCleaned: boolean;
  restored: boolean;
  restoredCandidate: string | null;
  readonly sourcePath: string;
}

interface DevelopmentCleanupProgress {
  chatCleanupComplete: boolean;
  developmentPathCleanupComplete: boolean;
  draftCleared: boolean;
  ownedChatPath: string | null;
  removedAttachments: number;
  requestedDevelopmentPath: string | null;
  requestedTrashSavedChat: boolean;
  restorationComplete: boolean;
  stoppedRun: boolean;
  toolCaptureEnded: boolean;
  toolLifecycle: Record<string, unknown> | null;
  trashedChat: boolean;
  trashedDevelopmentPath: boolean;
  uiCleanupComplete: boolean;
}

export const developmentChatOwners = new WeakMap<App, DevelopmentChatOwnership>();

function developmentMarkerFromPath(value: unknown, allowMarkerRoot = false): {
  marker: string;
  path: string;
} {
  const path = validatedVaultPath(value);
  if (!path.startsWith(DEVELOPMENT_TEST_PREFIX)) {
    throw new DriverActionError(
      `Development-test paths must use a unique marker under "${DEVELOPMENT_TEST_ROOT}".`,
    );
  }
  const segments = path.slice(DEVELOPMENT_TEST_PREFIX.length).split("/");
  const marker = segments[0] ?? "";
  if (
    !DEVELOPMENT_MARKER_PATTERN.test(marker)
    || (!allowMarkerRoot && segments.length === 1)
  ) {
    throw new DriverActionError(
      `Development-test paths must use "${DEVELOPMENT_TEST_ROOT}/SS-DEV-TEST-<ID>/...".`,
    );
  }
  return { marker, path };
}

function validatedDevelopmentMarker(value: unknown): string {
  if (typeof value !== "string" || !DEVELOPMENT_MARKER_PATTERN.test(value)) {
    throw new DriverActionError(
      "A marker matching SS-DEV-TEST-[A-Z0-9]{2,64} is required.",
    );
  }
  return value;
}

function containsExactDevelopmentMarker(text: string, marker: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9])${marker}([^A-Za-z0-9]|$)`).test(text);
}

function chatContainsDevelopmentMarker(
  container: HTMLElement,
  input: HTMLElement | null,
  marker: string,
): boolean {
  if (containsExactDevelopmentMarker(composerDraft(input), marker)) return true;
  return [...container.querySelectorAll(".systemsculpt-agent-turn")]
    .some((turn) => containsExactDevelopmentMarker(turn.textContent ?? "", marker));
}

function requireDevelopmentChatOwnership(ctx: ActionContext): DevelopmentChatOwnership {
  const ownership = developmentChatOwners.get(ctx.app);
  if (!ownership) {
    throw new DriverActionError("No development-test chat is owned.");
  }
  return ownership;
}

function claimDevelopmentChatId(ownership: DevelopmentChatOwnership): void {
  const chatId = ownership.view.chatId.trim();
  if (!chatId) return;
  if (!ownership.submissionAttempted && !ownership.runObserved) {
    throw new DriverActionError(
      "The development chat changed identity before the owned submission.",
    );
  }
  if (ownership.ownedChatId && ownership.ownedChatId !== chatId) {
    throw new DriverActionError("The owned development chat identity changed.");
  }
  ownership.ownedChatId = chatId;
}

function requireCurrentDevelopmentChatMarker(
  ctx: ActionContext,
  ownership: DevelopmentChatOwnership,
): { container: HTMLElement; input: HTMLElement | null } {
  const container = chatContainer(ctx.app);
  const input = resolveTarget(ctx, "chat.composer.input");
  if (
    activeChatView(ctx) !== ownership.view
    || !container
    || !input
    || !chatContainsDevelopmentMarker(container, input, ownership.marker)
  ) {
    throw new DriverActionError(
      "The active chat does not contain the owned development-test marker.",
    );
  }
  claimDevelopmentChatId(ownership);
  return { container, input };
}

/**
 * Send clears the composer synchronously, while the optimistic user turn may
 * enter the DOM on the next task. Bridge only that short, owned handoff. Once
 * the marker is visible again, the ordinary strict ownership check resumes.
 */
async function waitForSubmittedDevelopmentChatMarker(
  ctx: ActionContext,
  ownership: DevelopmentChatOwnership,
  timeoutMs: number,
): Promise<void> {
  const container = chatContainer(ctx.app);
  const input = resolveTarget(ctx, "chat.composer.input");
  if (activeChatView(ctx) !== ownership.view || !container || !input) {
    throw new DriverActionError(
      "The active chat does not contain the owned development-test marker.",
    );
  }
  const requestedTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0;
  const handoffTimeoutMs = Math.min(
    requestedTimeoutMs,
    DEVELOPMENT_MARKER_HANDOFF_TIMEOUT_MS,
  );
  const startedAt = Date.now();
  for (;;) {
    throwIfActionCancelled(ctx);
    const currentContainer = chatContainer(ctx.app);
    const currentInput = resolveTarget(ctx, "chat.composer.input");
    if (
      activeChatView(ctx) !== ownership.view
      || currentContainer !== container
      || currentInput !== input
    ) {
      throw new DriverActionError(
        "The active chat does not contain the owned development-test marker.",
      );
    }
    const currentChatId = ownership.view.chatId.trim();
    if (
      ownership.ownedChatId
      && currentChatId
      && ownership.ownedChatId !== currentChatId
    ) {
      throw new DriverActionError("The owned development chat identity changed.");
    }
    if (chatContainsDevelopmentMarker(container, input, ownership.marker)) {
      claimDevelopmentChatId(ownership);
      return;
    }
    const elapsedMs = Date.now() - startedAt;
    if (
      !ownership.submissionAttempted
      || !ownership.submissionBaseline
      || elapsedMs >= handoffTimeoutMs
    ) {
      throw new DriverActionError(
        "The active chat does not contain the owned development-test marker.",
      );
    }
    await sleep(Math.min(20, Math.max(1, handoffTimeoutMs - elapsedMs)));
  }
}

function requireAskApprovalMode(ctx: ActionContext): void {
  const mode = resolveTarget(ctx, "chat.run.mode");
  if (activeChatView(ctx)?.approvalMode !== "ask" || mode?.dataset.mode !== "ask") {
    throw new DriverActionError("Live development tests require Ask approval mode.");
  }
}

const HOSTED_APPROVAL_MODE_LABELS: Readonly<Record<string, string>> = {
  auto: "Auto",
  ask: "Ask",
  "full-access": "Full access",
};

/** Chooses a hosted mode the way a person does: the run line's mode menu. */
async function selectHostedApprovalMode(
  ctx: ActionContext,
  view: DevelopmentChatView,
  mode: string,
  timeoutMs = 5000,
): Promise<void> {
  if (view.approvalMode === mode) return;
  if (!HOSTED_APPROVAL_MODE_LABELS[mode]) throw new DriverActionError("The required approval mode is unavailable.");
  pointerSequence(requireTarget(ctx, "chat.run.mode"));
  const ownerDocument = view.containerEl.ownerDocument;
  const startedAt = Date.now();
  for (;;) {
    const item = ownerDocument.querySelector<HTMLElement>(`.menu [data-menu-item="mode.${mode}"]`)
      ?.closest<HTMLElement>(".menu-item");
    if (item) {
      pointerSequence(item);
      break;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new DriverActionError("The run line's mode menu did not open.");
    }
    await sleep(20);
  }
  while (view.approvalMode !== mode) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new DriverActionError("The approval mode did not change.");
    }
    await sleep(20);
  }
}

async function waitForBlankDevelopmentChat(
  ctx: ActionContext,
  newChatLoaded: () => boolean,
  timeoutMs = 10000,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const container = chatContainer(ctx.app);
    const input = resolveTarget(ctx, "chat.composer.input");
    const stop = resolveTarget(ctx, "chat.composer.stop");
    const mode = resolveTarget(ctx, "chat.run.mode");
    const blank = container !== null
      && newChatLoaded()
      && input !== null
      && isVisible(input)
      && composerDraft(input).length === 0
      && (!stop || !isVisible(stop))
      && container.querySelectorAll(".systemsculpt-agent-turn").length === 0
      && container.querySelector(
        '[data-testid="chat.composer.attachment.remove"], '
          + '[data-testid="chat.composer.attachment.unpin"]',
      ) === null
      && mode !== null;
    if (blank) return;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new DriverActionError("New Chat did not establish a blank development-test chat.");
    }
    await sleep(100);
  }
}

async function openBlankDevelopmentChat(
  ctx: ActionContext,
  view: DevelopmentChatView,
  newChat: HTMLElement,
): Promise<void> {
  let loaded = false;
  // The old composer can already look blank while New Chat is still awaiting
  // session replacement. Its lifecycle event follows the final draft reset.
  const loadedRef = ctx.app.workspace.on("systemsculpt:chat-loaded", (chatId) => {
    if (chatId === "" && activeChatView(ctx) === view) loaded = true;
  });
  try {
    newChat.scrollIntoView({ block: "nearest" });
    pointerSequence(newChat);
    return await waitForBlankDevelopmentChat(ctx, () => loaded);
  } finally {
    ctx.app.workspace.offref(loadedRef);
  }
}

async function restoreDevelopmentChat(
  ctx: ActionContext,
  ownership: DevelopmentChatOwnership,
): Promise<void> {
  if (ownership.previousChatId) {
    await ownership.view.loadChatById(ownership.previousChatId);
    return;
  }
  const newChat = requireTarget(ctx, "chat.header.new");
  await openBlankDevelopmentChat(ctx, ownership.view, newChat);
  await selectHostedApprovalMode(ctx, ownership.view, ownership.initialApprovalMode);
}

async function beginDevelopmentChat(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const marker = validatedDevelopmentMarker(params.marker);
  if (developmentChatOwners.has(ctx.app)) {
    throw new DriverActionError("A development-test chat is already owned.");
  }
  const developmentRoot = `${DEVELOPMENT_TEST_PREFIX}${marker}`;
  if (ctx.app.vault.getAbstractFileByPath(developmentRoot)) {
    throw new DriverActionError(
      `Refusing to reuse the existing development-test root "${developmentRoot}".`,
    );
  }
  const view = activeChatView(ctx);
  if (!view) throw new DriverActionError("Chat must be open before starting a development test.");
  const previousChatId = view.chatId;
  const container = chatContainer(ctx.app);
  if (!container) throw new DriverActionError("Chat must be open before starting a development test.");
  const input = resolveTarget(ctx, "chat.composer.input");
  const stop = resolveTarget(ctx, "chat.composer.stop");
  if (stop && isVisible(stop)) {
    throw new DriverActionError(
      "Refusing to start a development test while the current chat has an active run.",
    );
  }
  if (composerDraft(input).length > 0) {
    throw new DriverActionError(
      "Refusing to start a development test while the current chat has a draft.",
    );
  }
  if (container.querySelector(
    '[data-testid="chat.composer.attachment.remove"], '
      + '[data-testid="chat.composer.attachment.unpin"]',
  )) {
    throw new DriverActionError(
      "Refusing to start a development test while the current chat has attachments.",
    );
  }
  if (!previousChatId && container.querySelectorAll(".systemsculpt-agent-turn").length > 0) {
    throw new DriverActionError(
      "Refusing to replace an unsaved chat that already contains messages.",
    );
  }
  if (!HOSTED_APPROVAL_MODE_LABELS[view.approvalMode]) {
    throw new DriverActionError("The current chat approval mode is unavailable.");
  }

  const newChat = requireTarget(ctx, "chat.header.new");
  const ownership: DevelopmentChatOwnership = {
    approvalClearedAfterGrant: false,
    approvalGranted: false,
    approvedDevelopmentDirectories: new Set(),
    approvedDevelopmentPaths: new Map(),
    approvedDevelopmentRootEstablished: false,
    approvedMutationCount: 0,
    approvedTrashArtifacts: new Map(),
    cleanupProgress: null,
    initialApprovalMode: view.approvalMode,
    marker,
    ownedChatId: null,
    previousChatId,
    runObserved: false,
    submissionBaseline: null,
    submissionAttempted: false,
    toolCaptureOwned: false,
    view,
  };
  developmentChatOwners.set(ctx.app, ownership);
  try {
    await openBlankDevelopmentChat(ctx, view, newChat);
    await selectHostedApprovalMode(ctx, view, "ask");
    const ownedInput = requireTarget(ctx, "chat.composer.input");
    setNativeValue(ownedInput, marker, "replace");
    if (!toolLifecycleCaptures.has(ctx.app)) {
      startToolLifecycleCapture(ctx);
      ownership.toolCaptureOwned = true;
    }
    return { owned: true, composerReady: true, markerInstalled: true };
  } catch (error) {
    let restoreError: unknown = null;
    try {
      await restoreDevelopmentChat(ctx, ownership);
    } catch (failure) {
      restoreError = failure;
    } finally {
      if (ownership.toolCaptureOwned) endToolLifecycleCapture(ctx);
      pendingRunSubmissions.delete(ctx.app);
      developmentChatOwners.delete(ctx.app);
    }
    if (restoreError) {
      throw new DriverActionError(
        `Development-chat setup failed: ${errorMessage(error)} `
          + `Previous-chat restoration failed: ${errorMessage(restoreError)}`,
      );
    }
    throw error;
  }
}

function typeDevelopmentDraft(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const ownership = requireDevelopmentChatOwnership(ctx);
  const input = requireTarget(ctx, "chat.composer.input");
  requireCurrentDevelopmentChatMarker(ctx, ownership);
  if (typeof params.text !== "string" || params.text.trim().length === 0) {
    throw new DriverActionError("chat.typeDevelopmentDraft requires text.");
  }
  const text = `${ownership.marker} ${params.text.trim()}`;
  setNativeValue(input, text, "replace");
  if (params.submit === true) {
    requireAskApprovalMode(ctx);
    const send = requireTarget(ctx, "chat.composer.send");
    if (!send.instanceOf(HTMLButtonElement) || send.disabled) {
      throw new DriverActionError("The development-test message is not ready to send.");
    }
    ownership.approvalClearedAfterGrant = false;
    ownership.approvalGranted = false;
    ownership.runObserved = false;
    ownership.submissionAttempted = true;
    const submissionBaseline = captureRunSubmissionBaseline(ctx);
    pointerSequence(send);
    ownership.submissionBaseline = submissionBaseline;
    pendingRunSubmissions.set(ctx.app, submissionBaseline);
    claimDevelopmentChatId(ownership);
  }
  return { characters: text.length, submitted: params.submit === true };
}

async function waitForDisconnect(element: HTMLElement, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (element.isConnected) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new DriverActionError("Timed out removing a development-test attachment.");
    }
    await sleep(50);
  }
}

interface DevelopmentVaultNode {
  children?: unknown;
  path: string;
}

function asDevelopmentVaultNode(value: unknown): DevelopmentVaultNode {
  if (
    typeof value !== "object"
    || value === null
    || typeof (value as { path?: unknown }).path !== "string"
  ) {
    throw new DriverActionError("Development cleanup could not inspect the marker folder tree.");
  }
  return value as DevelopmentVaultNode;
}

function addApprovedDevelopmentDirectories(
  directories: Set<string>,
  rootPath: string,
  path: string,
  includePath: boolean,
): void {
  if (!path.startsWith(`${rootPath}/`)) {
    throw new DriverActionError("Approved development state escaped its marker root.");
  }
  const segments = path.slice(rootPath.length + 1).split("/");
  let directory = rootPath;
  const directorySegments = includePath ? segments : segments.slice(0, -1);
  for (const segment of directorySegments) {
    directory = `${directory}/${segment}`;
    directories.add(directory);
  }
}

function recordApprovedDevelopmentFile(
  ownership: DevelopmentChatOwnership,
  path: string,
  text: string,
): void {
  const rootPath = `${DEVELOPMENT_TEST_PREFIX}${ownership.marker}`;
  addApprovedDevelopmentDirectories(
    ownership.approvedDevelopmentDirectories,
    rootPath,
    path,
    false,
  );
  ownership.approvedDevelopmentPaths.set(path, text);
  ownership.approvedDevelopmentRootEstablished = true;
}

function exactDevelopmentTreePaths(rootValue: unknown, rootPath: string): {
  directoryPaths: string[];
  leafPaths: string[];
} {
  const root = asDevelopmentVaultNode(rootValue);
  if (root.path !== rootPath || !Array.isArray(root.children)) {
    throw new DriverActionError(
      "Refusing to trash a development root whose descendants cannot be proven.",
    );
  }
  const directoryPaths: string[] = [];
  const leaves: string[] = [];
  const visit = (value: unknown, parentPath: string): void => {
    const node = asDevelopmentVaultNode(value);
    const directChild = node.path.startsWith(`${parentPath}/`)
      && !node.path.slice(parentPath.length + 1).includes("/");
    if (!directChild) {
      throw new DriverActionError(
        "Refusing to trash a development root containing an out-of-scope descendant.",
      );
    }
    if (Array.isArray(node.children)) {
      directoryPaths.push(node.path);
      for (const child of node.children) visit(child, node.path);
      return;
    }
    leaves.push(node.path);
  };
  for (const child of root.children) visit(child, rootPath);
  return { directoryPaths, leafPaths: leaves };
}

async function proveExactApprovedDevelopmentTree(
  ctx: ActionContext,
  rootValue: unknown,
  rootPath: string,
  approved: Map<string, string>,
  approvedDirectories: ReadonlySet<string>,
  rootEstablished: boolean,
): Promise<void> {
  if (!rootEstablished) {
    throw new DriverActionError(
      "Refusing to trash a development root without an owned approved write.",
    );
  }
  const { directoryPaths, leafPaths } = exactDevelopmentTreePaths(rootValue, rootPath);
  const uniqueLeaves = new Set(leafPaths);
  const uniqueDirectories = new Set(directoryPaths);
  if (
    uniqueLeaves.size !== leafPaths.length
    || uniqueDirectories.size !== directoryPaths.length
    || [...uniqueLeaves].some((path) => uniqueDirectories.has(path))
    || uniqueLeaves.size !== approved.size
    || [...uniqueLeaves].some((path) => !approved.has(path))
    || uniqueDirectories.size !== approvedDirectories.size
    || [...uniqueDirectories].some((path) => !approvedDirectories.has(path))
  ) {
    throw new DriverActionError(
      "Refusing to trash a development root with unapproved or missing descendants.",
    );
  }
  for (const [path, expectedText] of approved) {
    const actual = await ctx.app.vault.adapter.read(path);
    if (actual !== expectedText) {
      throw new DriverActionError(
        `Refusing to trash development content that no longer matches its approved write: "${path}".`,
      );
    }
  }
}

async function waitForOwnedHistoryEntry(
  ctx: ActionContext,
  ownedChatId: string,
  timeoutMs: number,
): Promise<HTMLElement> {
  const expectedEntryId = `chat:${ownedChatId}`;
  const startedAt = Date.now();
  for (;;) {
    throwIfActionCancelled(ctx);
    const rows = queryElements(
      ctx,
      '.systemsculpt-history-item[data-kind="chat"]',
    ).filter(isVisible);
    if (rows.length === 1 && rows[0]?.dataset.entryId === expectedEntryId) {
      return rows[0];
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new DriverActionError(
        "Visible history did not resolve the exact owned development-test chat.",
      );
    }
    await sleep(50);
  }
}

/**
 * Reopens the exact marker-owned chat by clicking its visible history row.
 * The history provider owns leaf selection and disk-backed resume behavior,
 * matching the path a person exercises from the modal.
 */
async function reopenOwnedDevelopmentHistory(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const ownership = requireDevelopmentChatOwnership(ctx);
  const { container } = requireCurrentDevelopmentChatMarker(ctx, ownership);
  const ownedChatId = ownership.ownedChatId;
  if (!ownedChatId || ownership.view.chatId !== ownedChatId) {
    throw new DriverActionError(
      "The development run has not claimed an exact saved-chat identity.",
    );
  }
  const expectedPath = ownership.view.getExpectedChatHistoryFilePath();
  if (!expectedPath || ownership.view.getChatHistoryFilePath() !== expectedPath) {
    throw new DriverActionError(
      "The owned development-test chat is not durably saved yet.",
    );
  }
  const stop = resolveTarget(ctx, "chat.composer.stop");
  if (stop && isVisible(stop)) {
    throw new DriverActionError(
      "Refusing to reload an owned development-test chat with an active run.",
    );
  }
  const input = resolveTarget(ctx, "chat.composer.input");
  if (composerDraft(input).length > 0) {
    throw new DriverActionError(
      "Refusing to reload an owned development-test chat with a draft.",
    );
  }
  if (container.querySelector(
    '[data-testid="chat.composer.attachment.remove"], '
      + '[data-testid="chat.composer.attachment.unpin"]',
  )) {
    throw new DriverActionError(
      "Refusing to reload an owned development-test chat with attachments.",
    );
  }

  const timeoutMs = typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
    ? Math.max(0, params.timeoutMs)
    : 10000;
  let restored = false;
  try {
    const newChat = requireTarget(ctx, "chat.header.new");
    await openBlankDevelopmentChat(ctx, ownership.view, newChat);

    const history = requireTarget(ctx, "chat.header.history");
    history.scrollIntoView({ block: "nearest" });
    pointerSequence(history);
    await waitForCondition(ctx, {
      target: "history.search",
      state: "visible",
      timeoutMs,
    });
    const search = requireTarget(ctx, "history.search");
    setNativeValue(search, ownership.marker, "replace");
    const ownedHistoryEntry = await waitForOwnedHistoryEntry(ctx, ownedChatId, timeoutMs);

    let loaded = false;
    const loadedRef = ctx.app.workspace.on("systemsculpt:chat-loaded", (chatId) => {
      if (chatId === ownedChatId && activeChatView(ctx) === ownership.view) loaded = true;
    });
    try {
      ownedHistoryEntry.scrollIntoView({ block: "nearest" });
      pointerSequence(ownedHistoryEntry);
      const startedAt = Date.now();
      while (!loaded) {
        throwIfActionCancelled(ctx);
        if (Date.now() - startedAt >= timeoutMs) {
          throw new DriverActionError(
            "The exact owned development-test history row did not emit its loaded event.",
          );
        }
        await sleep(50);
      }
      await waitForVisibilitySafely(ctx, "history.close", "hidden", timeoutMs);
    } finally {
      ctx.app.workspace.offref(loadedRef);
    }
    requireCurrentDevelopmentChatMarker(ctx, ownership);
    if (
      ownership.view.chatId !== ownedChatId
      || ownership.view.getExpectedChatHistoryFilePath() !== expectedPath
      || ownership.view.getChatHistoryFilePath() !== expectedPath
    ) {
      throw new DriverActionError(
        "The reopened development-test chat did not preserve its exact saved identity.",
      );
    }
    restored = true;
    return {
      reopened: true,
      visibleHistoryMatched: true,
      exactIdentityPreserved: true,
      markerRestored: true,
    };
  } catch (error) {
    const close = resolveTarget(ctx, "history.close");
    if (close && isVisible(close)) pointerSequence(close);
    if (!restored) {
      try {
        await ownership.view.loadChatById(ownedChatId);
        requireCurrentDevelopmentChatMarker(ctx, ownership);
      } catch (recoveryError) {
        throw new DriverActionError(
          `Owned-history reopen failed: ${errorMessage(error)} `
            + `Owned-chat recovery failed: ${errorMessage(recoveryError)}`,
        );
      }
    }
    throw error;
  }
}

function exactReceiptRecord(value: unknown): DevelopmentChatOwnershipReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DriverActionError("The development ownership receipt is invalid.");
  }
  const receipt = value as Record<string, unknown>;
  const expectedKeys = [
    "chatPath",
    "chatSha256",
    "initialApprovalMode",
    "marker",
    "ownedChatId",
    "previousChatId",
    "version",
  ];
  if (
    Object.keys(receipt).length !== expectedKeys.length
    || expectedKeys.some((key) => !(key in receipt))
    || receipt.version !== 1
    || typeof receipt.ownedChatId !== "string"
    || receipt.ownedChatId.length === 0
    || receipt.ownedChatId.length > 256
    || receipt.ownedChatId.includes("/")
    || receipt.ownedChatId.includes("\\")
    || typeof receipt.previousChatId !== "string"
    || receipt.previousChatId.length > 256
    || receipt.previousChatId.includes("/")
    || receipt.previousChatId.includes("\\")
    || receipt.previousChatId === receipt.ownedChatId
    || typeof receipt.initialApprovalMode !== "string"
    || receipt.initialApprovalMode.length === 0
    || receipt.initialApprovalMode.length > 64
    || typeof receipt.chatSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(receipt.chatSha256)
  ) {
    throw new DriverActionError("The development ownership receipt is invalid.");
  }
  const marker = validatedDevelopmentMarker(receipt.marker);
  const chatPath = validatedVaultPath(receipt.chatPath);
  if (!chatPath.endsWith(".md")) {
    throw new DriverActionError("The development ownership receipt is invalid.");
  }
  return {
    version: 1,
    marker,
    ownedChatId: receipt.ownedChatId,
    previousChatId: receipt.previousChatId,
    initialApprovalMode: receipt.initialApprovalMode,
    chatPath,
    chatSha256: receipt.chatSha256,
  };
}

async function exportDevelopmentOwnershipReceipt(
  ctx: ActionContext,
): Promise<DevelopmentChatOwnershipReceipt> {
  const ownership = requireDevelopmentChatOwnership(ctx);
  const { container, input } = requireCurrentDevelopmentChatMarker(ctx, ownership);
  if (
    ownership.cleanupProgress
    || ownership.approvedMutationCount !== 0
    || ownership.approvedDevelopmentPaths.size !== 0
    || ownership.approvedDevelopmentDirectories.size !== 0
    || ownership.approvedTrashArtifacts.size !== 0
  ) {
    throw new DriverActionError(
      "Development ownership can cross a reload only before cleanup and without vault mutations.",
    );
  }
  const ownedChatId = ownership.ownedChatId;
  const chatPath = ownership.view.getChatHistoryFilePath();
  if (
    !ownedChatId
    || ownership.view.chatId !== ownedChatId
    || !chatPath
    || ownership.view.getExpectedChatHistoryFilePath() !== chatPath
  ) {
    throw new DriverActionError("The owned development chat is not durably saved.");
  }
  const stop = resolveTarget(ctx, "chat.composer.stop");
  if (
    (stop && isVisible(stop))
    || composerDraft(input).length > 0
    || container.querySelector(
      '[data-testid="chat.composer.attachment.remove"], '
        + '[data-testid="chat.composer.attachment.unpin"]',
    )
  ) {
    throw new DriverActionError("The owned development chat is not idle for reload.");
  }
  const text = await ctx.app.vault.adapter.read(chatPath);
  if (
    !containsExactDevelopmentMarker(text, ownership.marker)
    || !text.includes("<!-- SYSTEMSCULPT-MESSAGE-START")
  ) {
    throw new DriverActionError("The saved development chat does not match its ownership proof.");
  }
  if (ownership.toolCaptureOwned) {
    endToolLifecycleCapture(ctx);
    ownership.toolCaptureOwned = false;
  }
  return {
    version: 1,
    marker: ownership.marker,
    ownedChatId,
    previousChatId: ownership.previousChatId,
    initialApprovalMode: ownership.initialApprovalMode,
    chatPath,
    chatSha256: sha256OfText(text),
  };
}

async function importDevelopmentOwnershipReceipt(
  ctx: ActionContext,
  value: unknown,
): Promise<Record<string, unknown>> {
  const receipt = exactReceiptRecord(value);
  const existing = developmentChatOwners.get(ctx.app);
  const view = existing?.view ?? activeChatView(ctx);
  if (!view) throw new DriverActionError("Chat must be open before restoring development ownership.");
  if (existing) {
    if (
      existing.marker !== receipt.marker
      || existing.ownedChatId !== receipt.ownedChatId
      || existing.previousChatId !== receipt.previousChatId
      || existing.initialApprovalMode !== receipt.initialApprovalMode
      || existing.view.getExpectedChatHistoryFilePath() !== receipt.chatPath
    ) {
      throw new DriverActionError("A different development-test chat is already owned.");
    }
  }
  if (view.chatId !== receipt.ownedChatId) await view.loadChatById(receipt.ownedChatId);
  if (
    activeChatView(ctx) !== view
    || view.chatId !== receipt.ownedChatId
    || view.getExpectedChatHistoryFilePath() !== receipt.chatPath
    || view.getChatHistoryFilePath() !== receipt.chatPath
  ) {
    throw new DriverActionError("The reloaded chat does not match its ownership proof.");
  }
  const text = await ctx.app.vault.adapter.read(receipt.chatPath);
  if (
    sha256OfText(text) !== receipt.chatSha256
    || !containsExactDevelopmentMarker(text, receipt.marker)
    || !text.includes("<!-- SYSTEMSCULPT-MESSAGE-START")
  ) {
    throw new DriverActionError("The reloaded chat changed since its ownership proof.");
  }
  const container = chatContainer(ctx.app);
  const input = resolveTarget(ctx, "chat.composer.input");
  if (
    activeChatView(ctx) !== view
    || !container
    || !input
    || !chatContainsDevelopmentMarker(container, input, receipt.marker)
  ) {
    throw new DriverActionError("The reloaded chat does not contain its ownership marker.");
  }
  const stop = resolveTarget(ctx, "chat.composer.stop");
  if (
    (stop && isVisible(stop))
    || composerDraft(input).length > 0
    || container.querySelector(
      '[data-testid="chat.composer.attachment.remove"], '
        + '[data-testid="chat.composer.attachment.unpin"]',
    )
  ) {
    throw new DriverActionError("The reloaded development chat is not idle.");
  }
  if (!HOSTED_APPROVAL_MODE_LABELS[receipt.initialApprovalMode] || !resolveTarget(ctx, "chat.run.mode")) {
    throw new DriverActionError("The prior approval mode cannot be restored safely.");
  }
  if (existing) {
    return {
      restored: true,
      alreadyOwned: true,
      exactChatBytesPreserved: true,
      markerRestored: true,
    };
  }
  developmentChatOwners.set(ctx.app, {
    approvalClearedAfterGrant: false,
    approvalGranted: false,
    approvedDevelopmentDirectories: new Set(),
    approvedDevelopmentPaths: new Map(),
    approvedDevelopmentRootEstablished: false,
    approvedMutationCount: 0,
    approvedTrashArtifacts: new Map(),
    cleanupProgress: null,
    initialApprovalMode: receipt.initialApprovalMode,
    marker: receipt.marker,
    ownedChatId: receipt.ownedChatId,
    previousChatId: receipt.previousChatId,
    runObserved: true,
    submissionBaseline: null,
    submissionAttempted: true,
    toolCaptureOwned: false,
    view,
  });
  return {
    restored: true,
    exactChatBytesPreserved: true,
    markerRestored: true,
  };
}

function developmentCleanupProgress(
  ownership: DevelopmentChatOwnership,
  requestedTrashSavedChat: boolean,
  requestedDevelopmentPath: string | null,
): DevelopmentCleanupProgress {
  const existing = ownership.cleanupProgress;
  if (existing) {
    if (
      existing.requestedTrashSavedChat !== requestedTrashSavedChat
      || existing.requestedDevelopmentPath !== requestedDevelopmentPath
    ) {
      throw new DriverActionError(
        "A retry must use the exact cleanup request already bound to this development-test chat.",
      );
    }
    return existing;
  }
  const progress: DevelopmentCleanupProgress = {
    chatCleanupComplete: !requestedTrashSavedChat,
    developmentPathCleanupComplete: requestedDevelopmentPath === null,
    draftCleared: false,
    ownedChatPath: null,
    removedAttachments: 0,
    requestedDevelopmentPath,
    requestedTrashSavedChat,
    restorationComplete: false,
    stoppedRun: false,
    toolCaptureEnded: false,
    toolLifecycle: null,
    trashedChat: false,
    trashedDevelopmentPath: false,
    uiCleanupComplete: false,
  };
  ownership.cleanupProgress = progress;
  return progress;
}

function finishDevelopmentToolCapture(
  ctx: ActionContext,
  ownership: DevelopmentChatOwnership,
  progress: DevelopmentCleanupProgress,
): void {
  if (progress.toolCaptureEnded) return;
  if (!toolLifecycleCaptures.has(ctx.app)) {
    ownership.toolCaptureOwned = false;
    progress.toolCaptureEnded = true;
    return;
  }
  if (!ownership.toolCaptureOwned) {
    progress.toolLifecycle = toolLifecycleReport(ctx);
    progress.toolCaptureEnded = true;
    return;
  }
  try {
    progress.toolLifecycle = endToolLifecycleCapture(ctx);
  } finally {
    ownership.toolCaptureOwned = false;
    progress.toolCaptureEnded = true;
  }
}

async function resetDevelopmentChatState(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const marker = validatedDevelopmentMarker(params.marker);
  if (params.requireOwned !== undefined && typeof params.requireOwned !== "boolean") {
    throw new DriverActionError("requireOwned must be a boolean.");
  }
  const ownership = developmentChatOwners.get(ctx.app);
  if (!ownership) {
    if (params.requireOwned === true) {
      throw new DriverActionError(
        "The exact development-test ownership proof is unavailable; cleanup did not run.",
      );
    }
    return { owned: false, skipped: true };
  }
  if (ownership.marker !== marker) {
    throw new DriverActionError(
      "The cleanup marker does not match the owned development-test chat.",
    );
  }
  const trashDevelopmentPath = params.trashDevelopmentPath === undefined
    ? null
    : developmentMarkerFromPath(params.trashDevelopmentPath, true);
  const expectedDevelopmentRoot = `${DEVELOPMENT_TEST_PREFIX}${ownership.marker}`;
  if (
    trashDevelopmentPath
    && (
      trashDevelopmentPath.marker !== ownership.marker
      || trashDevelopmentPath.path !== expectedDevelopmentRoot
    )
  ) {
    throw new DriverActionError(
      "Development cleanup may trash only the exact owned marker folder.",
    );
  }
  if (ownership.approvedMutationCount > 0 && !trashDevelopmentPath) {
    throw new DriverActionError(
      "Approved development mutations require cleanup of the exact owned marker folder.",
    );
  }
  const progress = developmentCleanupProgress(
    ownership,
    params.trashSavedChat === true,
    trashDevelopmentPath?.path ?? null,
  );
  let captureError: unknown = null;
  try {
    finishDevelopmentToolCapture(ctx, ownership, progress);
  } catch (error) {
    captureError = error;
  }
  pendingRunSubmissions.delete(ctx.app);

  if (!progress.uiCleanupComplete) {
    const container = chatContainer(ctx.app);
    if (!container || activeChatView(ctx) !== ownership.view) {
      throw new DriverActionError(
        "The owned development-test chat is no longer open for cleanup; ownership was retained for retry.",
      );
    }
    const input = resolveTarget(ctx, "chat.composer.input");
    const stop = resolveTarget(ctx, "chat.composer.stop");
    const hasAttachments = container.querySelector(
      '[data-testid="chat.composer.attachment.remove"], '
        + '[data-testid="chat.composer.attachment.unpin"]',
    ) !== null;
    const untouched = composerDraft(input).length === 0
      && container.querySelectorAll(".systemsculpt-agent-turn").length === 0
      && (!stop || !isVisible(stop))
      && !hasAttachments;
    const marked = input !== null
      && chatContainsDevelopmentMarker(container, input, ownership.marker);
    if (!marked && !untouched) {
      throw new DriverActionError(
        "Refusing cleanup because the active chat is not the owned development-test chat; "
          + "ownership was retained for retry.",
      );
    }

    if (stop && isVisible(stop)) {
      requireCurrentDevelopmentChatMarker(ctx, ownership);
      if (!progress.stoppedRun) {
        pointerSequence(stop);
        progress.stoppedRun = true;
      }
      await waitForVisibilitySafely(ctx, "chat.composer.stop", "hidden", 15000);
    }

    for (;;) {
      const remove = container.querySelector(
        '[data-testid="chat.composer.attachment.remove"]',
      );
      if (!remove?.instanceOf(HTMLElement)) break;
      requireCurrentDevelopmentChatMarker(ctx, ownership);
      pointerSequence(remove);
      await waitForDisconnect(remove, 5000);
      progress.removedAttachments += 1;
    }

    if (marked && !progress.draftCleared) {
      const current = requireCurrentDevelopmentChatMarker(ctx, ownership).input;
      if (
        (current?.instanceOf(HTMLTextAreaElement) || current?.instanceOf(HTMLInputElement))
        && (current.disabled || current.readOnly)
      ) {
        throw new DriverActionError("The development-test composer input cannot be cleared.");
      }
      if (!current) {
        throw new DriverActionError("The development-test composer input is unavailable.");
      }
      setNativeValue(current, "", "replace");
      progress.draftCleared = true;
    }
    progress.uiCleanupComplete = true;
  }

  let cleanupError: unknown = captureError;
  let restoreError: unknown = null;
  if (!progress.chatCleanupComplete) {
    try {
      if (!progress.ownedChatPath) {
        if (!ownership.ownedChatId || ownership.view.chatId !== ownership.ownedChatId) {
          throw new DriverActionError(
            "Refusing to trash a chat whose identity was not owned by this development run.",
          );
        }
        const startedAt = Date.now();
        let path = ownership.view.getChatHistoryFilePath();
        const expectedPath = ownership.view.getExpectedChatHistoryFilePath();
        const shouldWaitForSave = ownership.submissionAttempted
          || ownership.runObserved
          || expectedPath !== null;
        while (!path && shouldWaitForSave && Date.now() - startedAt < 5000) {
          await sleep(100);
          path = ownership.view.getChatHistoryFilePath();
        }
        if (!path && shouldWaitForSave) {
          throw new DriverActionError(
            "The observed development run did not produce a saved chat for cleanup.",
          );
        }
        if (path && path !== ownership.view.getExpectedChatHistoryFilePath()) {
          throw new DriverActionError("The owned development chat path changed during cleanup.");
        }
        progress.ownedChatPath = path;
      }
      const path = progress.ownedChatPath;
      if (path) {
        const file = ctx.app.vault.getAbstractFileByPath(path);
        if (!file) {
          if (!progress.trashedChat) {
            throw new DriverActionError("The owned development chat disappeared during cleanup.");
          }
        } else {
          const content = await ctx.app.vault.adapter.read(path);
          if (
            !containsExactDevelopmentMarker(content, ownership.marker)
            || !content.includes("<!-- SYSTEMSCULPT-MESSAGE-START")
          ) {
            throw new DriverActionError(
              "Refusing to trash a chat that is not the owned development test.",
            );
          }
          await ctx.app.fileManager.trashFile(file);
          progress.trashedChat = true;
        }
      }
      progress.chatCleanupComplete = true;
    } catch (error) {
      cleanupError = cleanupError
        ? new DriverActionError(
          `Tool-capture cleanup failed: ${errorMessage(cleanupError)} `
            + `Chat cleanup failed: ${errorMessage(error)}`,
        )
        : error;
    }
  }

  if (!progress.developmentPathCleanupComplete && progress.requestedDevelopmentPath) {
    try {
      await restoreApprovedTrashArtifacts(ctx, ownership);
      const file = ctx.app.vault.getAbstractFileByPath(progress.requestedDevelopmentPath);
      if (!file) {
        if (
          ownership.approvedDevelopmentRootEstablished
          || ownership.approvedMutationCount > 0
        ) {
          throw new DriverActionError(
            "The exact owned development marker root is unavailable for cleanup.",
          );
        }
        progress.developmentPathCleanupComplete = true;
      } else {
        await proveExactApprovedDevelopmentTree(
          ctx,
          file,
          progress.requestedDevelopmentPath,
          ownership.approvedDevelopmentPaths,
          ownership.approvedDevelopmentDirectories,
          ownership.approvedDevelopmentRootEstablished,
        );
        await ctx.app.fileManager.trashFile(file);
        progress.trashedDevelopmentPath = true;
        progress.developmentPathCleanupComplete = true;
      }
    } catch (error) {
      cleanupError = cleanupError
        ? new DriverActionError(
          `Development cleanup failed: ${errorMessage(cleanupError)} `
            + `Development-folder cleanup failed: ${errorMessage(error)}`,
        )
        : error;
    }
  }

  const restorationCanProceed = progress.uiCleanupComplete
    && (progress.chatCleanupComplete || progress.ownedChatPath !== null);
  if (!progress.restorationComplete && restorationCanProceed) {
    try {
      await restoreDevelopmentChat(ctx, ownership);
      progress.restorationComplete = true;
    } catch (error) {
      restoreError = error;
    }
  }

  const complete = progress.uiCleanupComplete
    && progress.chatCleanupComplete
    && progress.developmentPathCleanupComplete
    && progress.restorationComplete;
  if (complete) {
    pendingRunSubmissions.delete(ctx.app);
    developmentChatOwners.delete(ctx.app);
  }
  if (cleanupError && restoreError) {
    throw new DriverActionError(
      `Development cleanup failed: ${errorMessage(cleanupError)} `
        + `Previous-chat restoration failed: ${errorMessage(restoreError)}`,
    );
  }
  if (cleanupError) throw asDriverActionError(cleanupError);
  if (restoreError) throw asDriverActionError(restoreError);
  if (!complete) {
    throw new DriverActionError(
      "Development cleanup remains incomplete; exact ownership was retained for retry.",
    );
  }
  return {
    owned: true,
    stoppedRun: progress.stoppedRun,
    removedAttachments: progress.removedAttachments,
    draftCleared: progress.draftCleared,
    approvalRestored: true,
    restoredPreviousChat: ownership.previousChatId.length > 0,
    trashedChat: progress.trashedChat,
    trashedDevelopmentPath: progress.trashedDevelopmentPath,
    toolLifecycle: progress.toolLifecycle,
  };
}

const DEVELOPMENT_MUTATION_TOOL_NAMES = [
  "create_folders",
  "edit",
  "multi_edit",
  "move",
  "trash",
] as const;

type DevelopmentMutationToolName = typeof DEVELOPMENT_MUTATION_TOOL_NAMES[number];

interface DevelopmentExactEdit {
  mode: "exact";
  newText: string;
  occurrence: "first";
  oldText: string;
}

interface DevelopmentMutationPlan {
  affectedPaths: ReadonlySet<string>;
  directories: Set<string>;
  files: Map<string, string>;
  trashArtifacts: ApprovedDevelopmentTrashArtifact[];
}

function exactMutationRecord(
  value: unknown,
  keys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DriverActionError("The exact development mutation input is malformed.");
  }
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record);
  if (
    actualKeys.some((key) => !keys.includes(key) && !optionalKeys.includes(key))
    || keys.some((key) => !Object.prototype.hasOwnProperty.call(record, key))
  ) {
    throw new DriverActionError("The exact development mutation input shape is unsupported.");
  }
  return record;
}

function exactMutationArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new DriverActionError("The exact development mutation batch is malformed.");
  }
  return value;
}

function ownedMutationPath(value: unknown, ownership: DevelopmentChatOwnership): string {
  const path = developmentMarkerFromPath(value);
  if (path.marker !== ownership.marker) {
    throw new DriverActionError(
      "Every development mutation path must remain inside the active marker root.",
    );
  }
  return path.path;
}

function exactDevelopmentEdits(value: unknown): readonly DevelopmentExactEdit[] {
  return exactMutationArray(value).map((entry) => {
    // Every optional FileEdit field may be echoed at its executor-resolved
    // default (models do this): occurrence "first", mode "exact", isRegex
    // false, preserveIndent true, and null flags/range are all byte-identical
    // to the trimmed input. Any resolved value that could change the effect —
    // another occurrence/mode, a truthy isRegex, real flags, a real range —
    // is still refused.
    const edit = exactMutationRecord(
      entry,
      ["oldText", "newText"],
      ["occurrence", "mode", "isRegex", "preserveIndent", "flags", "range"],
    );
    if (
      typeof edit.oldText !== "string"
      || edit.oldText.length === 0
      || typeof edit.newText !== "string"
      || (edit.occurrence ?? "first") !== "first"
      || (edit.mode ?? "exact") !== "exact"
      || (edit.isRegex ?? false) !== false
      || (edit.preserveIndent ?? true) !== true
      || (edit.flags ?? null) !== null
      || (edit.range ?? null) !== null
    ) {
      throw new DriverActionError(
        "Development edits require exact first-occurrence text replacements.",
      );
    }
    return {
      oldText: edit.oldText,
      newText: edit.newText,
      occurrence: "first",
      mode: "exact",
    };
  });
}

function applyDevelopmentEdits(
  content: string,
  edits: readonly DevelopmentExactEdit[],
): string {
  let next = content;
  for (const edit of edits) {
    const index = next.indexOf(edit.oldText);
    if (index < 0) {
      throw new DriverActionError(
        "The approved edit does not match the currently owned development content.",
      );
    }
    next = `${next.slice(0, index)}${edit.newText}${next.slice(index + edit.oldText.length)}`;
  }
  return next;
}

function developmentTrashCandidates(sourcePath: string): readonly string[] {
  const basename = sourcePath.split("/").pop();
  if (!basename) {
    throw new DriverActionError("The approved trash path has no file name.");
  }
  return [...new Set([`.trash/${sourcePath}`, `.trash/${basename}`])];
}

function planDevelopmentMutation(
  ownership: DevelopmentChatOwnership,
  toolName: DevelopmentMutationToolName,
  input: unknown,
): DevelopmentMutationPlan {
  if (!ownership.approvedDevelopmentRootEstablished) {
    throw new DriverActionError(
      "Development mutations require an exact owned seed write before approval.",
    );
  }
  const rootPath = `${DEVELOPMENT_TEST_PREFIX}${ownership.marker}`;
  const files = new Map(ownership.approvedDevelopmentPaths);
  const directories = new Set(ownership.approvedDevelopmentDirectories);
  const affectedPaths = new Set<string>();
  const trashArtifacts: ApprovedDevelopmentTrashArtifact[] = [];
  const recordPath = (value: unknown): string => {
    const path = ownedMutationPath(value, ownership);
    affectedPaths.add(path);
    return path;
  };

  if (toolName === "create_folders") {
    const record = exactMutationRecord(input, ["paths"]);
    const paths = exactMutationArray(record.paths).map(recordPath);
    for (const path of paths) {
      if (files.has(path)) {
        throw new DriverActionError("A development folder cannot replace an owned file.");
      }
      addApprovedDevelopmentDirectories(directories, rootPath, path, true);
    }
    return { affectedPaths, directories, files, trashArtifacts };
  }

  if (toolName === "edit") {
    // strict may be omitted or null: the vault executor resolves it to true.
    const record = exactMutationRecord(input, ["path", "edits"], ["strict"]);
    if ((record.strict ?? true) !== true) {
      throw new DriverActionError("Development edit approval requires strict mode.");
    }
    const path = recordPath(record.path);
    const content = files.get(path);
    if (content === undefined) {
      throw new DriverActionError("Development edit approval requires a tracked owned file.");
    }
    files.set(path, applyDevelopmentEdits(content, exactDevelopmentEdits(record.edits)));
    return { affectedPaths, directories, files, trashArtifacts };
  }

  if (toolName === "multi_edit") {
    const record = exactMutationRecord(input, ["files"]);
    const entries = exactMutationArray(record.files);
    const seen = new Set<string>();
    for (const entry of entries) {
      const file = exactMutationRecord(entry, ["path", "edits"], ["strict"]);
      if ((file.strict ?? true) !== true) {
        throw new DriverActionError("Development multi-edit approval requires strict mode.");
      }
      const path = recordPath(file.path);
      if (seen.has(path)) {
        throw new DriverActionError("Development multi-edit paths must be unique.");
      }
      seen.add(path);
      const content = files.get(path);
      if (content === undefined) {
        throw new DriverActionError(
          "Development multi-edit approval requires tracked owned files.",
        );
      }
      files.set(path, applyDevelopmentEdits(content, exactDevelopmentEdits(file.edits)));
    }
    return { affectedPaths, directories, files, trashArtifacts };
  }

  if (toolName === "move") {
    const record = exactMutationRecord(input, ["items"]);
    const entries = exactMutationArray(record.items);
    const sources = new Set<string>();
    const destinations = new Set<string>();
    for (const entry of entries) {
      const item = exactMutationRecord(entry, ["source", "destination"]);
      const source = recordPath(item.source);
      const destination = recordPath(item.destination);
      if (
        source === destination
        || sources.has(source)
        || destinations.has(destination)
        || files.has(destination)
        || directories.has(destination)
      ) {
        throw new DriverActionError("Development move approval has an ambiguous path plan.");
      }
      const content = files.get(source);
      if (content === undefined) {
        throw new DriverActionError("Development move approval requires a tracked owned file.");
      }
      sources.add(source);
      destinations.add(destination);
      files.delete(source);
      files.set(destination, content);
      addApprovedDevelopmentDirectories(directories, rootPath, destination, false);
    }
    return { affectedPaths, directories, files, trashArtifacts };
  }

  const record = exactMutationRecord(input, ["paths"]);
  const paths = exactMutationArray(record.paths).map(recordPath);
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path) || ownership.approvedTrashArtifacts.has(path)) {
      throw new DriverActionError("Development trash paths must be unique and newly owned.");
    }
    seen.add(path);
    const expectedText = files.get(path);
    if (expectedText === undefined) {
      throw new DriverActionError("Development trash approval requires a tracked owned file.");
    }
    files.delete(path);
    trashArtifacts.push({
      candidates: developmentTrashCandidates(path),
      expectedText,
      mirroredDirectoriesCleaned: false,
      restored: false,
      restoredCandidate: null,
      sourcePath: path,
    });
  }
  return { affectedPaths, directories, files, trashArtifacts };
}

/**
 * Plans the mutation the model actually requested from its captured canonical
 * input, or returns null when that input cannot be planned (malformed shape,
 * non-default semantics, an out-of-marker path, or an untracked file). A null
 * result must always refuse approval.
 */
function developmentMutationPlanFromCanonicalInput(
  ownership: DevelopmentChatOwnership,
  toolName: DevelopmentMutationToolName,
  canonicalInput: string,
): Readonly<{ plan: DevelopmentMutationPlan | null; failure: string | null }> {
  let input: unknown;
  try {
    input = JSON.parse(canonicalInput);
  } catch {
    return { plan: null, failure: "The canonical input is not valid JSON." };
  }
  try {
    return { plan: planDevelopmentMutation(ownership, toolName, input), failure: null };
  } catch (error) {
    if (error instanceof DriverActionError) return { plan: null, failure: error.message };
    throw error;
  }
}

/** Serializable summary of a plan for refusal evidence in error messages. */
function describeDevelopmentPlan(plan: DevelopmentMutationPlan | null): unknown {
  if (!plan) return null;
  return {
    affectedPaths: [...plan.affectedPaths].sort(),
    directories: [...plan.directories].sort(),
    files: Object.fromEntries(
      [...plan.files.entries()].sort(([left], [right]) => (left < right ? -1 : 1)),
    ),
    trashArtifacts: plan.trashArtifacts.map((artifact) => ({
      sourcePath: artifact.sourcePath,
      expectedText: artifact.expectedText,
      candidates: artifact.candidates,
    })),
  };
}

function developmentMutationPlansEqual(
  expected: DevelopmentMutationPlan,
  actual: DevelopmentMutationPlan | null,
): boolean {
  if (!actual) return false;
  const sameSet = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean =>
    left.size === right.size && [...left].every((value) => right.has(value));
  if (
    !sameSet(expected.affectedPaths, actual.affectedPaths)
    || !sameSet(expected.directories, actual.directories)
    || expected.files.size !== actual.files.size
  ) return false;
  for (const [path, text] of expected.files) {
    if (actual.files.get(path) !== text) return false;
  }
  return expected.trashArtifacts.length === actual.trashArtifacts.length
    && expected.trashArtifacts.every((artifact, index) => {
      const other = actual.trashArtifacts[index];
      return other !== undefined
        && artifact.sourcePath === other.sourcePath
        && artifact.expectedText === other.expectedText
        && artifact.candidates.length === other.candidates.length
        && artifact.candidates.every((candidate, at) => other.candidates[at] === candidate);
    });
}

function assertAllowedApproval(
  approvalButton: HTMLElement,
  allowedPath: unknown,
  allowedText?: unknown,
): string {
  const expectedPath = developmentMarkerFromPath(allowedPath).path;
  const tool = approvalButton.closest(".systemsculpt-agent-part.is-tool");
  const label = tool?.querySelector(".systemsculpt-agent-tool-label")?.textContent?.trim();
  const summary = tool?.querySelector(".systemsculpt-agent-tool-summary")?.textContent?.trim();
  const previewPath = tool
    ?.querySelector(".systemsculpt-agent-approval-preview .systemsculpt-diff-filename")
    ?.textContent
    ?.trim();
  if (label !== "Write file" || summary !== expectedPath || previewPath !== expectedPath) {
    throw new DriverActionError(
      "Refusing an approval that is not the exact owned development-test write.",
    );
  }
  if (typeof allowedText !== "string") {
    throw new DriverActionError("An exact development-test write preview is required.");
  }
  const added = tool?.querySelectorAll(
    ".systemsculpt-agent-approval-preview "
      + ".systemsculpt-diff-line-added .systemsculpt-diff-line-content",
  ) ?? [];
  if (added.length !== 1 || added[0]?.textContent !== allowedText) {
    throw new DriverActionError(
      "Refusing an approval whose write preview does not exactly match.",
    );
  }
  return expectedPath;
}

function approveDevelopmentWriteOnce(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const ownership = requireDevelopmentChatOwnership(ctx);
  requireCurrentDevelopmentChatMarker(ctx, ownership);
  requireAskApprovalMode(ctx);
  const allowed = developmentMarkerFromPath(params.path);
  if (allowed.marker !== ownership.marker) {
    throw new DriverActionError(
      "The approval path does not belong to the owned development-test marker.",
    );
  }
  const approval = revealActivityTarget(ctx, "chat.approval.allow-once");
  if (!approval || !isVisible(approval)) {
    throw new DriverActionError("The safe Allow once approval is unavailable.");
  }
  assertAllowedApproval(approval, params.path, params.text);
  pointerSequence(approval);
  recordApprovedDevelopmentFile(ownership, allowed.path, params.text as string);
  ownership.approvalGranted = true;
  ownership.approvalClearedAfterGrant = false;
  return { approved: true, path: allowed.path };
}

async function proveTrashApprovalPreconditions(
  ctx: ActionContext,
  ownership: DevelopmentChatOwnership,
  artifacts: readonly ApprovedDevelopmentTrashArtifact[],
): Promise<void> {
  if (artifacts.length === 0) return;
  const adapter = ctx.app.vault.adapter;
  const mirrorRoot = `.trash/${DEVELOPMENT_TEST_PREFIX}${ownership.marker}`;
  if (await adapter.exists(mirrorRoot)) {
    throw new DriverActionError(
      "The exact marker-scoped local-trash destination already exists.",
    );
  }
  const candidates = new Set<string>();
  for (const artifact of artifacts) {
    if (
      !await adapter.exists(artifact.sourcePath)
      || await adapter.read(artifact.sourcePath) !== artifact.expectedText
    ) {
      throw new DriverActionError(
        "The approved trash source does not match the tracked owned file.",
      );
    }
    for (const candidate of artifact.candidates) {
      if (candidates.has(candidate) || await adapter.exists(candidate)) {
        throw new DriverActionError(
          "The exact local-trash destination is ambiguous or already occupied.",
        );
      }
      candidates.add(candidate);
    }
  }
}

function mirroredTrashDirectories(
  ownership: DevelopmentChatOwnership,
  candidate: string,
): readonly string[] {
  const mirrorRoot = `.trash/${DEVELOPMENT_TEST_PREFIX}${ownership.marker}`;
  if (!candidate.startsWith(`${mirrorRoot}/`)) return [];
  const directories: string[] = [];
  let directory = candidate.slice(0, candidate.lastIndexOf("/"));
  while (directory === mirrorRoot || directory.startsWith(`${mirrorRoot}/`)) {
    directories.push(directory);
    if (directory === mirrorRoot) break;
    directory = directory.slice(0, directory.lastIndexOf("/"));
  }
  return directories;
}

async function waitForRestoredDevelopmentFile(
  ctx: ActionContext,
  sourcePath: string,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    throwIfActionCancelled(ctx);
    const file = ctx.app.vault.getAbstractFileByPath(sourcePath);
    if (file) {
      const node = asDevelopmentVaultNode(file);
      if (node.path === sourcePath && !Array.isArray(node.children)) return;
    }
    if (Date.now() - startedAt >= 5000) {
      throw new DriverActionError(
        "The restored development file did not reappear in the exact vault index.",
      );
    }
    await sleep(50);
  }
}

async function restoreApprovedTrashArtifacts(
  ctx: ActionContext,
  ownership: DevelopmentChatOwnership,
): Promise<void> {
  const adapter = ctx.app.vault.adapter;
  for (const artifact of ownership.approvedTrashArtifacts.values()) {
    if (!artifact.restored) {
      const sourceExists = await adapter.exists(artifact.sourcePath);
      const existingCandidates: string[] = [];
      for (const candidate of artifact.candidates) {
        if (await adapter.exists(candidate)) existingCandidates.push(candidate);
      }
      if (sourceExists) {
        if (existingCandidates.length !== 0) {
          throw new DriverActionError(
            "The approved trash artifact exists at both its source and local-trash destination.",
          );
        }
        if (await adapter.read(artifact.sourcePath) !== artifact.expectedText) {
          throw new DriverActionError(
            "The approved trash source no longer matches its tracked content.",
          );
        }
      } else {
        if (existingCandidates.length !== 1) {
          throw new DriverActionError(
            "The approved trash artifact has no unique exact local-trash destination.",
          );
        }
        const candidate = existingCandidates[0];
        if (await adapter.read(candidate) !== artifact.expectedText) {
          throw new DriverActionError(
            "The approved local-trash artifact no longer matches its tracked content.",
          );
        }
        await adapter.rename(candidate, artifact.sourcePath);
        if (
          !await adapter.exists(artifact.sourcePath)
          || await adapter.read(artifact.sourcePath) !== artifact.expectedText
        ) {
          throw new DriverActionError(
            "The approved local-trash artifact could not be restored exactly.",
          );
        }
        artifact.restoredCandidate = candidate;
      }
      await waitForRestoredDevelopmentFile(ctx, artifact.sourcePath);
      artifact.restored = true;
      artifact.mirroredDirectoriesCleaned = artifact.restoredCandidate === null;
      recordApprovedDevelopmentFile(
        ownership,
        artifact.sourcePath,
        artifact.expectedText,
      );
    }

    if (!artifact.mirroredDirectoriesCleaned) {
      if (!artifact.restoredCandidate) {
        throw new DriverActionError(
          "The approved local-trash cleanup state is incomplete.",
        );
      }
      for (const directory of mirroredTrashDirectories(
        ownership,
        artifact.restoredCandidate,
      )) {
        if (await adapter.exists(directory)) await adapter.rmdir(directory, false);
      }
      artifact.mirroredDirectoriesCleaned = true;
    }
  }
}

async function approveDevelopmentMutationOnce(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const ownership = requireDevelopmentChatOwnership(ctx);
  const { container } = requireCurrentDevelopmentChatMarker(ctx, ownership);
  requireAskApprovalMode(ctx);
  const expected = exactMutationRecord(params, ["toolName", "input"]);
  if (
    typeof expected.toolName !== "string"
    || !(DEVELOPMENT_MUTATION_TOOL_NAMES as readonly string[]).includes(expected.toolName)
  ) {
    throw new DriverActionError(
      "A supported exact development mutation tool name is required.",
    );
  }
  const toolName = expected.toolName as DevelopmentMutationToolName;
  revealActivityTarget(ctx, "chat.approval.allow-once");
  const pendingTools = [...container.querySelectorAll<HTMLElement>(
    ".systemsculpt-agent-turn.is-assistant.is-active "
      + ".systemsculpt-agent-part.is-tool.is-approval-required",
  )].filter(isVisible);
  const approvals = [...container.querySelectorAll<HTMLElement>(
    '[data-testid="chat.approval.allow-once"]',
  )].filter(isVisible);
  if (pendingTools.length !== 1 || approvals.length !== 1) {
    throw new DriverActionError(
      "Exactly one visible development mutation must be awaiting Allow once.",
    );
  }
  const approval = approvals[0];
  const tool = approval?.closest<HTMLElement>(
    ".systemsculpt-agent-part.is-tool.is-approval-required",
  ) ?? null;
  const activeTurn = tool?.closest<HTMLElement>(
    ".systemsculpt-agent-turn.is-assistant.is-active",
  ) ?? null;
  const toolCallId = tool ? canonicalToolCallId(tool.dataset.partKey ?? "") : null;
  if (
    !approval?.instanceOf(HTMLButtonElement)
    || approval.disabled
    || !tool
    || tool !== pendingTools[0]
    || !activeTurn
    || !toolCallId
  ) {
    throw new DriverActionError(
      "The visible Allow once control is not bound to one active canonical tool call.",
    );
  }
  const active = ownership.view.agent?.active;
  const identities = active?.toolIdentities;
  const decisions = active?.approvalDecisions;
  const identity = identities?.get(toolCallId);
  if (!identities || !decisions || !identity || decisions.has(toolCallId)) {
    throw new DriverActionError(
      "The active pending mutation identity is unavailable or already decided.",
    );
  }
  // Approval binds to the mutation's exact planned effect, not its raw input
  // bytes: the model may legally omit fields whose executor defaults it relied
  // on. Both inputs plan through the same marker-containment rules, and any
  // path, resulting byte, or trash-artifact difference still refuses.
  const plan = planDevelopmentMutation(ownership, toolName, expected.input);
  const visible = developmentMutationPlanFromCanonicalInput(
    ownership,
    toolName,
    identity.canonicalInput,
  );
  if (
    identity.toolName !== toolName
    || !developmentMutationPlansEqual(plan, visible.plan)
  ) {
    throw new DriverActionError(
      "The visible pending mutation does not exactly match the expected tool and input. "
        + `expectedTool=${JSON.stringify(toolName)}; `
        + `visibleTool=${JSON.stringify(identity.toolName)}; `
        + `visibleCanonicalInput=${JSON.stringify(identity.canonicalInput)}; `
        + `expectedPlan=${JSON.stringify(describeDevelopmentPlan(plan))}; `
        + `visiblePlan=${JSON.stringify(describeDevelopmentPlan(visible.plan))}; `
        + `visiblePlanFailure=${JSON.stringify(visible.failure)}`,
    );
  }
  await proveTrashApprovalPreconditions(ctx, ownership, plan.trashArtifacts);

  pointerSequence(approval);
  ownership.approvedDevelopmentPaths.clear();
  for (const [path, text] of plan.files) {
    ownership.approvedDevelopmentPaths.set(path, text);
  }
  ownership.approvedDevelopmentDirectories.clear();
  for (const path of plan.directories) ownership.approvedDevelopmentDirectories.add(path);
  for (const artifact of plan.trashArtifacts) {
    ownership.approvedTrashArtifacts.set(artifact.sourcePath, artifact);
  }
  ownership.approvedMutationCount += 1;
  ownership.approvalGranted = true;
  ownership.approvalClearedAfterGrant = false;
  return {
    approved: true,
    toolName,
    affectedPathCount: plan.affectedPaths.size,
    mutationIndex: ownership.approvedMutationCount,
  };
}

async function waitForDevelopmentRun(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 180000;
  const until = params.until;
  if (until !== "approval" && until !== "complete") {
    throw new DriverActionError(
      'chat.waitForDevelopmentRun requires until="approval" or "complete".',
    );
  }
  const ownership = requireDevelopmentChatOwnership(ctx);
  const startedAt = Date.now();
  await waitForSubmittedDevelopmentChatMarker(ctx, ownership, timeoutMs);
  requireAskApprovalMode(ctx);
  const approvalTransitionStartedAt = ownership.approvalGranted ? startedAt : null;
  for (;;) {
    throwIfActionCancelled(ctx);
    requireCurrentDevelopmentChatMarker(ctx, ownership);
    const snapshot = chatSnapshot(ctx, false);
    const stop = resolveTarget(ctx, "chat.composer.stop");
    const running = stop !== null && isVisible(stop);
    if (running) ownership.runObserved = true;
    const approval = revealActivityTarget(ctx, "chat.approval.allow-once");
    if (approval !== null && isVisible(approval)) {
      ownership.runObserved = true;
      if (until === "approval") {
        return {
          reached: "approval",
          waitedMs: Date.now() - startedAt,
          toolLifecycle: toolLifecycleCaptures.has(ctx.app) ? toolLifecycleReport(ctx) : null,
        };
      }
      if (ownership.approvalGranted && !ownership.approvalClearedAfterGrant) {
        const now = Date.now();
        if (
          now - startedAt >= timeoutMs
          || (approvalTransitionStartedAt !== null && now - approvalTransitionStartedAt >= 5000)
        ) {
          throw new DriverActionError("The granted Allow once approval did not clear.");
        }
        await sleep(100);
        continue;
      }
      throw new DriverActionError("The run requires explicit Allow once approval.");
    }
    if (
      !running
      && ownership.submissionBaseline
      && completedSubmittedRun(snapshot, ownership.submissionBaseline)
    ) {
      ownership.runObserved = true;
      if (until === "complete") {
        pendingRunSubmissions.delete(ctx.app);
        ownership.submissionBaseline = null;
        return {
          reached: "complete",
          waitedMs: Date.now() - startedAt,
          completedBeforeRunningWasObserved: true,
          toolLifecycle: toolLifecycleCaptures.has(ctx.app) ? toolLifecycleReport(ctx) : null,
        };
      }
      pendingRunSubmissions.delete(ctx.app);
      ownership.submissionBaseline = null;
      throw new DriverActionError("The run completed without requesting the expected approval.");
    }
    if (ownership.approvalGranted) ownership.approvalClearedAfterGrant = true;
    if (!running && ownership.runObserved) {
      if (until === "complete") {
        pendingRunSubmissions.delete(ctx.app);
        ownership.submissionBaseline = null;
        return {
          reached: "complete",
          waitedMs: Date.now() - startedAt,
          toolLifecycle: toolLifecycleCaptures.has(ctx.app) ? toolLifecycleReport(ctx) : null,
        };
      }
      pendingRunSubmissions.delete(ctx.app);
      ownership.submissionBaseline = null;
      throw new DriverActionError("The run completed without requesting the expected approval.");
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new DriverActionError(
        `The development run did not reach ${until} within ${timeoutMs}ms.`,
      );
    }
    await sleep(100);
  }
}

export const CHAT_DEVELOPMENT_STATE_ACTIONS: DriverActionHandlers = {
  "chat.beginDevelopmentState": beginDevelopmentChat,
  "chat.typeDevelopmentDraft": typeDevelopmentDraft,
  "chat.exportDevelopmentOwnershipReceipt": exportDevelopmentOwnershipReceipt,
  "chat.importDevelopmentOwnershipReceipt": (ctx, params) =>
    importDevelopmentOwnershipReceipt(ctx, params.receipt),
  "chat.approveDevelopmentWriteOnce": approveDevelopmentWriteOnce,
  "chat.approveDevelopmentMutationOnce": approveDevelopmentMutationOnce,
  "chat.reopenOwnedDevelopmentHistory": reopenOwnedDevelopmentHistory,
  "chat.waitForDevelopmentRun": waitForDevelopmentRun,
  "chat.resetDevelopmentState": resetDevelopmentChatState,
};
