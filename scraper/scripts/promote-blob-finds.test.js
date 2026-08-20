import { test } from "node:test";
import assert from "node:assert/strict";
import { levelFromBody, jurisdictionFromEntry } from "./promote-blob-finds.js";

test("levelFromBody() reads county vs local from local-officials.mjs's own body string", () => {
  assert.equal(levelFromBody("Travis County Commissioners Court"), "county");
  assert.equal(levelFromBody("Austin City Council"), "local");
  assert.equal(levelFromBody(null), "local"); // no signal — default to the more common case
});

test("jurisdictionFromEntry() builds a seeds.discovered.json-shaped record from a cached hit", () => {
  const entry = {
    ok: true,
    officials: [
      { jurisdiction: { city: "Boulder", state: "CO" }, body: "Boulder City Council" },
      { jurisdiction: { city: "Boulder", state: "CO" }, body: "Boulder City Council" },
    ],
    source_url: "https://bouldercolorado.gov/government/city-council",
    checked_at: "2026-08-01T00:00:00.000Z",
  };
  assert.deepEqual(jurisdictionFromEntry(entry), {
    city: "Boulder",
    state: "CO",
    level: "local",
    body: "Boulder City Council",
    urls: ["https://bouldercolorado.gov/government/city-council"],
    discovered_at: "2026-08-01T00:00:00.000Z",
  });
});

test("jurisdictionFromEntry() returns null for a cached miss (ok: false)", () => {
  assert.equal(jurisdictionFromEntry({ ok: false, officials: [] }), null);
});

test("jurisdictionFromEntry() returns null for a hit with no officials", () => {
  assert.equal(jurisdictionFromEntry({ ok: true, officials: [] }), null);
});

test("jurisdictionFromEntry() returns null rather than guess when jurisdiction city/state is missing", () => {
  const entry = { ok: true, officials: [{ body: "Somewhere City Council" }], source_url: "https://example.com" };
  assert.equal(jurisdictionFromEntry(entry), null);
});

test("jurisdictionFromEntry() falls back to `now` when the entry has no checked_at", () => {
  const entry = {
    ok: true,
    officials: [{ jurisdiction: { city: "Elgin", state: "TX" }, body: "Elgin City Council" }],
    source_url: "https://www.elgintx.com/149/City-Council",
  };
  const result = jurisdictionFromEntry(entry, { now: "2026-08-20T00:00:00.000Z" });
  assert.equal(result.discovered_at, "2026-08-20T00:00:00.000Z");
});
