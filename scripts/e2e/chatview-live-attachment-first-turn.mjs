/**
 * Fast visible lane: attach a synthetic text fixture before the first submitted
 * turn, then prove the response and attachment survive an exact history reopen.
 */
import { makeChatLiveBlankAttachmentRoundTrip } from "./chatview-live-acceptance.mjs";

export default makeChatLiveBlankAttachmentRoundTrip;
