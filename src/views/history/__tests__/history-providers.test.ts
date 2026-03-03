import { createSystemSculptHistoryProviders, sortHistoryEntriesNewestFirst } from "../historyProviders";
import type { SystemSculptHistoryEntry } from "../types";

describe("historyProviders", () => {
  it("sorts mixed history entries by newest first", () => {
    const entries: SystemSculptHistoryEntry[] = [
      {
        id: "chat:1",
        kind: "chat",
        title: "Older",
        timestampMs: 100,
        searchText: "older",
        badge: "Chat",
        openPrimary: async () => {},
      },
      {
        id: "studio:1",
        kind: "studio_session",
        title: "Newest",
        timestampMs: 200,
        searchText: "newest",
        badge: "Studio Session",
        openPrimary: async () => {},
      },
    ];

    const sorted = sortHistoryEntriesNewestFirst(entries);
    expect(sorted.map((entry) => entry.id)).toEqual(["studio:1", "chat:1"]);
  });

  it("can disable studio providers for mobile history mode", () => {
    const plugin = {} as any;
    const providers = createSystemSculptHistoryProviders(plugin, false);
    expect(providers.map((provider) => provider.id)).toEqual(["chat-history"]);
  });

  it("includes studio providers when enabled", () => {
    const plugin = {} as any;
    const providers = createSystemSculptHistoryProviders(plugin, true);
    expect(providers.map((provider) => provider.id)).toEqual([
      "chat-history",
      "studio-session-history",
    ]);
  });
});
