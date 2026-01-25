import { JSDOM } from "jsdom";
import { ChatFavoritesService } from "../ChatFavoritesService";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
(global as any).window = dom.window;
(global as any).document = dom.window.document;
(global as any).CustomEvent = dom.window.CustomEvent;

describe("ChatFavoritesService", () => {
  afterEach(() => {
    jest.clearAllMocks();
    (ChatFavoritesService as any).instance = null;
  });

  it("adds, removes, and toggles favorites", async () => {
    const updateSettings = jest.fn(async (next: any) => {
      plugin.settings = { ...plugin.settings, ...next };
    });

    const plugin: any = {
      settings: { favoriteChats: [] },
      getSettingsManager: () => ({ updateSettings }),
    };

    const service = ChatFavoritesService.getInstance(plugin);

    await service.addFavorite("chat-1");
    expect(service.isFavorite("chat-1")).toBe(true);

    await service.removeFavorite("chat-1");
    expect(service.isFavorite("chat-1")).toBe(false);

    await service.toggleFavorite("chat-2");
    expect(service.isFavorite("chat-2")).toBe(true);

    await service.toggleFavorite("chat-2");
    expect(service.isFavorite("chat-2")).toBe(false);
  });
});

