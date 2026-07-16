/** @jest-environment jsdom */

import { MicrophoneDeviceCatalog } from "../MicrophoneDeviceCatalog";

const device = (
  deviceId: string,
  label: string,
  kind: MediaDeviceKind = "audioinput",
): MediaDeviceInfo => ({
  deviceId,
  groupId: "group",
  kind,
  label,
  toJSON: () => ({ deviceId, groupId: "group", kind, label }),
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const setMediaDevices = (owner: Navigator, mediaDevices: unknown): void => {
  Object.defineProperty(owner, "mediaDevices", {
    configurable: true,
    value: mediaDevices,
  });
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("MicrophoneDeviceCatalog", () => {
  const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");

  afterEach(() => {
    document.body.empty();
    if (originalMediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
    } else {
      delete (navigator as Navigator & { mediaDevices?: MediaDevices }).mediaDevices;
    }
  });

  it("discovers and labels devices only through the initiating owner realm", async () => {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const foreignWindow = frame.contentWindow!;
    const stop = jest.fn();
    const getUserMedia = jest.fn().mockResolvedValue({
      getTracks: () => [{ stop }],
    });
    const enumerateDevices = jest
      .fn()
      .mockResolvedValueOnce([device("foreign-1", "")])
      .mockResolvedValueOnce([device("foreign-1", "Popout microphone")])
      .mockResolvedValue([device("foreign-1", "Popout microphone")]);
    setMediaDevices(foreignWindow.navigator, { enumerateDevices, getUserMedia });

    const mainEnumerate = jest.fn().mockRejectedValue(new Error("main realm used"));
    setMediaDevices(navigator, {
      enumerateDevices: mainEnumerate,
      getUserMedia: jest.fn(),
    });

    const catalog = new MicrophoneDeviceCatalog(foreignWindow as unknown as Window);
    const first = await catalog.refresh();
    const second = await catalog.refresh();

    expect(first).toEqual({
      status: "ready",
      labelRefresh: "granted",
      devices: [{ id: "foreign-1", label: "Popout microphone" }],
    });
    expect(second).toEqual({
      status: "ready",
      labelRefresh: "not-needed",
      devices: [{ id: "foreign-1", label: "Popout microphone" }],
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(mainEnumerate).not.toHaveBeenCalled();
  });

  it("returns typed enumeration and permission rejection states", async () => {
    const enumerationFailure = new MicrophoneDeviceCatalog({
      mediaDevices: {
        enumerateDevices: jest.fn().mockRejectedValue(new Error("device query failed")),
      },
    } as unknown as Navigator);
    await expect(enumerationFailure.refresh()).resolves.toEqual({
      status: "error",
      devices: [],
      message: "device query failed",
    });

    const denied = new MicrophoneDeviceCatalog({
      mediaDevices: {
        enumerateDevices: jest.fn().mockResolvedValue([device("hidden-mic", "")]),
        getUserMedia: jest.fn().mockRejectedValue(new Error("permission denied")),
      },
    } as unknown as Navigator);
    await expect(denied.refresh()).resolves.toEqual({
      status: "ready",
      labelRefresh: "denied",
      devices: [{ id: "hidden-mic", label: "Microphone hidden-m" }],
    });
  });

  it("keeps passive refresh permission-free while allowing an explicit label refresh", async () => {
    const getUserMedia = jest.fn().mockResolvedValue({
      getTracks: () => [{ stop: jest.fn() }],
    });
    const catalog = new MicrophoneDeviceCatalog({
      mediaDevices: {
        enumerateDevices: jest.fn().mockResolvedValue([device("hidden", "")]),
        getUserMedia,
      },
    } as unknown as Navigator, { requestLabels: false });

    await expect(catalog.refresh()).resolves.toMatchObject({
      status: "ready",
      labelRefresh: "skipped",
    });
    expect(getUserMedia).not.toHaveBeenCalled();

    await expect(catalog.refreshWithLabelPermission()).resolves.toMatchObject({
      status: "ready",
      labelRefresh: "granted",
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("makes overlapping refreshes latest-wins", async () => {
    const staleDevices = deferred<MediaDeviceInfo[]>();
    const enumerateDevices = jest
      .fn()
      .mockImplementationOnce(() => staleDevices.promise)
      .mockResolvedValueOnce([device("fresh", "Fresh microphone")]);
    const catalog = new MicrophoneDeviceCatalog({
      mediaDevices: { enumerateDevices },
    } as unknown as Navigator);

    const stale = catalog.refresh();
    const fresh = catalog.refresh();
    await expect(fresh).resolves.toEqual({
      status: "ready",
      labelRefresh: "not-needed",
      devices: [{ id: "fresh", label: "Fresh microphone" }],
    });

    staleDevices.resolve([device("stale", "Stale microphone")]);
    await expect(stale).resolves.toEqual({ status: "cancelled", devices: [] });
  });

  it("stops a late permission stream after disposal and suppresses its result", async () => {
    const permission = deferred<MediaStream>();
    const stop = jest.fn();
    const catalog = new MicrophoneDeviceCatalog({
      mediaDevices: {
        enumerateDevices: jest.fn().mockResolvedValue([device("hidden", "")]),
        getUserMedia: jest.fn(() => permission.promise),
      },
    } as unknown as Navigator);

    const pending = catalog.refresh();
    await flush();
    catalog.dispose();
    permission.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream);

    await expect(pending).resolves.toEqual({ status: "cancelled", devices: [] });
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
