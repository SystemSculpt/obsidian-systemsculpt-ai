import test from "node:test";
import assert from "node:assert/strict";
import {
  buildInteractiveUserCandidates,
  buildWrappedInteractiveTaskScript,
  resolveDefaultInteractiveUser,
  shouldFallbackToDirectInteractiveRun,
} from "./interactive-task.mjs";
import { resolveWindowsInteractiveTempRoot } from "./common.mjs";

test("resolveDefaultInteractiveUser prefers a domain-qualified username", () => {
  assert.equal(
    resolveDefaultInteractiveUser({
      USERDOMAIN: "CWM205",
      USERNAME: "Administrator",
    }),
    "CWM205\\Administrator"
  );
});

test("resolveDefaultInteractiveUser falls back to USERNAME", () => {
  assert.equal(
    resolveDefaultInteractiveUser({
      USERNAME: "administrator",
    }),
    "administrator"
  );
});

test("resolveDefaultInteractiveUser falls back to administrator when env is empty", () => {
  assert.equal(resolveDefaultInteractiveUser({}), "administrator");
});

test("buildInteractiveUserCandidates keeps the requested user and adds local-account fallbacks", () => {
  assert.deepEqual(buildInteractiveUserCandidates("CWM205\\Administrator"), [
    "CWM205\\Administrator",
    "Administrator",
    ".\\Administrator",
  ]);
});

test("buildInteractiveUserCandidates adds a local-account fallback for plain usernames", () => {
  assert.deepEqual(buildInteractiveUserCandidates("administrator"), [
    "administrator",
    ".\\administrator",
  ]);
});

test("resolveWindowsInteractiveTempRoot prefers SYSTEMROOT Temp", () => {
  assert.equal(
    resolveWindowsInteractiveTempRoot({
      SYSTEMROOT: "D:\\Windows",
    }),
    "D:\\Windows\\Temp"
  );
});

test("buildWrappedInteractiveTaskScript writes failure details when the inner script does not emit a result", () => {
  const script = buildWrappedInteractiveTaskScript("Write-Host 'hello'", "C:\\Windows\\Temp\\result.json");
  assert.match(script, /Interactive script completed without writing a result file/);
  assert.match(script, /C:\\Windows\\Temp\\result\.json/);
  assert.match(script, /catch \{/);
});

test("shouldFallbackToDirectInteractiveRun matches scheduled-task access denied failures", () => {
  const error = new Error("PowerShell failed.\nRegister-ScheduledTask : Access is denied.\n0x80070005");
  assert.equal(shouldFallbackToDirectInteractiveRun(error), true);
  assert.equal(shouldFallbackToDirectInteractiveRun(new Error("PowerShell failed.\nGet-ChildItem : Not found")), false);
});
