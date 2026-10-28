import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Runs a fixture that mocks the Agent SDK module in its own node --test child,
// because module mocks need --experimental-test-module-mocks.
//
// node --test sets NODE_TEST_CONTEXT for its children, and a child run that
// inherits it exits 0 even when its tests fail, so drop it.
export function runFixture(path) {
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const result = spawnSync(process.execPath, ["--import", "./tests/lib/pi-compat.mjs", "--experimental-test-module-mocks", "--import", "tsx", "--test", path], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", timeout: 20_000, env,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}
