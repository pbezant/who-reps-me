// Scrapes the links people submit through the "help us grow this map" form (src/ReportBug.js ->
// netlify/functions/report-bug.mjs), which files each submission as a GitHub issue labeled
// `user-reported` — including, when the submitter gave one, a `**Link:** <url>` line in the
// issue body. report-bug.mjs's own header comment already flagged this as the natural next step:
// "Turning a confirmed report straight into a scrape of the linked URL would be a natural
// follow-up... isn't wired up yet." This is that follow-up.
//
// For each open `user-reported` issue with a link that hasn't been checked yet (see
// CHECKED_LABEL below), this:
//   1. Runs the URL past urlSafety.js's SSRF guard — a link a random visitor typed into a public
//      form is untrusted input, same threat model as the "suggest an official" form this reuses
//      logic from (see git history: PR #22 added it, PR #25 reverted it in favor of the bug-
//      report form alone — this script is what turns that form's links back into scraped data).
//   2. Fetches the page and runs it through extractOfficialSubmission() (extract.js) — the
//      "infer the jurisdiction AND extract officials in one call" prompt PR #22 built, since
//      unlike the batch scraper's roster pass, the jurisdiction here isn't known ahead of time.
//   3. Comments on the issue with what it found (or why it didn't extract anything usable), and
//      labels it CHECKED_LABEL so a future run doesn't re-spend an LLM call re-checking it.
//      Remove the label by hand to force a retry (e.g. after a source page comes back online).
//
// UNLIKE promote-blob-finds.js, this does NOT write into the working tree that run-daily.yml's
// own end-of-run commit auto-merges once CI passes. A link a random visitor typed in is a
// materially different trust level than a hand-vetted seed or the batch scraper's own discovery
// search, so on top of only staging officials confident enough to be "promotable" (government-
// sourced, jurisdiction-resolved, local/county scope, minimum extraction confidence — same bar
// PR #22 used), the actual shard writes this makes go into their OWN branch and pull request
// that nothing ever auto-merges — see run-daily.yml's "Phase 1a" steps and scrape-link.yml for
// that plumbing. A human always has to click merge before any of this reaches the shards.
//
// Two ways to run it:
//   node scripts/scrape-reported-links.js
//       Scans open user-reported issues for a link. Needs GITHUB_TOKEN (issues:write on this
//       repo) + GITHUB_OWNER/GITHUB_REPO (default parsed from GITHUB_REPOSITORY, else
//       "pbezant/who-reps-me").
//   LINK_URL=https://... node scripts/scrape-reported-links.js
//       Scrapes just that one URL, skipping the issue scan entirely (no GITHUB_TOKEN needed) —
//       what scrape-link.yml's workflow_dispatch input uses for an on-demand check outside the
//       daily run.
//
// Both modes need an LLM_PRESET/LLM_API_KEY (or ANTHROPIC_API_KEY) — see scraper/README.md.

import { writeFile, mkdir, appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkSubmissionUrl } from "../src/urlSafety.js";
import { fetchPage } from "../src/fetch.js";
import { findMediaCandidates } from "../src/media.js";
import { extractOfficialSubmission } from "../src/extract.js";
import { normalize } from "../src/normalize.js";
import { writeShards } from "../src/output.js";
import { readJsonIfExists, jurisdictionKey, loadJurisdictions, CONFIG_DIR } from "../src/seeds.js";
import { getCallCount } from "../src/llm.js";
import { readUsedToday, remainingBudget, estimateBudgetFromRemaining, recordUsage } from "../src/usage-ledger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const PUBLIC_OFFICIALS_DIR = join(REPO_ROOT, "public", "officials");
const DISCOVERED_PATH = join(CONFIG_DIR, "seeds.discovered.json");

const GITHUB_API = "https://api.github.com";
const ISSUE_LABEL = "user-reported";
const CHECKED_LABEL = "link-checked";

// Kept in sync with the levels this dataset actually covers (state legislators/executives come
// from Open States, federal reps from 5calls — both sourced elsewhere) — same scope PR #22's
// submit-official.mjs used.
const PROMOTABLE_LEVELS = new Set(["local", "county"]);
const MIN_PROMOTABLE_CONFIDENCE = 0.6;

