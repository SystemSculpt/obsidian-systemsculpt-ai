const ACTIVE_TRANSPORT_TYPES = new Set([
  "wired",
  "wireless",
  "network",
  "localnetwork",
  "local-network",
  "local_network",
]);

const ACTIVE_TUNNEL_STATES = new Set(["available", "connected", "active"]);

export function listDevicectlDevices(payload) {
  return Array.isArray(payload?.result?.devices)
    ? payload.result.devices
    : Array.isArray(payload?.devices)
      ? payload.devices
      : [];
}

export function isPairedPhysicalIosDevice(device) {
  const platform = String(device?.hardwareProperties?.platform || "").trim();
  const reality = String(device?.hardwareProperties?.reality || "").trim();
  const pairingState = String(device?.connectionProperties?.pairingState || "").trim();
  return (
    (platform === "iOS" || platform === "iPadOS") &&
    reality === "physical" &&
    pairingState === "paired"
  );
}

export function isReachablePhysicalIosDevice(device) {
  const transportType = String(device?.connectionProperties?.transportType || "").trim().toLowerCase();
  const tunnelState = String(device?.connectionProperties?.tunnelState || "").trim().toLowerCase();
  return (
    isPairedPhysicalIosDevice(device) &&
    (ACTIVE_TRANSPORT_TYPES.has(transportType) || ACTIVE_TUNNEL_STATES.has(tunnelState))
  );
}

export function formatDeviceLabel(device) {
  return (
    String(device?.deviceProperties?.name || "").trim() ||
    String(device?.identifier || "").trim() ||
    String(device?.hardwareProperties?.udid || "").trim() ||
    "iOS device"
  );
}

export function unavailableDeviceMessage(label, recoveryAction = "re-run the iOS command") {
  const action = String(recoveryAction || "re-run the iOS command").trim().replace(/\.+$/, "");
  return (
    `${label} is paired, but is not actively reachable through CoreDevice. ` +
    "Connect the iPhone or iPad by USB, unlock it, accept Trust This Computer, " +
    `confirm Developer Mode is enabled, then ${action}.`
  );
}

export function findReachablePhysicalIosDevice(payloadOrDevices) {
  const devices = Array.isArray(payloadOrDevices)
    ? payloadOrDevices
    : listDevicectlDevices(payloadOrDevices);
  const candidates = devices.filter(isReachablePhysicalIosDevice);
  const wired = candidates.filter((device) => {
    return String(device?.connectionProperties?.transportType || "").trim().toLowerCase() === "wired";
  });

  return wired[0] || candidates[0] || null;
}

export function selectReachablePhysicalIosDevice(
  devices,
  {
    requestedDevice = null,
    recoveryAction = "re-run the iOS command",
  } = {},
) {
  const pairedPhysicalDevices = (Array.isArray(devices) ? devices : []).filter(isPairedPhysicalIosDevice);
  const candidates = pairedPhysicalDevices.filter(isReachablePhysicalIosDevice);

  if (requestedDevice) {
    const lowered = requestedDevice.toLowerCase();
    const matched = pairedPhysicalDevices.find((device) => {
      const name = String(device?.deviceProperties?.name || "").toLowerCase();
      const identifier = String(device?.identifier || "").toLowerCase();
      const udid = String(device?.hardwareProperties?.udid || "").toLowerCase();
      return name === lowered || identifier === lowered || udid === lowered;
    });
    if (!matched) {
      throw new Error(`No paired physical iOS device matched "${requestedDevice}".`);
    }
    if (!isReachablePhysicalIosDevice(matched)) {
      throw new Error(unavailableDeviceMessage(formatDeviceLabel(matched), recoveryAction));
    }
    return matched;
  }

  const wired = candidates.filter((device) => {
    return String(device?.connectionProperties?.transportType || "").trim().toLowerCase() === "wired";
  });
  if (wired.length === 1) {
    return wired[0];
  }
  if (candidates.length === 1) {
    return candidates[0];
  }
  if (wired.length > 1) {
    throw new Error("Multiple wired iOS devices are connected. Re-run with --device.");
  }
  if (candidates.length > 1) {
    throw new Error("Multiple reachable iOS devices are paired. Re-run with --device.");
  }

  if (pairedPhysicalDevices.length > 0) {
    const label = pairedPhysicalDevices.length === 1
      ? formatDeviceLabel(pairedPhysicalDevices[0])
      : `${pairedPhysicalDevices.length} paired physical iOS devices`;
    throw new Error(unavailableDeviceMessage(label, recoveryAction));
  }

  throw new Error("No paired physical iOS device is currently available.");
}
