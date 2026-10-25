import type { RequestUrlParam, RequestUrlResponse, RequestUrlResponsePromise } from "obsidian";

/**
 * Adapts an async responder to requestUrl's contract: Obsidian returns the
 * response promise with its body readers attached as promises too.
 */
export function hostRequest(
  respond: (request: string | RequestUrlParam) => Promise<RequestUrlResponse>,
): (request: string | RequestUrlParam) => RequestUrlResponsePromise {
  return (request) => {
    const response = respond(request);
    const body = <T>(read: (value: RequestUrlResponse) => T): Promise<T> => {
      const promise = response.then(read);
      // Callers await the response itself, which reports a rejection once.
      promise.catch(() => undefined);
      return promise;
    };
    return Object.assign(response, {
      arrayBuffer: body((value) => value.arrayBuffer),
      json: body((value) => value.json),
      text: body((value) => value.text),
    });
  };
}