// This phase runs before scrape/discover/qa in run-daily.yml, and the number of open
// user-reported issues with a link on any given day is small (a handful, not hundreds) — but cap
// it anyway so a burst of reports (or someone gaming the form) can't eat the day's whole shared
// budget before the batch phases get a turn. One extraction call per link, no bio-page follow-up.
const DEFAULT_MAX_LINKS = 15;
const AVG_CALLS_PER_LINK = 1;

// --- pure helpers (exported for scrape-reported-links.test.js) ---------------------------------

// report-bug.mjs writes a submitted URL onto its own line as "**Link:** <url>" in the issue body
// it files (see that function's own issueBody template) — this is the inverse read of that.
export function parseLinkFromIssueBody(body) {
  const m = /\*\*Link:\*\*\s*(\S+)/.exec(body || "");
  return m ? m[1] : null;
}

// Whether an already-run extraction is trustworthy enough to stage for review automatically.
// Mirrors PR #22's isPromotableSubmission(), just operating on a fresh extraction result instead
// of a stored Netlify Blobs entry (this script has no Blobs store — nothing here is cached).
export function isPromotableExtraction({ isGovernmentSource, jurisdiction, officials } = {}) {
  if (!isGovernmentSource) return false;
  if (!officials?.length) return false;
  if (!jurisdiction?.city || !jurisdiction?.state) return false;
  if (!PROMOTABLE_LEVELS.has(jurisdiction.level)) return false;
  return officials.some((o) => (o.confidence ?? 0) >= MIN_PROMOTABLE_CONFIDENCE);
}

// One-line reason a checked link wasn't staged — shown both in the issue comment and this run's
// "needs a look" summary. Pure/no I/O.
export function reasonNotPromotable({ ok, error, isGovernmentSource, jurisdiction, officials } = {}) {
  if (!ok) return `couldn't load the page: ${error || "unknown error"}`;
  if (!officials?.length) return "no officials extracted";
  if (!isGovernmentSource) return "doesn't look like an official government source";
  if (!jurisdiction?.city || !jurisdiction?.state) return "jurisdiction not resolved";
  if (!PROMOTABLE_LEVELS.has(jurisdiction?.level)) return `out of scope for this dataset (level: ${jurisdiction?.level || "unknown"})`;
  return "extraction confidence too low";
}

export function summarizeOfficials(officials) {
  return (officials || []).map((o) => `${o.name}${o.office ? ` (${o.office})` : ""}`).join(", ");
}

// --- GitHub REST (issue-scan mode only) ---------------------------------------------------------

function githubConfig() {
  const token = process.env.GITHUB_TOKEN;
  const [repoOwner, repoName] = (process.env.GITHUB_REPOSITORY || "").split("/");
  const owner = process.env.GITHUB_OWNER || repoOwner || "pbezant";
  const repo = process.env.GITHUB_REPO || repoName || "who-reps-me";
  return { token, owner, repo };
}

async function githubRequest(path, { method = "GET", body, token } = {}) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`GitHub API ${method} ${path} -> HTTP ${res.status}: ${data?.message || "unknown error"}`);
  }
  return data;
}

// Open user-reported issues this script hasn't already labeled CHECKED_LABEL on a previous run.
// The `labels` query param is AND-only (no "has A but not B"), so the CHECKED_LABEL exclusion is
// done client-side.
async function getCheckableIssues({ owner, repo, token }) {
  const issues = await githubRequest(
    `/repos/${owner}/${repo}/issues?labels=${encodeURIComponent(ISSUE_LABEL)}&state=open&per_page=50`,
    { token }
  );
  return (Array.isArray(issues) ? issues : [])
    .filter((i) => !i.pull_request) // the issues endpoint also returns PRs carrying the label
    .filter((i) => !i.labels?.some((l) => (typeof l === "string" ? l : l.name) === CHECKED_LABEL));
}

async function commentAndMarkChecked({ owner, repo, token, issueNumber, comment }) {
  await githubRequest(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    token,
    body: { body: comment },
  });
  await githubRequest(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
    method: "POST",
    token,
    body: { labels: [CHECKED_LABEL] },
  });
}

// --- scrape + extract ----------------------------------------------------------------------------

