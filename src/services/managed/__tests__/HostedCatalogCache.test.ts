import { ManagedImageModelCatalog } from "../../images/ManagedImageModelCatalog";
import { ManagedVideoModelCatalog } from "../../videos/ManagedVideoModelCatalog";
import { getStudioMediaCatalogs } from "../../../studio/StudioMediaCatalogs";

const response = () => ({ response: new Response(JSON.stringify({ contract: "systemsculpt-media-models-v1", default_model_id: "", models: [] })) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

describe.each([ManagedImageModelCatalog, ManagedVideoModelCatalog])("%p cache ownership", Catalog => {
  it("invalidates cached prices when the license changes or is removed", async () => {
    let license = "first";
    const request = jest.fn(async () => response());
    const catalog = new Catalog({ request } as never, { licenseKey: () => license });
    const first = await catalog.load();
    license = " first ";
    expect(catalog.peek()).toBe(first);
    license = "second";
    expect(catalog.peek()).toBeNull();
    expect(await catalog.load()).not.toBe(first);
    license = "";
    expect(catalog.peek()).toBeNull();
    await catalog.load();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each(["account change", "explicit invalidation"])("rejects superseded results after %s without clearing the new request", async change => {
    let license = "first";
    const oldRead = deferred<ReturnType<typeof response>>();
    const newRead = deferred<ReturnType<typeof response>>();
    const request = jest.fn().mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    const catalog = new Catalog({ request } as never, { licenseKey: () => license });
    const oldLoad = catalog.load();
    const rejected = expect(oldLoad).rejects.toThrow("changed while loading");
    if (change === "account change") license = "second";
    else catalog.invalidate();
    const newLoad = catalog.load();
    oldRead.resolve(response());
    await rejected;
    expect(catalog.peek()).toBeNull();
    expect(catalog.load()).toBe(newLoad);
    newRead.resolve(response());
    expect(catalog.peek()).toBeNull();
    const latest = await newLoad;
    expect(catalog.peek()).toBe(latest);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects an old account result even if nothing reads the cache during the switch", async () => {
    let license = "first";
    const pending = deferred<ReturnType<typeof response>>();
    const request = jest.fn().mockReturnValueOnce(pending.promise).mockImplementation(async () => response());
    const catalog = new Catalog({ request } as never, { licenseKey: () => license });
    const load = catalog.load();
    license = "second";
    pending.resolve(response());
    await expect(load).rejects.toThrow("changed while loading");
    expect(catalog.peek()).toBeNull();
    await catalog.load();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("allows a fresh request after a failure and refetches on expiry", async () => {
    let now = 1_000;
    const request = jest.fn().mockResolvedValueOnce({ response: new Response(null, { status: 503 }) }).mockImplementation(async () => response());
    const catalog = new Catalog({ request } as never, { now: () => now });
    await expect(catalog.load()).rejects.toThrow("503");
    const loaded = await catalog.load();
    expect(await catalog.load()).toBe(loaded);
    now += 5 * 60_000;
    expect(catalog.peek()).toBeNull();
    expect(await catalog.load()).not.toBe(loaded);
    expect(request).toHaveBeenCalledTimes(3);
  });
});

it("keeps one shared Studio catalog owner while invalidating both catalogs on license changes", async () => {
  const request = jest.fn(async () => response());
  const plugin = { settings: { licenseKey: "first" }, getManagedCapabilityGraph: () => ({ transport: { request } }) };
  const catalogs = getStudioMediaCatalogs(plugin as never);
  await Promise.all([catalogs.images.load(), catalogs.videos.load()]);
  plugin.settings.licenseKey = "second";
  expect(getStudioMediaCatalogs(plugin as never)).toBe(catalogs);
  expect(catalogs.images.peek()).toBeNull();
  expect(catalogs.videos.peek()).toBeNull();
  await Promise.all([catalogs.images.load(), catalogs.videos.load()]);
  expect(request).toHaveBeenCalledTimes(4);
});
