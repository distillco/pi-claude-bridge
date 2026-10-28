import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The fixture mocks the Agent SDK module, which needs --experimental-test-module-mocks.
test("session_shutdown resolves the tool calls a running query holds", () => {
  const result = spawnSync(process.execPath, ["--import", "./tests/lib/pi-compat.mjs", "--experimental-test-module-mocks", "--import", "tsx", "--test", "tests/fixtures/shutdown-pending-tools.mjs"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
