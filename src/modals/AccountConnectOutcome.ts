import type { ConnectErrorReason, ConnectOutcome } from "../services/AccountConnectService";

/** What each sign-in failure tells the user, wherever the result is shown. */
export const CONNECT_ERROR_COPY: Record<ConnectErrorReason, string> = {
  expired: "The sign-in session expired. Start sign-in again from SystemSculpt settings.",
  "state-mismatch": "The sign-in could not be verified. Start again from SystemSculpt settings.",
  "missing-code": "No connection code was received. Paste the code shown in your browser into SystemSculpt settings.",
  network: "Could not reach SystemSculpt. Check your connection, then try the code again from settings.",
  "invalid-code": "The connection code was invalid or expired. Start sign-in again from SystemSculpt settings.",
  "rate-limited": "Too many sign-in attempts. Wait a moment, then try again.",
  unavailable: "Sign-in is temporarily unavailable. Try again in a moment.",
  unconfirmed: "Your sign-in may have gone through, but Obsidian didn't receive the confirmation. Start sign-in again to finish connecting.",
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
  "Your license is being confirmed. If AI features stay locked, open SystemSculpt settings and retry validation.";

export const NO_PLAN_COPY =
  "Your account has no active plan yet. Choose a plan to enable SystemSculpt AI features.";

export function signedInLine(email: string | null): string {
  return email ? `Signed in as ${email}.` : "Signed in to SystemSculpt.";
}

/** The complete result in one message, for when no account surface is open. */
export function connectOutcomeMessage(outcome: ConnectOutcome): string {
  if (outcome.kind === "error") return CONNECT_ERROR_COPY[outcome.reason];
  if (outcome.kind === "no-license") return `${signedInLine(outcome.email)} ${NO_PLAN_COPY}`;
  return outcome.licenseValid
    ? signedInLine(outcome.email)
    : `${signedInLine(outcome.email)} ${LICENSE_CONFIRMING_COPY}`;
}
