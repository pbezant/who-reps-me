// One-off recording script for the LinkedIn demo video.
// Searches "Who Reps Me?" for a King County, WA address (highest-population, fully-photographed
// jurisdiction in the committed data), waits for results, then scrolls smoothly through the
// whole list. Records to webm via Playwright's built-in video capture, then muxes to mp4 with
// the ffmpeg binary Playwright already has cached locally.
//
// Usage:
//   node record-search-video.js
// Requires the dev server already running (see DEV_URL below).

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const DEV_URL = process.env.DEV_URL || 'http://localhost:3210';
const ADDRESS = process.env.ADDRESS || '600 4th Ave, Seattle, WA 98104';
const OUT_DIR = path.join(__dirname, 'video-out');
const VIEWPORT = { width: 1440, height: 900 };

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: OUT_DIR, size: VIEWPORT },
  });
  const page = await context.newPage();

  console.log(`Loading ${DEV_URL} ...`);
  await page.goto(DEV_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  const input = page.locator('input.search, input[placeholder*="address" i]').first();
  await input.click();
  // Type char-by-char (not .fill()) so it reads naturally on video and fires the app's own
  // debounced Photon suggestion lookup (src/App.js fetchSuggestions) the same way a real user
  // typing would.
  await page.keyboard.type(ADDRESS, { delay: 45 });

  // Wait out the 300ms debounce plus the Photon round-trip, then wait for the suggestion
  // dropdown itself (src/App.js renders it as <ul class="address-suggestions">).
  const suggestionList = page.locator('ul.address-suggestions');
  await suggestionList.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400); // let the list finish rendering/settling before we read it

  const options = suggestionList.locator('li');
  const count = await options.count().catch(() => 0);

  if (count > 0) {
    // Prefer the option that actually matches our target city/zip (Photon can rank a
    // same-address POI ahead of the plain street address) — fall back to the first one.
    const wantZip = (ADDRESS.match(/\d{5}/) || [])[0];
    const wantCity = ADDRESS.split(',')[1]?.trim().toLowerCase();
    let chosen = options.first();
    for (let i = 0; i < count; i++) {
      const text = ((await options.nth(i).textContent()) || '').toLowerCase();
      if ((wantZip && text.includes(wantZip)) || (wantCity && text.includes(wantCity))) {
        chosen = options.nth(i);
        break;
      }
    }
    console.log(`Suggestions shown: ${count} — clicking: "${(await chosen.textContent())?.trim()}"`);
    await chosen.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300); // beat on the open dropdown so it's readable on video
    await chosen.click();
  } else {
    // Suggestion API had no result for this address (rate-limited shared demo server) —
    // fall back to submitting the typed address directly so the recording still completes.
    console.log('No suggestion dropdown appeared — falling back to Enter.');
    await page.keyboard.press('Enter');
  }

  // Wait for at least one result card image to appear.
  await page.waitForSelector('img', { timeout: 20000 });
  // Give every image a beat to actually load (real government CDNs, not instant).
  await page.waitForTimeout(2500);
  await page.waitForLoadState('networkidle').catch(() => {});

  const imgs = await page.locator('img').all();
  let loaded = 0;
  for (const img of imgs) {
    const ok = await img.evaluate((el) => el.complete && el.naturalWidth > 0).catch(() => false);
    if (ok) loaded++;
  }
  console.log(`Result images loaded: ${loaded}/${imgs.length}`);

  // Hold on the top of the results for a beat before scrolling.
  await page.waitForTimeout(1500);

  // The page scrolls an inner `.App` container (height:100vh; overflow-y:scroll), not the
  // window/body — confirmed via src/App.css. Scroll that element instead, and pace the scroll
  // to the actual content height (federal reps carry long bio/committee lists) so it's readable
  // rather than a fixed duration that either rushes or crawls depending on how much data loaded.
  const { scrollDistance } = await page.evaluate(() => {
    const el = document.querySelector('.App');
    return { scrollDistance: Math.max(0, el.scrollHeight - el.clientHeight) };
  });
  const PX_PER_SEC = 260; // slow enough to read committee/bio text as it passes
  const scrollMs = Math.min(30000, Math.max(5000, (scrollDistance / PX_PER_SEC) * 1000));
  const steps = Math.round(scrollMs / 100);
  const stepDelay = scrollMs / steps;
  console.log(`Scrolling ${scrollDistance}px over ${(scrollMs / 1000).toFixed(1)}s ...`);
  for (let i = 0; i < steps; i++) {
    await page.evaluate((dist) => {
      const el = document.querySelector('.App');
      el.scrollBy(0, dist);
    }, scrollDistance / steps);
    await page.waitForTimeout(stepDelay);
  }

  // Hold on the bottom for a beat before stopping.
  await page.waitForTimeout(1500);

  await context.close();
  await browser.close();

  // Playwright names the video file after an internal id — find the newest .webm in OUT_DIR.
  const webmFiles = fs
    .readdirSync(OUT_DIR)
    .filter((f) => f.endsWith('.webm'))
    .map((f) => ({ f, t: fs.statSync(path.join(OUT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!webmFiles.length) {
    console.error('No webm video was produced.');
    process.exit(1);
  }
  const webmPath = path.join(OUT_DIR, webmFiles[0].f);
  const finalWebm = path.join(OUT_DIR, 'search-result.webm');
  fs.copyFileSync(webmPath, finalWebm);
  console.log(`Saved: ${finalWebm}`);

  // Convert to mp4 (LinkedIn wants mp4). Prefer a full system ffmpeg (has libx264) — Playwright's
  // bundled ffmpeg is a stripped build with only a webm muxer and can't produce mp4 at all.
  let ffmpegBin = null;
  try {
    ffmpegBin = execFileSync('which', ['ffmpeg']).toString().trim() || null;
  } catch {
    ffmpegBin = null;
  }
  if (!ffmpegBin) {
    const cacheRoot = path.join(require('os').homedir(), 'Library', 'Caches', 'ms-playwright');
    if (fs.existsSync(cacheRoot)) {
      const dir = fs.readdirSync(cacheRoot).find((d) => d.startsWith('ffmpeg-'));
      if (dir) {
        const candidate = path.join(cacheRoot, dir, 'ffmpeg-mac-arm64');
        const candidateX64 = path.join(cacheRoot, dir, 'ffmpeg-mac');
        ffmpegBin = fs.existsSync(candidate) ? candidate : (fs.existsSync(candidateX64) ? candidateX64 : null);
      }
    }
  }

  const mp4Path = path.join(OUT_DIR, 'search-result.mp4');
  if (ffmpegBin) {
    console.log(`Converting to mp4 with ${ffmpegBin} ...`);
    execFileSync(ffmpegBin, [
      '-y', '-i', finalWebm,
      '-pix_fmt', 'yuv420p',
      '-vf', 'scale=1440:900',
      '-c:v', 'libx264', '-crf', '20', '-preset', 'medium',
      mp4Path,
    ], { stdio: 'inherit' });
    console.log(`Saved: ${mp4Path}`);
  } else {
    console.log('No bundled ffmpeg found — leaving webm only. Install ffmpeg to convert to mp4.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
