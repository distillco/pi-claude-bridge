import { test } from "node:test";
import { runFixture } from "./lib/run-fixture.mjs";

test("a stopped query answers its held tool calls and closes the SDK query that is running", () => {
  runFixture("tests/fixtures/query-stop.mjs");
});
