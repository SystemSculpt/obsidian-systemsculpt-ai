import type { ConnectErrorReason, ConnectOutcome } from "../services/AccountConnectService";

/** What each sign-in failure tells the user, wherever the result is shown. */
export const CONNECT_ERROR_COPY: Record<ConnectErrorReason, string> = {
  expired: "Sign-in expired. Try again.",
  "state-mismatch": "Couldn't verify sign-in. Try again.",
  "missing-code": "No code received. Paste the code from your browser.",
  network: "Can't reach SystemSculpt. Check your connection.",
  "invalid-code": "Code invalid or expired. Sign in again.",
  "rate-limited": "Too many tries. Wait a moment.",
  unavailable: "Sign-in is down. Try again soon.",
  unconfirmed: "Sign-in didn't finish. Try again.",
};

/** Error reasons a fresh browser sign-in can recover from in one tap. */
export const RETRYABLE_CONNECT_REASONS: ReadonlySet<ConnectErrorReason> = new Set([
  "expired",
  "state-mismatch",
  "invalid-code",
  "unconfirmed",
  "unavailable",
]);

export const LICENSE_CONFIRMING_COPY =
  "Confirming your license…";

const NO_PLAN_COPY =
  "No active plan. Choose one to start.";

export function signedInLine(email: string | null): string {
  return email ? `Signed in as ${email}.` : "Signed in to SystemSculpt.";
}

export const START_CHAT_LABEL = "Start a chat";

/** "500 credits ready." for a starter account whose balance is known; null otherwise. */
export function creditsReadyLine(outcome: ConnectOutcome): string | null {
  if (outcome.kind !== "signed-in" || !outcome.licenseValid || !outcome.starterCredits) return null;
  return `${outcome.starterCredits.toLocaleString("en-US")} credits ready.`;
}

/** A valid sign-in can go straight to a first hosted chat. */
export function canStartHostedChat(outcome: ConnectOutcome): boolean {
  return outcome.kind === "signed-in" && outcome.licenseValid;
}

/** The complete result in one message, for when no account surface is open. */
export function connectOutcomeMessage(outcome: ConnectOutcome): string {
  if (outcome.kind === "error") return CONNECT_ERROR_COPY[outcome.reason];
  if (outcome.kind === "no-license") return `${signedInLine(outcome.email)} ${NO_PLAN_COPY}`;
  if (!outcome.licenseValid) return `${signedInLine(outcome.email)} ${LICENSE_CONFIRMING_COPY}`;
  const credits = creditsReadyLine(outcome);
  return credits ? `Signed in. ${credits}` : signedInLine(outcome.email);
}
