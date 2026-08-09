// Prototype CLI runner. Loads the seed file, scrapes each jurisdiction, writes a single
// normalized JSON output. In production this is replaced by a queue worker that upserts
// into Postgres and processes a nightly slice of the national list — the scrape logic
// (pipeline.js) is unchanged.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-... node src/run.js
//   ANTHROPIC_API_KEY=sk-... node src/run.js --only Kyle

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scrapeJurisdiction } from "./pipeline.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function isoDateOnly(d) {
  // Note: keep timestamps out of business logic elsewhere; this is just a stamp on output.
  return d.toISOString();
}

async function main() {
  const args = process.argv.slice(2);
  const onlyIdx = args.indexOf("--only");
  const only = onlyIdx !== -1 ? args[onlyIdx + 1] : null;

  const seeds = JSON.parse(await readFile(join(ROOT, "config", "seeds.json"), "utf8"));
  let jurisdictions = seeds.jurisdictions;
  if (only) jurisdictions = jurisdictions.filter((j) => j.city.toLowerCase() === only.toLowerCase());

  const now = isoDateOnly(new Date());
  const allOfficials = [];
  const allProblems = [];

  for (const j of jurisdictions) {
    process.stdout.write(`Scraping ${j.city}, ${j.state} (${j.body}) ... `);
    const { officials, problems } = await scrapeJurisdiction(j, { now });
    console.log(`${officials.length} officials, ${problems.length} problems`);
    allOfficials.push(...officials);
    for (const p of problems) allProblems.push({ city: j.city, state: j.state, ...p });
  }

  const out = {
    generated_at: now,
    count: allOfficials.length,
    officials: allOfficials,
    problems: allProblems,
  };
  const outPath = join(ROOT, "data", "officials.json");
  await writeFile(outPath, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${allOfficials.length} officials to ${outPath}`);
  if (allProblems.length) {
    console.log(`${allProblems.length} problem page(s):`);
    for (const p of allProblems) console.log(`  - ${p.city}, ${p.state}: ${p.url} -> ${p.error}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