async function processUrl(url, { allowBrowser }) {
  const now = new Date().toISOString();
  const page = await fetchPage(url, { timeoutMs: 30000, allowBrowser });
  if (!page.ok) {
    return { ok: false, error: page.error, isGovernmentSource: false, jurisdiction: {}, officials: [] };
  }

  const media = findMediaCandidates(page.html, url);
  let extraction;
  try {
    extraction = await extractOfficialSubmission({ text: page.text, url, media });
  } catch (err) {
    return { ok: false, error: err.message, isGovernmentSource: false, jurisdiction: {}, officials: [] };
  }

  const { isGovernmentSource, jurisdiction, officials: rawOfficials } = extraction;
  // Normalize even when the jurisdiction couldn't be resolved (city/state null) — this keeps
  // whatever was found visible in the issue comment for a human to read, rather than discarding
  // a real extraction just because normalize() can't build a clean id for it. isPromotableExtraction()
  // is what actually gates whether an unresolved-jurisdiction record ever reaches a shard.
  const normalizedJurisdiction = {
    city: jurisdiction.city,
    state: jurisdiction.state,
    level: jurisdiction.level || "local",
    body: jurisdiction.body,
  };
  const officials = rawOfficials
    .map((o) => normalize(o, { jurisdiction: normalizedJurisdiction, sourceUrl: url, extractedAt: now }))
    .filter(Boolean);

  return { ok: true, isGovernmentSource, jurisdiction: normalizedJurisdiction, officials };
}

