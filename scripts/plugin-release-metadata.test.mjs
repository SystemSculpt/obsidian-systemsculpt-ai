import assert from "node:assert/strict";
import test from "node:test";

import {
  assertReleaseDoesNotDowngrade,
  createPluginReleaseMetadata,
  parsePublishedPluginRelease,
  verifyPublishedPluginRelease,
} from "./plugin-release-metadata.mjs";

const release = {
  manifestVersion: "6.6.2",
  tagName: "6.6.2",
  releaseUrl: "https://github.com/SystemSculpt/obsidian-systemsculpt-ai/releases/tag/6.6.2",
  publishedAt: "2026-08-13T16:00:00.000Z",
};

test("creates the exact public release record from one matching GitHub release", () => {
  assert.deepEqual(createPluginReleaseMetadata(release), {
    contract_version: "plugin-release-v1",
    plugin_id: "systemsculpt-ai",
    latest_version: "6.6.2",
    release_url: release.releaseUrl,
    published_at: release.publishedAt,
  });
});

test("rejects an unpublished version, conflicting URL, or invalid publication time", () => {
  assert.throws(
    () => createPluginReleaseMetadata({ ...release, tagName: "6.6.3" }),
    /must match manifest/,
  );
  assert.throws(
    () => createPluginReleaseMetadata({ ...release, releaseUrl: "https://example.com/6.6.2" }),
    /Release URL/,
  );
  assert.throws(
    () => createPluginReleaseMetadata({ ...release, publishedAt: "not-a-date" }),
    /publication time/,
  );
});

test("parses only the exact public contract", () => {
  const metadata = createPluginReleaseMetadata(release);
  assert.deepEqual(parsePublishedPluginRelease(metadata), metadata);
  assert.equal(parsePublishedPluginRelease({ ...metadata, token: "forbidden" }), null);
  assert.equal(parsePublishedPluginRelease({ ...metadata, latest_version: "latest" }), null);
});

test("waits through a stale cached version and verifies the published version", async () => {
  const metadata = createPluginReleaseMetadata(release);
  const stale = { ...metadata, latest_version: "6.6.1", release_url: metadata.release_url.replace("6.6.2", "6.6.1") };
  const responses = [stale, metadata];
  const sleeps = [];
  const result = await verifyPublishedPluginRelease({
    url: "https://systemsculpt.com/api/plugin/releases/latest",
    expectedVersion: metadata.latest_version,
    fetchImpl: async () => new Response(JSON.stringify(responses.shift()), { status: 200 }),
    sleepImpl: async (milliseconds) => { sleeps.push(milliseconds); },
    maxAttempts: 2,
    retryDelayMs: 1,
  });
  assert.equal(result.latest_version, "6.6.2");
  assert.deepEqual(sleeps, [1]);
});

test("allows idempotent or newer publication and rejects a downgrade", () => {
  const metadata = createPluginReleaseMetadata(release);
  const older = {
    ...metadata,
    latest_version: "6.6.1",
    release_url: metadata.release_url.replace("6.6.2", "6.6.1"),
  };
  assert.doesNotThrow(() => assertReleaseDoesNotDowngrade(metadata, older));
  assert.doesNotThrow(() => assertReleaseDoesNotDowngrade(metadata, metadata));
  assert.throws(() => assertReleaseDoesNotDowngrade(older, metadata), /cannot replace newer metadata/);
});
