# Obsidian community review

Tony Grosinger opened [issue #328](https://github.com/SystemSculpt/obsidian-systemsculpt-ai/issues/328) on August 27, 2026: releases that still fail automated review after October 30, 2026 will no longer be listed or installable from the Obsidian community directory.

The public [6.7.2 scorecard](https://community.obsidian.md/plugins/systemsculpt-ai#scorecard) scanned commit `b2bf5f76829ce2ad8d9f4f68cef527d7338affea` and reported 891 occurrences: 18 errors, 812 warnings, and 61 recommendations. The table below preserves every grouped finding and its occurrence count; the public scorecard preserves every original file and line.

| Severity | Count | Finding |
| --- | ---: | --- |
| Error | 5 | Disabling `obsidianmd/no-global-this` is not allowed. |
| Error | 4 | Disabling `obsidianmd/prefer-create-el` is not allowed. |
| Error | 3 | Disabling `obsidianmd/rule-custom-message` is not allowed. |
| Error | 2 | Disabling `obsidianmd/ui/sentence-case` is not allowed. |
| Error | 1 | Disabling `obsidianmd/commands/no-default-hotkeys` is not allowed. |
| Error | 1 | Disabling `obsidianmd/settings-tab/prefer-setting-definitions` is not allowed. |
| Error | 1 | Unsafe assignment to `innerHTML`. |
| Error | 1 | Unsafe assignment to `innerHTML` through the `rawHtml` function parameter. |
| Warning | 262 | Unexpected `any`; specify a different type. |
| Warning | 194 | Type assertion is unnecessary because it does not change the expression type. |
| Warning | 58 | Type assertion is unnecessary because the receiver accepts the original expression type. |
| Warning | 47 | Avoid `!important`; increase selector specificity or use CSS variables. |
| Warning | 45 | Promise rejection reason must be an `Error`. |
| Warning | 41 | Promise must be awaited, handled, or explicitly ignored with `void`. |
| Warning | 30 | Empty block statement. |
| Warning | 24 | `require()` style import is forbidden. |
| Warning | 12 | Promise returned where a void callback was expected. |
| Warning | 11 | ESLint directive lacks a description. |
| Warning | 11 | Regular expression contains control characters `\x00` or `\x1f`. |
| Warning | 7 | Use Obsidian `requestUrl` instead of `fetch`. |
| Warning | 7 | Lexical declaration appears directly in a `case` block. |
| Warning | 6 | Unbound method may receive an unintended `this`; bind it, use an arrow, or declare `this: void`. |
| Warning | 5 | `any` overrides the other union members. |
| Warning | 5 | Avoid `:has` because broad selector invalidation can hurt performance. |
| Warning | 4 | `StandardModal` override returns a Promise where void was expected. |
| Warning | 4 | Thrown value must be an error object. |
| Warning | 3 | Direct `innerHTML` or `outerHTML` write. |
| Warning | 3 | Promise-returning property supplied where void was expected. |
| Warning | 3 | `unknown` overrides the other union members. |
| Warning | 2 | Unnecessary escape character `\"`. |
| Warning | 2 | Unnecessary `try`/`catch` wrapper. |
| Warning | 2 | Do not call `Object.prototype.isPrototypeOf` through a target object. |
| Warning | 2 | Regular expression contains control character `\x00`. |
| Warning | 2 | Unexpected `await` of a non-Promise value. |
| Warning | 2 | `box-decoration-break` is only partially supported by Obsidian 1.6.5. |
| Warning | 2 | `clip-path` is only partially supported by Obsidian 1.6.5. |
| Warning | 1 | Plugin description starts with the plugin name. |
| Warning | 1 | Plugin description includes the word “Obsidian”. |
| Warning | 1 | Direct filesystem access outside the vault through Node.js `fs`. |
| Warning | 1 | Shell execution through `child_process`. |
| Warning | 1 | Unnecessary `catch` clause. |
| Warning | 1 | `Plugin` override returns a Promise where void was expected. |
| Warning | 1 | Unguarded import of `node:fs/promises`. |
| Warning | 1 | Unguarded import of `node:path`. |
| Warning | 1 | Unguarded import of `node:os`. |
| Warning | 1 | Unguarded import of `node:child_process`. |
| Warning | 1 | `PluginSettingTab` override returns a Promise where void was expected. |
| Warning | 1 | A specific tool-cancellation union is overridden by `string`. |
| Warning | 1 | Unnecessary escape character `\[`. |
| Warning | 1 | Unnecessary escape character `\/`. |
| Warning | 1 | Explicit `undefined` on an optional parameter. |
| Warning | 1 | `column-gap` was classified as partially supported multicolumn CSS. |
| Recommendation | 20 | `error` is defined but never used. |
| Recommendation | 10 | Deprecated `Workspace.activeLeaf` access. |
| Recommendation | 6 | `e` is defined but never used. |
| Recommendation | 6 | `_` is defined but never used. |
| Recommendation | 2 | Missing GitHub artifact attestations for `main.js` and `styles.css`. |
| Recommendation | 2 | Deprecated `KeyboardEvent.keyCode` access. |
| Recommendation | 2 | `err` is defined but never used. |
| Recommendation | 1 | Vault enumeration through `getFiles` or `getMarkdownFiles`. |
| Recommendation | 1 | System clipboard access. |
| Recommendation | 1 | Device-local persistence through `localStorage` or `sessionStorage`. |
| Recommendation | 1 | `_` is assigned but never used. |
| Recommendation | 1 | `loadError` is defined but never used. |
| Recommendation | 1 | `migrationError` is defined but never used. |
| Recommendation | 1 | `fallbackError` is defined but never used. |
| Recommendation | 1 | `_error` is defined but never used. |
| Recommendation | 1 | `shownRemoved` is assigned but never used. |
| Recommendation | 1 | `shownAdded` is assigned but never used. |
| Recommendation | 1 | `Element` is defined but never used. |
| Recommendation | 1 | Deprecated `Document.execCommand` fallback. |
| Recommendation | 1 | Deprecated `Document.caretRangeFromPoint` fallback. |

## Other scorecard results

- Pass: individual vault reads use the Obsidian API.
- Pass: vault writes use the Obsidian API.
- Pass: no vulnerable production dependencies were found.
- Pass: the scanner reproduced the published `main.js` byte-for-byte. A separate local rebuild also matched all three 6.7.2 release assets byte-for-byte.
- Indicator: 30 first-party network request call sites.
- Indicator: runtime `atob` and `btoa` base64 conversion.
- Unavailable in that scan: malware, obfuscation, and network-request scans.

## Local checker

`eslint-plugin-obsidianmd` is pinned as a development dependency. `eslint.community.config.mjs` mirrors the directory's documented source scope and scanner exclusions, and the canonical `npm run check` gate includes it.

~~~bash
npm run lint:community
npm run lint:community:fix
~~~

The local mirror now reports zero source findings. Manifest validation, CSS policy, production bundle inspection, mobile compatibility, tests, and release guards run through `npm run check` and `npm run check:full`.

## Required release handoff

The release workflow rebuilds the tagged source, downloads the three published GitHub assets, requires byte-for-byte equality, and creates GitHub provenance attestations for those exact bytes before publishing first-party release metadata.

The remaining static capability indicators describe intentional features: first-party network requests, runtime base64 conversion, vault enumeration, clipboard access, device-local preferences, and desktop-only external-file or shell execution. The README discloses each user-visible capability. CSS compatibility warnings are non-blocking and retained only where they protect host overrides, accessibility, or graceful fallback behavior.

Before publishing, push the candidate ref, run the community directory's **Review branch** preview, and require zero errors. After publishing, request a new review and verify the new release's manifest, assets, source, build, and attestation sections on the directory dashboard.