async function main() {
  const linkUrlOverride = process.env.LINK_URL?.trim();
  const allowBrowser = process.env.SCRAPER_BROWSER !== "0";

  const promotedOfficials = [];
  const needsReview = [];
  let checked = 0;

  if (linkUrlOverride) {
    // Single-URL mode (scrape-link.yml) — no issue to comment on/label, no GitHub API access at all.
    const check = checkSubmissionUrl(linkUrlOverride);
    if (!check.ok) {
      console.error(`Refused: ${check.reason}`);
      process.exitCode = 1;
      return;
    }
    checked = 1;
    const result = await processUrl(check.url.href, { allowBrowser });
    if (isPromotableExtraction(result)) {
      promotedOfficials.push(...result.officials);
      console.log(`  PROMOTABLE  ${result.jurisdiction.city}, ${result.jurisdiction.state}: ${summarizeOfficials(result.officials)}`);
    } else {
      const reason = reasonNotPromotable(result);
      needsReview.push({ url: check.url.href, reason });
      console.log(`  NEEDS REVIEW  ${check.url.href} — ${reason}`);
    }
  } else {
    const { token, owner, repo } = githubConfig();
    if (!token) {
      console.error("GITHUB_TOKEN is not set — nothing to scan (see this file's header comment). Skipping.");
      return;
    }

    const remaining = remainingBudget(await readUsedToday());
    const budgetCap = estimateBudgetFromRemaining(remaining, AVG_CALLS_PER_LINK);
    const maxLinks = Math.min(Number(process.env.LINK_SCRAPE_MAX || DEFAULT_MAX_LINKS), budgetCap);
    if (maxLinks <= 0) {
      console.log("No shared daily budget left to check reported links — skipping.");
      return;
    }

    let issues;
    try {
      issues = await getCheckableIssues({ owner, repo, token });
    } catch (err) {
      console.error(`Couldn't list ${ISSUE_LABEL} issues: ${err.message}`);
      process.exitCode = 1;
      return;
    }

    const withLink = [];
    const withoutLink = [];
    for (const issue of issues) {
      const url = parseLinkFromIssueBody(issue.body);
      (url ? withLink : withoutLink).push({ issue, url });
    }

    // Nothing to scrape in these — mark them checked too so this doesn't re-read their body every
    // single day forever looking for a link that was never there.
    for (const { issue } of withoutLink) {
      await commentAndMarkChecked({
        owner, repo, token, issueNumber: issue.number,
        comment: "This report didn't include a link, so there's nothing here to scrape automatically.",
      }).catch((err) => console.error(`  Failed to label #${issue.number}: ${err.message}`));
    }

    const toCheck = withLink.slice(0, maxLinks);
    console.log(
      `Checking ${toCheck.length} of ${withLink.length} reported link(s) with a URL ` +
        `(${issues.length} open ${ISSUE_LABEL} issue(s) total, budget cap ${maxLinks}).`
    );

    for (const { issue, url } of toCheck) {
      checked++;
      const check = checkSubmissionUrl(url);
      if (!check.ok) {
        needsReview.push({ url, issue: issue.number, reason: check.reason });
        console.log(`  NEEDS REVIEW  #${issue.number} ${url} — ${check.reason}`);
        await commentAndMarkChecked({
          owner, repo, token, issueNumber: issue.number,
          comment: `The linked URL couldn't be checked automatically: ${check.reason}`,
        }).catch((err) => console.error(`  Failed to comment on #${issue.number}: ${err.message}`));
        continue;
      }

      const result = await processUrl(check.url.href, { allowBrowser });

      if (isPromotableExtraction(result)) {
        promotedOfficials.push(...result.officials);
        const names = summarizeOfficials(result.officials);
        console.log(`  PROMOTABLE  #${issue.number} ${result.jurisdiction.city}, ${result.jurisdiction.state}: ${names}`);
        await commentAndMarkChecked({
          owner, repo, token, issueNumber: issue.number,
          comment: `Checked the link: found ${names} for ${result.jurisdiction.city}, ${result.jurisdiction.state}. This will be included in a pull request for review, not added automatically — see this repo's open PRs.`,
        }).catch((err) => console.error(`  Failed to comment on #${issue.number}: ${err.message}`));
      } else {
        const reason = reasonNotPromotable(result);
        needsReview.push({ url, issue: issue.number, reason });
        console.log(`  NEEDS REVIEW  #${issue.number} ${url} — ${reason}`);
        await commentAndMarkChecked({
          owner, repo, token, issueNumber: issue.number,
          comment: `Checked the link, but couldn't add this automatically: ${reason}. Still worth a manual look.`,
        }).catch((err) => console.error(`  Failed to comment on #${issue.number}: ${err.message}`));
      }
    }
  }

  const now = new Date().toISOString();
  if (promotedOfficials.length) {
    const alreadySeeded = await loadJurisdictions();
    const seededKeys = new Set(alreadySeeded.map(jurisdictionKey));
    const discoveredFile = (await readJsonIfExists(DISCOVERED_PATH)) || { jurisdictions: [], misses: [] };
    const discoveredKeys = new Set(discoveredFile.jurisdictions.map(jurisdictionKey));

    // One jurisdiction entry per distinct (state, city, level) this run staged, not one per
    // official — several officials from the same link share one jurisdiction.
    const byJurisdiction = new Map();
    for (const o of promotedOfficials) {
      const j = {
        city: o.jurisdiction.city,
        state: o.jurisdiction.state,
        level: o.level,
        body: o.body,
        urls: [o.source_url].filter(Boolean),
        discovered_at: o.extracted_at || now,
      };
      byJurisdiction.set(jurisdictionKey(j), j);
    }
    let newJurisdictions = 0;
    for (const [key, j] of byJurisdiction) {
      if (!seededKeys.has(key) && !discoveredKeys.has(key)) {
        discoveredFile.jurisdictions.push(j);
        discoveredKeys.add(key);
        newJurisdictions++;
      }
    }
    if (newJurisdictions > 0) {
      discoveredFile.generated_at = now;
      await mkdir(CONFIG_DIR, { recursive: true });
      await writeFile(DISCOVERED_PATH, JSON.stringify(discoveredFile, null, 2));
    }

    const { states } = await writeShards(promotedOfficials, { publicDir: PUBLIC_OFFICIALS_DIR, now });
    console.log(
      `\nStaged ${promotedOfficials.length} official(s) across ${states.length} state shard(s) for review ` +
        `(${newJurisdictions} new jurisdiction(s)).`
    );
  }

  console.log(
    `\nChecked ${checked} link(s), ${promotedOfficials.length} official(s) staged for review` +
      (needsReview.length ? `, ${needsReview.length} need a manual look.` : ".")
  );
  for (const r of needsReview) {
    console.log(`  NEEDS REVIEW  ${r.issue ? `#${r.issue} ` : ""}${r.url} — ${r.reason}`);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      `## Reported-link scrape`,
      ``,
      `- Checked **${checked}** link(s)`,
      `- **${promotedOfficials.length}** official(s) staged for review`,
      ...(needsReview.length
        ? [``, `### Needs a manual look`, ``, ...needsReview.map((r) => `- ${r.issue ? `#${r.issue} ` : ""}[${r.url}](${r.url}): ${r.reason}`)]
        : []),
    ];
    await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  }

  if (getCallCount() > 0) {
    const usage = await recordUsage(getCallCount(), { phase: "reported-links" });
    console.log(`\nLLM calls this run: ${getCallCount()} (today's running total: ${usage.calls_used}).`);
  }
}

// Only run when this file is executed directly, not when imported for its exported pure
// functions — see federal-details.js for the same guard and why it's needed.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
