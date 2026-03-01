import type { StudioPiProviderAuthRecord } from "./StudioPiAuthStorage";
import { normalizeStudioPiProviderHint } from "./StudioPiProviderUtils";

export type StudioPiProviderAuthRecordLike = Pick<
  StudioPiProviderAuthRecord,
  "provider" | "hasStoredCredential" | "credentialType"
>;

export function normalizeStudioPiProviderId(value: unknown): string {
  return normalizeStudioPiProviderHint(value);
}

export function hasAuthenticatedStudioPiProvider(
  record: StudioPiProviderAuthRecordLike | null | undefined
): boolean {
  if (!record) {
    return false;
  }
  if (record.hasStoredCredential) {
    return true;
  }
  return record.credentialType === "oauth" || record.credentialType === "api_key";
}
