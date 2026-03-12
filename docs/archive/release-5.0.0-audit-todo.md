# 5.0.0 Release Audit TODO (Archived)

Archived release-audit snapshot for historical reference.
The active release contract is documented in `README.md`, `docs/testing-coverage-map.md`, and `scripts/release-plugin.mjs`.

Last updated: 2026-03-10

## Scope

This review covers the 5.0.0 Obsidian plugin release plus the website/API surfaces that the plugin depends on in production.

## Current snapshot

These checks are green right now:

- GitHub release `5.0.0` is published with the expected plugin, Pi runtime, and Studio terminal runtime assets.
- The plugin metadata is aligned to `5.0.0` in `package.json`, `manifest.json`, `versions.json`, and `README.md`.
- The latest-version endpoint at `/api/plugin/plugins/systemsculpt-ai/latest` returns `5.0.0`, so the plugin updater path is live again.
- `npm run check:plugin:fast` passes in `obsidian-systemsculpt-ai`.
- Focused website contract tests pass for chat completions, embeddings billing, request contract, proxy, and CORS coverage.
- Production chat smoke passes against `/api/v1/chat/completions`.
- Production embeddings smoke passes against `/api/plugin/embeddings`.
- The production chargeable live matrix passes auth checks and most valid flows, including chat, search, embeddings, YouTube, image generation, and audio.

These checks are not fully green yet:

- The production chargeable live matrix still fails both document-processing flows.
- Low-credit production checks are skipped because no dedicated low-credit test license is configured.
- This audit did not directly observe the in-app 4.15.x -> 5.0.0 update drawer inside a clean Obsidian vault.

## Priority order

### 1. Fix production document processing end to end

Priority: `P0`

Why this matters:

- This is the only clearly broken production lane left in the broad live matrix.
- It affects licensed functionality and makes the combined plugin + API surface not fully healthy.

Evidence:

- `scripts/plugin-chargeable-live-matrix.mjs` currently reports:
  - `documents_process_direct`: `500 {"error":"Failed to process document"}`
  - `documents_job_flow`: `500 {"error":"Datalab submission failed: 403 - {\"detail\":\"Your payment has failed. Please pay any unpaid invoices to continue using the API.\"}"}`
- The plugin-side document pipeline still carries “not ready yet” style fallback/error handling in `src/services/DocumentProcessingService.ts`.

What to do:

1. Resolve the upstream Datalab billing/auth/config issue that is causing the `403 unpaid invoice` failure.
2. Fix the direct `/api/plugin/documents/process` path so it succeeds or returns a more actionable error contract.
3. Fix the job-based document-processing route so submission and polling both succeed again.
4. Verify the plugin-side progress and error copy is still correct once the API path is healthy.
5. Re-run `node scripts/plugin-chargeable-live-matrix.mjs` and do not close this item until all document flows pass.

Exit criteria:

- Both document-processing entries in the live matrix pass.
- A real plugin-side document conversion succeeds against production.

### 2. Run true clean-vault release UAT for install, update, and no-Pi setup

Priority: `P1`

Why this matters:

- Repo tests and API smokes are strong, but they are not the same as a real first-run user path.
- The most important remaining UX questions are install/update flow, bundled Pi runtime download, and setup clarity.

Evidence:

- We proved the updater endpoint returns `5.0.0`, but did not directly observe the actual update drawer in a clean Obsidian vault.
- The release is desktop-first for the SystemSculpt Pi experience, so first-run setup needs to be polished.

What to do:

1. Create a clean launcher vault with no existing plugin state.
2. Install 5.0.0 from the published release assets, not from a local repo checkout.
3. Confirm the plugin enables cleanly and the setup wizard behaves correctly on first open.
4. Confirm the bundled Pi runtime download/bootstrap path works for a machine that does not already have Pi set up.
5. Upgrade a vault from a 4.15.x state to 5.0.0 and confirm the update drawer/notice path appears as expected.
6. Confirm the SystemSculpt provider works after setup in that clean vault.

Exit criteria:

- Fresh install succeeds without touching a local repo.
- Update flow from an older plugin build is visibly correct in the app.
- No-Pi setup finishes without manual debugging steps.

### 3. Align install and platform docs with the real 5.0.0 experience

Priority: `P1`

Why this matters:

- The current docs mix the old “clone and build the repo” developer install story with the new release-asset and bundled-runtime story.
- The README still reads as more broadly cross-platform than the shipped SystemSculpt Pi experience actually is.

Evidence:

- `README.md` says:
  - platforms: desktop and mobile
  - manual install: `git clone`, `npm install`, `npm run build`
- The release itself is centered on bundled runtime assets and a desktop-first Pi path.

What to do:

1. Rewrite manual install docs around the release ZIP/assets path that normal users should follow.
2. Clarify the desktop-first nature of the SystemSculpt Pi experience.
3. Spell out what works on mobile, what degrades, and what is explicitly desktop-only.
4. Add a short “first run without Pi installed” section so the setup experience matches the release.

Exit criteria:

- A new user can choose the correct install path from the README without guessing.
- Platform expectations are obvious before install.

### 4. Remove stale references to retired remote session APIs

Priority: `P1`

Why this matters:

- The product cutover is intentionally canonical. Old route references create confusion and make future audits noisier than they need to be.
- Even if these are only tests or permissions examples, they keep pointing people at APIs we retired.

