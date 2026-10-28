import type { ChatMessage } from "../../types";
import { getRuntimeCrypto } from "../../utils/runtimeWindow";

export function messageId(prefix: string): string {
  const crypto = getRuntimeCrypto();
  const uuid = typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${uuid}`;
}

export function protocolId(prefix: "client" | "conversation"): string {
  const crypto = getRuntimeCrypto();
  let hex = "";
  if (typeof crypto?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } else {
    hex = `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
      .padEnd(32, "0")
      .slice(0, 32);
  }
  return `${prefix}_${hex}`;
}

export function plainContent(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => part.type === "text" ? part.text : "")
    .filter(Boolean)
    .join("\n");
}
