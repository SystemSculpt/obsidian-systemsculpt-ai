import { Platform } from "obsidian";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, relative } from "path";
import { clientIdentityHeaders, setClientPluginVersion, withClientIdentityHeaders } from "../../../services/api/clientIdentity";
import { API_BASE_URL } from "../../../constants/api";

/**
 * analytics/events.json is the plugin's single analytics catalog (T-4689).
 * The plugin sends no client-side telemetry (Obsidian policy); every command
 * either names the server events its API calls produce or says why it is not
 * measured. A new command without an entry fails here.
 */
const root = join(__dirname, "../../../..");

type CatalogEvent = {
  name: string;
  feature?: string;
  kind: string;
  description: string;
  endpoints: string[];
  where: string[];
  owner: string;
  added: string;
};
type Catalog = {
  headers: Record<string, string>;
  events: CatalogEvent[];
  commands: Record<string, { events: string[]; not_measured?: string }>;
};

const catalog = JSON.parse(readFileSync(join(root, "analytics/events.json"), "utf8")) as Catalog;
const eventKey = (event: CatalogEvent) => (event.feature ? `${event.name}:${event.feature}` : event.name);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" || name === "tests" ? [] : sourceFiles(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

function registeredCommandIds(): Map<string, string> {
  const ids = new Map<string, string>();
  for (const file of sourceFiles(join(root, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/addCommand\(\{\s*id:\s*(["'`])(.+?)\1/g)) {
      ids.set(match[2], relative(root, file));
    }
  }
  return ids;
}

describe("analytics catalog", () => {
  const commands = registeredCommandIds();
  const events = new Map(catalog.events.map((event) => [eventKey(event), event]));

  it("finds the registered commands", () => {
    expect(commands.size).toBeGreaterThan(20);
  });

  it("has an entry for every registered command", () => {
    const missing = [...commands.keys()].filter((id) => !catalog.commands[id]);
    expect(missing).toEqual([]);
  });

  it("names only commands that exist", () => {
    const stale = Object.keys(catalog.commands).filter((id) => !commands.has(id));
    expect(stale).toEqual([]);
  });

  it("maps every command to known events or a reason it is not measured", () => {
    for (const [id, entry] of Object.entries(catalog.commands)) {
      if (entry.events.length === 0) {
        expect({ id, reason: entry.not_measured?.trim() || "" }).toEqual({ id, reason: expect.stringMatching(/\S/) });
      }
      const unknown = entry.events.filter((key) => !events.has(key));
      expect({ id, unknown }).toEqual({ id, unknown: [] });
    }
  });

  it("lists each event once, with owner and date", () => {
    expect(events.size).toBe(catalog.events.length);
    for (const event of catalog.events) {
      expect(event.owner).toMatch(/\S/);
      expect(event.added).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(event.description).toMatch(/\S/);
    }
  });

  it("fires every plugin-triggered event from the file it names", () => {
    for (const event of catalog.events.filter((e) => e.kind !== "daily")) {
      expect(event.where.length).toBeGreaterThan(0);
      for (const file of event.where) {
        const path = join(root, file);
        expect({ key: eventKey(event), file, exists: existsSync(path) }).toEqual({ key: eventKey(event), file, exists: true });
        const text = readFileSync(path, "utf8");
        const called = event.endpoints.some((endpoint) => text.includes(endpoint));
        expect({ key: eventKey(event), file, called }).toEqual({ key: eventKey(event), file, called: true });
      }
    }
  });

  it("sends the catalog's tag headers to the SystemSculpt API only", () => {
    setClientPluginVersion("9.9.9");
    const platform = Platform as { isMacOS: boolean };
    const wasMac = platform.isMacOS;
    platform.isMacOS = true;
    const sent = withClientIdentityHeaders(`${API_BASE_URL}/agent/turn`, { "X-SystemSculpt-Client": "obsidian-plugin" });
    for (const name of Object.keys(catalog.headers)) {
      expect({ name, sent: name in sent }).toEqual({ name, sent: true });
    }
    platform.isMacOS = wasMac;
    expect(sent["x-plugin-version"]).toBe("9.9.9");
    expect(sent["x-systemsculpt-platform"]).toBe("macos");
    expect(withClientIdentityHeaders("https://storage.example.com/upload", {})).toEqual({});
    expect(withClientIdentityHeaders(`${API_BASE_URL}/x`, { "X-Plugin-Version": "1.0.0" })["x-plugin-version"]).toBeUndefined();
    expect(Object.keys(clientIdentityHeaders())).toContain("x-obsidian-version");
  });
});
