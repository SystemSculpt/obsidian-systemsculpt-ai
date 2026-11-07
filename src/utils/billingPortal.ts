import { SYSTEMSCULPT_WEBSITE } from "../constants/externalServices";
import { openExternalUrl } from "./externalUrl";

/**
 * Opens the account's Stripe billing portal so a failed renewal is fixed on
 * the existing plan, never with a second checkout (T-5348). If the link
 * cannot be made, the website's Billing page offers the same portal.
 */
export async function openBillingPortal(
  service: { createBillingPortalLink(): Promise<string> },
  ownerWindow?: Window,
): Promise<void> {
  let url: string = SYSTEMSCULPT_WEBSITE.BILLING;
  try {
    url = await service.createBillingPortalLink();
  } catch {
    // The Billing page signs the person in and opens the same portal.
  }
  await openExternalUrl(url, ownerWindow);
}
