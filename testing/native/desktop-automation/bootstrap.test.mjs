import test from "node:test";
import assert from "node:assert/strict";
import { selectPluginTarget } from "./bootstrap.mjs";

const targets = [
  {
    index: 0,
    vaultName: "Test Vault",
    vaultRoot: "/Users/systemsculpt/Documents/Test Vault",
  },
  {
    index: 1,
    vaultName: "private-vault",
    vaultRoot: "/Users/systemsculpt/gits/private-vault",
  },
];

test("selectPluginTarget falls back to the first target when no selector is provided", () => {
  assert.equal(selectPluginTarget(targets).vaultName, "Test Vault");
});

test("selectPluginTarget honors an explicit vault name even when a target index is also present", () => {
  const target = selectPluginTarget(targets, {
    targetIndex: 0,
    vaultName: "private-vault",
  });

  assert.equal(target.vaultName, "private-vault");
  assert.equal(target.index, 1);
});

test("selectPluginTarget honors an explicit vault path even when a target index is also present", () => {
  const target = selectPluginTarget(targets, {
    targetIndex: 0,
    vaultPath: "/Users/systemsculpt/gits/private-vault",
  });

  assert.equal(target.vaultName, "private-vault");
  assert.equal(target.index, 1);
});

test("selectPluginTarget uses target index when it is the only selector", () => {
  const target = selectPluginTarget(targets, {
    targetIndex: 1,
  });

  assert.equal(target.vaultName, "private-vault");
});

test("selectPluginTarget fails fast when an explicit vault selector does not match", () => {
  assert.throws(
    () =>
      selectPluginTarget(targets, {
        vaultName: "missing-vault",
      }),
    /No plugin target matched vault name missing-vault/
  );
});
