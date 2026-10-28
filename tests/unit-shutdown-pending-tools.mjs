import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The fixture mocks the Agent SDK module, which needs --experimental-test-module-mocks.
test("session_shutdown resolves the tool calls a running query holds", () => {
  // node --test sets NODE_TEST_CONTEXT for its children, and a child run that
  // inherits it exits 0 even when its tests fail, so drop it.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const result = spawnSync(process.execPath, ["--import", "./tests/lib/pi-compat.mjs", "--experimental-test-module-mocks", "--import", "tsx", "--test", "tests/fixtures/shutdown-pending-tools.mjs"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 20_000, env,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
