/**
 * Canonical chat composer journey.
 *
 * Proves the GUI path a user takes to start a chat: new chat, typing
 * (replace and append), a real file-picker attachment, and readiness of the
 * send control — all addressed by data-testid. Safe to run repeatedly: it
 * never submits, so no request leaves the app.
 *
 *   npm run e2e -- script testing/e2e/scenarios/chat-composer-journey.mjs
 */

// A 1x1 transparent PNG so the scenario has no file dependencies.
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export default [
  { label: "open chat", action: "chat.open" },
  { label: "start a new chat", action: "click", params: { target: "chat.header.new" } },
  { label: "type a draft", action: "type", params: {
    target: "chat.composer.input",
    text: "Composer journey: typed through the real GUI.",
  } },
  { label: "append to the draft", action: "type", params: {
    target: "chat.composer.input",
    text: " Appended sentence.",
    mode: "append",
  } },
  { label: "attach a PNG via the file picker", action: "attach", params: {
    name: "scenario-attachment.png",
    mimeType: "image/png",
    dataBase64: PNG_1X1,
    via: "picker",
  } },
  { label: "send becomes enabled", action: "waitFor", params: {
    target: "chat.composer.send",
    state: "enabled",
  } },
  { label: "verify composer state", action: "snapshot", params: { scope: "chat" } },
];
