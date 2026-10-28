import assert from "node:assert/strict";
import test from "node:test";
import { changedTestCommands, moneySuites } from "./test-changed.mjs";

const money = moneySuites();

test("every PR runs the license and credits suites even for documentation-only changes", () => {
  const [command] = changedTestCommands(["README.md"]);
  assert.ok(command.includes("--strict-console"));
  assert.ok(command.includes("--findRelatedTests"));
  assert.ok(command.includes("--passWithNoTests"));
  for (const file of money) assert.ok(command.includes(file), file);
  assert.equal(new Set(money).size, money.length);
  assert.ok(money.includes("src/services/__tests__/SystemSculptService.credits-requests.test.ts"));
});

test("source changes select related tests without duplicating money inputs", () => {
  const [command] = changedTestCommands(["src/example file.ts", money[0], "docs/example.md"]);
  assert.ok(command.includes("src/example file.ts"));
  assert.equal(command.filter((arg) => arg === money[0]).length, 1);
  assert.ok(!command.includes("docs/example.md"));
});

test("embeddings changes use their separate Jest config", () => {
  const commands = changedTestCommands(["src/services/embeddings/EmbeddingsService.ts"]);
  assert.equal(commands.length, 2);
  assert.ok(commands[1].includes("jest.embeddings.config.cjs"));
  assert.ok(commands[1].includes("--findRelatedTests"));
  assert.equal(changedTestCommands(["src/services/Other.ts"]).length, 1);
});

test("integration and bundle changes run the already-built integration suite", () => {
  for (const file of ["testing/integration/example.test.ts", "esbuild.config.mjs", "manifest.json"]) {
    const commands = changedTestCommands([file]);
    assert.equal(commands.length, 2);
    assert.ok(commands[1].includes("jest.integration.config.cjs"));
    assert.ok(commands[1].includes("--strict-console"));
  }
});

test("missing money suites fail instead of silently reducing PR coverage", () => {
  assert.throws(() => moneySuites("/nonexistent-plugin-test-fixture"));
});
