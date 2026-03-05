import { requestUrl } from "obsidian";
import { PlatformContext } from "./PlatformContext";

export type PlatformRequestInput = {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: unknown;
  stream?: boolean;
  signal?: AbortSignal;
  cache?: RequestCache;
  licenseKey?: string;
};

export class PlatformRequestClient {
  public async request(input: PlatformRequestInput): Promise<Response> {
    const platform = PlatformContext.get();
    const transport = platform.preferredTransport({ endpoint: input.url });
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: input.stream ? "text/event-stream" : "application/json",
      ...(input.licenseKey ? { "x-license-key": input.licenseKey } : {}),
      ...(input.headers || {}),
    };
    const body = typeof input.body === "undefined" ? undefined : JSON.stringify(input.body);

    if (transport === "fetch" && typeof fetch === "function") {
      try {
        return await fetch(input.url, {
          method: input.method,
          headers,
          body,
          cache: input.cache ?? "no-store",
          signal: input.signal,
        } as RequestInit);
      } catch (error) {
        if (input.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
          throw error;
        }
      }
    }

    const result = await requestUrl({
      url: input.url,
      method: input.method,
      headers,
      body,
      throw: false,
    });

    const status = result.status || 500;
    const textBody =
      typeof result.text === "string" ? result.text : JSON.stringify(result.json || {});

    if (input.stream && status < 400) {
      return new Response(textBody, {
        status,
        headers: { "Content-Type": "text/event-stream" },
      });
    }

    return new Response(textBody, {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
