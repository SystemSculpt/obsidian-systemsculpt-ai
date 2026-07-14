export interface MicrophoneDeviceCatalogEntry {
  id: string;
  label: string;
}

export type MicrophoneLabelRefreshState =
  | "not-needed"
  | "granted"
  | "denied"
  | "unavailable"
  | "skipped";

export type MicrophoneDeviceCatalogResult =
  | {
      status: "ready";
      devices: readonly MicrophoneDeviceCatalogEntry[];
      labelRefresh: MicrophoneLabelRefreshState;
    }
  | { status: "unavailable"; devices: readonly [] }
  | { status: "error"; devices: readonly []; message: string }
  | { status: "cancelled"; devices: readonly [] };

export interface MicrophoneDeviceCatalogOptions {
  /** Ask for audio permission once when the browser initially hides labels. */
  requestLabels?: boolean;
}

type MicrophoneDeviceCatalogOwner = Pick<Window, "navigator"> | Navigator;
type CatalogMediaDevices = Pick<MediaDevices, "enumerateDevices" | "getUserMedia">;

const cancelledResult = (): MicrophoneDeviceCatalogResult => ({
  status: "cancelled",
  devices: [],
});

function resolveOwnerNavigator(owner: MicrophoneDeviceCatalogOwner): Navigator {
  return "navigator" in owner ? owner.navigator : owner;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Owns microphone discovery for one mounted browser realm.
 *
 * Refreshes are latest-wins. Disposal or an external abort makes pending
 * results inert, while a late permission stream is still stopped before the
 * cancelled result settles.
 */
export class MicrophoneDeviceCatalog {
  private readonly ownerNavigator: Navigator;
  private readonly requestLabels: boolean;
  private generation = 0;
  private disposed = false;
  private labelRefreshPromise: Promise<MicrophoneLabelRefreshState> | null = null;

  constructor(
    owner: MicrophoneDeviceCatalogOwner,
    options: MicrophoneDeviceCatalogOptions = {},
  ) {
    this.ownerNavigator = resolveOwnerNavigator(owner);
    this.requestLabels = options.requestLabels ?? true;
  }

  async refresh(signal?: AbortSignal): Promise<MicrophoneDeviceCatalogResult> {
    if (this.disposed || signal?.aborted) return cancelledResult();

    const generation = ++this.generation;
    const mediaDevices = this.ownerNavigator.mediaDevices as CatalogMediaDevices | undefined;
    if (!mediaDevices || typeof mediaDevices.enumerateDevices !== "function") {
      return { status: "unavailable", devices: [] };
    }

    try {
      let devices = await mediaDevices.enumerateDevices();
      if (!this.isCurrent(generation, signal)) return cancelledResult();

      const hasLabeledMicrophone = devices.some(
        (device) => device.kind === "audioinput" && Boolean(device.label),
      );
      let labelRefresh: MicrophoneLabelRefreshState = hasLabeledMicrophone
        ? "not-needed"
        : "skipped";

      if (!hasLabeledMicrophone && this.requestLabels) {
        labelRefresh = await this.refreshLabelsOnce(mediaDevices);
        if (!this.isCurrent(generation, signal)) return cancelledResult();
        devices = await mediaDevices.enumerateDevices();
        if (!this.isCurrent(generation, signal)) return cancelledResult();
      }

      return {
        status: "ready",
        labelRefresh,
        devices: devices
          .filter((device) => device.kind === "audioinput")
          .map((device) => ({
            id: device.deviceId,
            label: device.label || `Microphone ${device.deviceId.slice(0, 8)}`,
          })),
      };
    } catch (error) {
      if (!this.isCurrent(generation, signal)) return cancelledResult();
      return { status: "error", devices: [], message: errorMessage(error) };
    }
  }

  cancel(): void {
    this.generation += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
  }

  private isCurrent(generation: number, signal?: AbortSignal): boolean {
    return !this.disposed && !signal?.aborted && generation === this.generation;
  }

  private refreshLabelsOnce(
    mediaDevices: CatalogMediaDevices,
  ): Promise<MicrophoneLabelRefreshState> {
    if (!this.labelRefreshPromise) {
      this.labelRefreshPromise = (async () => {
        if (typeof mediaDevices.getUserMedia !== "function") return "unavailable";
        try {
          const stream = await mediaDevices.getUserMedia({ audio: true });
          this.stopStream(stream);
          return "granted";
        } catch {
          return "denied";
        }
      })();
    }
    return this.labelRefreshPromise;
  }

  private stopStream(stream: MediaStream): void {
    try {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // A track may already have ended while permission was resolving.
        }
      }
    } catch {
      // Treat malformed host streams as already released.
    }
  }
}
