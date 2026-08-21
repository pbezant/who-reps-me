import { test } from "node:test";
import assert from "node:assert/strict";
import { isTruncatedFinish } from "./llm.js";

test("isTruncatedFinish() recognizes OpenAI-compatible truncation", () => {
  assert.equal(isTruncatedFinish("length"), true);
});

test("isTruncatedFinish() recognizes Anthropic truncation", () => {
  assert.equal(isTruncatedFinish("max_tokens"), true);
});

test("isTruncatedFinish() treats a normal completion as not truncated", () => {
  assert.equal(isTruncatedFinish("stop"), false);
  assert.equal(isTruncatedFinish("end_turn"), false);
});

test("isTruncatedFinish() tolerates a missing/unknown reason", () => {
  assert.equal(isTruncatedFinish(undefined), false);
  assert.equal(isTruncatedFinish(null), false);
  assert.equal(isTruncatedFinish("content_filter"), false);
});
