/** @jest-environment jsdom */

import { existsSync } from "node:fs";
import path from "node:path";
import { exerciseBuiltStandardChatIdentity } from "./standard-chat-identity-bundle-harness";

const BUNDLE_PATH = path.resolve(__dirname, "..", "..", "main.js");

describe("built standard Chat identity", () => {
  it("opens and prepares a managed send without client-side model/provider authority", async () => {
    if (!existsSync(BUNDLE_PATH)) {
      throw new Error(`Built bundle not found at ${BUNDLE_PATH} — run npm run build first.`);
    }
    const bundleModule = require(BUNDLE_PATH);
    await exerciseBuiltStandardChatIdentity(bundleModule);
  });
});
