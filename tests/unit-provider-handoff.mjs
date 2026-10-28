import { test } from "node:test";
import { runFixture } from "./lib/run-fixture.mjs";

test("provider handoffs through the real Pi stream and agent loop", () => {
  runFixture("tests/fixtures/provider-handoff.mjs");
});
