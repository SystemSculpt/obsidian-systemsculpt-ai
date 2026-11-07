import { API_BASE_URL } from "../constants/api";
import { PlatformRequestClient } from "./PlatformRequestClient";

/** Explicit support submission only: never includes notes, chats or diagnostics. */
export async function sendPluginFeedback(
  message: string,
  pluginVersion: string,
  licenseKey?: string,
): Promise<void> {
  const trimmed = message.trim();
  if (!trimmed) throw new Error("Write a message before sending feedback.");

  const response = await new PlatformRequestClient().request({
    url: `${API_BASE_URL}/feedback`,
    method: "POST",
    body: { message: trimmed, pluginVersion },
    licenseKey: licenseKey?.trim() || undefined,
    allowTransportFallback: false,
  });
  if (!response.ok) throw new Error("Feedback could not be queued.");
  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || !("queued" in result) || result.queued !== true) {
    throw new Error("Feedback was not confirmed as queued.");
  }
}