Evidence:

- `src/services/__tests__/PlatformRequestClient.test.ts` still uses `https://api.systemsculpt.com/api/v1/agent/sessions`.
- `src/studio/__tests__/studio-permissions.test.ts` still allows `https://api.systemsculpt.com/api/v1/agent/sessions`.

What to do:

1. Replace stale remote-session examples with `/api/v1/chat/completions` or a route-neutral HTTPS example.
2. Search again for `/api/v1/agent/sessions`, `/api/plugin/models`, `pi_managed`, and similar retired symbols.
3. Keep only the runtime-internal website harness references that are still legitimately used server-side.

Exit criteria:

- Plugin-facing surfaces no longer reference retired managed-session routes.
- Remaining references are clearly server-internal and intentional.

### 5. Turn low-credit behavior into a real verified release gate

Priority: `P2`

Why this matters:

- Credit exhaustion is one of the highest-risk user journeys for account-backed features.
- Right now we are assuming those paths are fine because the matrix skips them.

Evidence:

- `node scripts/plugin-chargeable-live-matrix.mjs` skipped all 9 low-credit checks because `SYSTEMSCULPT_E2E_LOW_CREDIT_LICENSE_KEY` is not configured.

What to do:

1. Provision a deterministic low-credit test license for production-smoke use.
2. Add that secret to the local/operator workflow used for release verification.
3. Re-run the matrix until the 402 contract is explicitly proven for chat, embeddings, web search, image generation, audio, YouTube, and documents.
4. Decide whether those checks should become a required release gate or a required post-deploy gate.

Exit criteria:

- Low-credit handling is no longer “skipped” in the release audit.
- The product returns consistent 402 behavior across all chargeable endpoints.

### 6. Verify community-plugin distribution surfaces, not just GitHub release + custom updater

Priority: `P2`

Why this matters:

- The custom updater is working again, but many users still think in terms of the Obsidian Community Plugins browser.
- “Released on GitHub” and “discoverable/updatable in every user-visible channel” are not exactly the same thing.

What to do:

1. Confirm the Community Plugins listing reflects 5.0.0 once the registry/index catches up.
2. Verify the listing metadata and download path still match the published assets.
3. Decide whether the plugin’s own update drawer should link users to the Obsidian plugin browser, GitHub release, or both.

Exit criteria:

- We can explicitly say where users will see 5.0.0 and how long each path takes to update.

### 7. Expand the user-facing changelog and announcement package

Priority: `P2`

Why this matters:

- There are 45 commits since `4.15.0`.
- The current 5.0.0 release notes are solid but still high-level compared with the scope of the transition.

What to do:

1. Turn the high-level release notes into a fuller changelog grouped by user-facing areas.
2. Write a short migration note explaining the SystemSculpt Pi-provider cutover in plain English.
3. Prepare the matching website/Discord/email announcement copy if this release is being actively promoted.

Exit criteria:

- Users can understand what changed, why 5.0.0 matters, and what to expect after updating.

### 8. Decide how to handle the post-release lockfile/automation hygiene fix

Priority: `P3`

Why this matters:

- `main` now has a follow-up commit that keeps `package-lock.json` and the release script aligned, but that change is not part of the `5.0.0` tag itself.
- This is not a functional production issue, but it is good release hygiene.

Evidence:

- `5.0.0` tag points at the release commit.
- `main` also has `chore(release): sync lockfile version metadata`.

What to do:

1. Decide whether to leave this as an internal follow-up on `main` or roll it into `5.0.1`.
2. Keep the improved release script in place so future releases do not drift the lockfile again.

Exit criteria:

- We have an explicit answer for whether this is “future release only” or “needs a patch release.”

### 9. Strengthen release automation around the proved weak points

Priority: `P3`

Why this matters:

- The release worked, but we still needed manual cleanup and extra verification to be confident.
- The goal is for future releases to require less heroics.

What to do:

1. Decide whether the live matrix should be split into a fast required subset and a slower post-deploy subset.
2. Add explicit checks for:
   - latest-version endpoint freshness
   - release asset reachability
   - clean-vault install/update UAT checklist completion
3. Capture the exact release operator checklist in one place so it is repeatable.

Exit criteria:

- The next release can be audited with less ad hoc spelunking.

### 10. Review remaining version-threshold messaging for clarity

Priority: `P3`

Why this matters:

- Some version-specific strings still reference older thresholds, especially around embeddings compatibility.
- They may be technically correct but still deserve a wording pass after a major release.

Evidence:

- `app/api/plugin/embeddings/route.ts` still gates embeddings at `4.15.1`.
- Related tests in `tests/plugin/embeddings-billing-api.test.ts` and `src/services/__tests__/SystemSculptProvider.test.ts` still talk about `4.15.1 or newer`.

What to do:

1. Decide whether to keep the current minimum version gate as-is.
2. If yes, make sure the copy still makes sense in a 5.0.0 world.
3. If no, update the minimum version, contract tests, and error payloads together.

Exit criteria:

- Version-gate copy is intentional, not just inherited.

## Recommended next sequence

If we want the cleanest possible follow-through, this is the order I would use:

1. Fix document processing in production.
2. Run clean-vault install/update/no-Pi UAT.
3. Update README/install/platform docs.
4. Remove stale retired-route references.
5. Provision and prove low-credit checks.
6. Tighten changelog/distribution/release automation follow-through.
