import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("provider handoffs through the real Pi stream and agent loop", () => {
  const result = spawnSync(process.execPath, ["--import", "./tests/lib/pi-compat.mjs", "--experimental-test-module-mocks", "--import", "tsx", "--test", "tests/fixtures/provider-handoff.mjs"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
