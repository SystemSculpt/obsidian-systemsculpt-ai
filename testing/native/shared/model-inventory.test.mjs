import test from "node:test";
import assert from "node:assert/strict";

import { findProviderModelOption } from "./model-inventory.mjs";

// Guards the model-selection helper that both Windows clean-install parity
// lanes (xAI and the #201 OpenAI BYOK lane) rely on to pick which model to
// chat against. The key behavior under test is `requirePreferred`: the #201
// lane must FAIL if openai@@gpt-5.4-mini stops surfacing, instead of silently
// passing on some other OpenAI model the provider exposes.

const SEED = "openai@@gpt-5.4-mini";
const OTHER = "openai@@gpt-4.1";

function inventory(...values) {
  return {
    options: values.map((value) => ({
      providerId: "openai",
      value,
      label: value,
      section: "pi",
      providerAuthenticated: true,
    })),
  };
}

test("returns the preferred model when present (default soft mode)", () => {
  const option = findProviderModelOption(inventory(OTHER, SEED), "openai", {
    preferredModelIds: [SEED],
  });
  assert.equal(option?.value, SEED);
});

test("returns the preferred model when present (requirePreferred)", () => {
  const option = findProviderModelOption(inventory(OTHER, SEED), "openai", {
    preferredModelIds: [SEED],
    requirePreferred: true,
  });
  assert.equal(option?.value, SEED);
});

test("soft mode falls back to another provider model when the preferred is absent", () => {
  // Documents exactly the gap the #201 lane must not depend on: the seed is
  // gone, yet a different OpenAI model is happily returned.
  const option = findProviderModelOption(inventory(OTHER), "openai", {
    preferredModelIds: [SEED],
  });
  assert.equal(option?.value, OTHER);
});

test("requirePreferred returns null when the preferred model is absent (#201 gate)", () => {
  const option = findProviderModelOption(inventory(OTHER), "openai", {
    preferredModelIds: [SEED],
    requirePreferred: true,
  });
  assert.equal(option, null);
});

test("requirePreferred overrides the preferredSections fallback (mirrors the real wrapper)", () => {
  // The clean-install wrapper always passes preferredSections: ["pi","local"].
  // requirePreferred must still fail closed when the specific seed is missing.
  const option = findProviderModelOption(inventory(OTHER), "openai", {
    preferredModelIds: [SEED],
    preferredSections: ["pi", "local"],
    requirePreferred: true,
  });
  assert.equal(option, null);
});

test("requirePreferred fails closed when the provider exposes no models at all", () => {
  const option = findProviderModelOption(inventory(), "openai", {
    preferredModelIds: [SEED],
    requirePreferred: true,
  });
  assert.equal(option, null);
});

test("requirePreferred without any preferredModelIds keeps default selection", () => {
  // No preference specified -> requirePreferred has nothing to enforce, so the
  // first provider match is still returned. This keeps the xAI lane and any
  // caller that omits --provider-model-id behaving exactly as before.
  const option = findProviderModelOption(inventory(SEED), "openai", {
    requirePreferred: true,
  });
  assert.equal(option?.value, SEED);
});
