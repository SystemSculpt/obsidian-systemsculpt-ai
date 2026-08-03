/**
 * Diagnostics capture for the E2E test driver.
 *
 * Records console output, window errors, unhandled rejections, and transient
 * Obsidian notices into bounded ring buffers so the CLI can read everything a
 * human would see in devtools or as toast notifications — including messages
 * that appeared and disappeared between commands. Console methods keep their
 * original behavior; capture is dev-build-only alongside the driver.
 */

export interface DriverLogEntry {
  seq: number;
  at: string;
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
}

export interface DriverNoticeEntry {
  seq: number;
  at: string;
  text: string;
}

const LOG_BUFFER_LIMIT = 2000;
const NOTICE_BUFFER_LIMIT = 200;
const ENTRY_TEXT_LIMIT = 4000;

function formatArgument(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export class DriverDiagnostics {
  private readonly logs: DriverLogEntry[] = [];
  private readonly notices: DriverNoticeEntry[] = [];
  private nextLogSeq = 1;
  private nextNoticeSeq = 1;
  private restoreConsole: (() => void) | null = null;
  private noticeObserver: MutationObserver | null = null;
  private readonly windowListeners: Array<() => void> = [];

  public start(): void {
    this.wrapConsole();
    this.observeNotices();
    this.listenForWindowErrors();
  }

  public stop(): void {
    this.restoreConsole?.();
    this.restoreConsole = null;
    this.noticeObserver?.disconnect();
    this.noticeObserver = null;
    for (const remove of this.windowListeners.splice(0)) remove();
  }

  public readLogs(options: {
    level?: string;
    pattern?: string;
    sinceSeq?: number;
    limit?: number;
  }): { entries: DriverLogEntry[]; lastSeq: number; dropped: number } {
    const limit = Math.min(Math.max(options.limit ?? 200, 1), LOG_BUFFER_LIMIT);
    const pattern = options.pattern ? new RegExp(options.pattern, "i") : null;
    const minimumLevel = options.level;
    const filtered = this.logs.filter((entry) => {
      if (options.sinceSeq !== undefined && entry.seq <= options.sinceSeq) return false;
      if (minimumLevel === "warn" && entry.level !== "warn" && entry.level !== "error") return false;
      if (minimumLevel === "error" && entry.level !== "error") return false;
      if (pattern && !pattern.test(entry.text)) return false;
      return true;
    });
    return {
      entries: filtered.slice(-limit),
      lastSeq: this.logs.length > 0 ? this.logs[this.logs.length - 1]!.seq : 0,
      dropped: Math.max(0, filtered.length - limit),
    };
  }

  public readNotices(options: { sinceSeq?: number; limit?: number }): {
    entries: DriverNoticeEntry[];
    lastSeq: number;
  } {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), NOTICE_BUFFER_LIMIT);
    const filtered = options.sinceSeq !== undefined
      ? this.notices.filter((entry) => entry.seq > options.sinceSeq!)
      : this.notices;
    return {
      entries: filtered.slice(-limit),
      lastSeq: this.notices.length > 0 ? this.notices[this.notices.length - 1]!.seq : 0,
    };
  }

  public recentErrorCount(): number {
    return this.logs.filter((entry) => entry.level === "error").length;
  }

  private record(level: DriverLogEntry["level"], parts: unknown[]): void {
    const text = parts.map(formatArgument).join(" ").slice(0, ENTRY_TEXT_LIMIT);
    this.logs.push({
      seq: this.nextLogSeq,
      at: new Date().toISOString(),
      level,
      text,
    });
    this.nextLogSeq += 1;
    if (this.logs.length > LOG_BUFFER_LIMIT) this.logs.shift();
  }

  private wrapConsole(): void {
    const levels: Array<DriverLogEntry["level"]> = ["log", "info", "warn", "error", "debug"];
    const originals = new Map<DriverLogEntry["level"], (...parts: unknown[]) => void>();
    for (const level of levels) {
      // eslint-disable-next-line obsidianmd/rule-custom-message -- Dev-only capture wraps console without adding output.
      const original = console[level].bind(console);
      originals.set(level, original);
      // eslint-disable-next-line obsidianmd/rule-custom-message -- Dev-only capture wraps console without adding output.
      console[level] = (...parts: unknown[]): void => {
        this.record(level, parts);
        original(...parts);
      };
    }
    this.restoreConsole = () => {
      for (const level of levels) {
        const original = originals.get(level);
        // eslint-disable-next-line obsidianmd/rule-custom-message -- Restores the original console methods.
        if (original) console[level] = original;
      }
    };
  }

  private observeNotices(): void {
    const recordNotice = (element: Element): void => {
      const text = (element.textContent ?? "").trim();
      if (!text) return;
      this.notices.push({
        seq: this.nextNoticeSeq,
        at: new Date().toISOString(),
        text: text.slice(0, ENTRY_TEXT_LIMIT),
      });
      this.nextNoticeSeq += 1;
      if (this.notices.length > NOTICE_BUFFER_LIMIT) this.notices.shift();
    };
    for (const existing of document.querySelectorAll(".notice")) recordNotice(existing);
    this.noticeObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node.instanceOf(HTMLElement))) continue;
          if (node.classList.contains("notice")) recordNotice(node);
          else for (const notice of node.querySelectorAll(".notice")) recordNotice(notice);
        }
      }
    });
    this.noticeObserver.observe(document.body, { childList: true, subtree: true });
  }

  private listenForWindowErrors(): void {
    const onError = (event: ErrorEvent): void => {
      this.record("error", [`window.onerror: ${event.message}`, event.filename ?? ""]);
    };
    const onRejection = (event: PromiseRejectionEvent): void => {
      this.record("error", ["unhandledrejection:", event.reason]);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    this.windowListeners.push(
      () => window.removeEventListener("error", onError),
      () => window.removeEventListener("unhandledrejection", onRejection),
    );
  }
}
