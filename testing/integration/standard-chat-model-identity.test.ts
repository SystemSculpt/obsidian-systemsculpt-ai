/** @jest-environment jsdom */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  captureStartupIdentity,
  expectProductionStartupIdentity,
} from "./startup-identity-assertions";
import { exerciseBuiltStandardChatIdentity } from "./standard-chat-identity-bundle-harness";

const BUNDLE_PATH = path.resolve(__dirname, "..", "..", "main.js");
const MANIFEST_PATH = path.resolve(__dirname, "..", "..", "manifest.json");

describe("built standard Chat identity", () => {
  it("opens and prepares a managed send without client-side model/provider authority", async () => {
    if (!existsSync(BUNDLE_PATH)) {
      throw new Error(`Built bundle not found at ${BUNDLE_PATH} — run npm run build first.`);
    }
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    const bundleModule = require(BUNDLE_PATH);
    const startupIdentity = captureStartupIdentity();
    await exerciseBuiltStandardChatIdentity(bundleModule);
    expectProductionStartupIdentity(startupIdentity, manifest.version);
  });
});
