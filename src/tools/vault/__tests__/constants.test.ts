/** @jest-environment node */
import { FILESYSTEM_LIMITS } from "../constants";

describe("vault tool limits", () => {
  it("keeps bounded file, edit, list, and search work", () => {
    expect(FILESYSTEM_LIMITS).toMatchObject({
      MAX_FILE_READ_LENGTH: 25000,
      MAX_RESPONSE_CHARS: 25000,
      MAX_MULTI_EDIT_FILES: 20,
      MAX_READ_FILES: 10,
      DEFAULT_LIST_PAGE_SIZE: 25,
      MAX_LIST_PAGE_SIZE: 50,
      MAX_SEARCH_RESULTS: 25,
      MAX_FILE_SIZE: 200000,
      MAX_CONTENT_SIZE: 250000,
      MAX_OPERATIONS: 100,
    });
  });

  it("keeps the search body and footer inside the result token budget", () => {
    expect(FILESYSTEM_LIMITS.GREP_BODY_TOKENS + FILESYSTEM_LIMITS.GREP_FOOTER_TOKENS)
      .toBeLessThanOrEqual(FILESYSTEM_LIMITS.MAX_TOOL_RESULT_TOKENS);
  });
});
