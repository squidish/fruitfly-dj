/**
 * Browser smoke test.
 *
 * Builds nothing and mocks nothing: it drives the real page in headless
 * Chromium, so the AudioWorklet, the MessagePort hand-off, the worker and the
 * clock alignment are all exercised as shipped.
 *
 *   npx tsx scripts/smoke.ts [url]
 */

import { existsSync } from 'node:fs';
import { chromium, type ConsoleMessage, type Request } from 'playwright';

const URL_ = process.argv[2] ?? 'http://localhost:4173/';
const SAME_ORIGIN = new URL(URL_).origin;

interface Probe {
  approval: number;
  selectivity: number;
  spikes: number;
  calibrated: boolean;
  status: string;
  behaviour: string;
  contextState: string;
  contextTime: number;
  outputTime: number;
}

async function main(): Promise<void> {
  // This environment ships a pinned Chromium that may not match the installed
  // Playwright's expected build, and hard rule 1 means nothing gets downloaded.
  const executablePath = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    executablePath: existsSync(executablePath) ? executablePath : undefined,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--mute-audio',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const errors: string[] = [];
  const foreign: string[] = [];
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('request', (req: Request) => {
    if (!req.url().startsWith(SAME_ORIGIN) && !req.url().startsWith('data:') && !req.url().startsWith('blob:')) {
      foreign.push(req.url());
    }
  });

  // tsx transpiles this file with esbuild's keepNames, which emits __name()
  // wrappers. Those travel into page.evaluate bodies, where the helper does
  // not exist, so it is stubbed in the page before anything runs.
  await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f);' });

  console.log(`loading ${URL_}`);
  await page.goto(URL_, { waitUntil: 'networkidle' });

  await page.getByRole('button', { name: 'Wake the fly' }).click();
  await page.waitForTimeout(1500);

  const read = async (): Promise<Probe> =>
    page.evaluate(() => {
      const text = (id: string) => document.getElementById(id)?.textContent?.trim() ?? '';
      return {
        approval: Number(text('gauge-value')) || 0,
        selectivity: 0,
        spikes: 0,
        calibrated: document.getElementById('calib-badge')?.hidden !== false,
        status: text('status-line'),
        behaviour: text('behaviour-line'),
        contextState: 'n/a',
        contextTime: 0,
        outputTime: 0,
      } as Probe;
    });

  /**
   * Peak approval over a few seconds.
   *
   * Approval is a smoothed live value and every preset delivers its pulses in
   * trains with gaps, so a single instantaneous read samples whatever phase of
   * the cycle it happens to land in -- the same preset measured 0.58 and 0.96
   * on consecutive runs. The peak over a window is what "does the fly get into
   * this" actually means.
   */
  const readPeak = async (seconds: number): Promise<Probe> => {
    let best = await read();
    const until = Date.now() + seconds * 1000;
    while (Date.now() < until) {
      await page.waitForTimeout(400);
      const next = await read();
      if (next.approval > best.approval) best = next;
    }
    return best;
  };

  const setPreset = async (preset: string) => {
    await page.selectOption('#ctl-preset', preset);
    await page.waitForTimeout(400);
  };

  const fail: string[] = [];
  const ok: string[] = [];

  // --- badges and circuit -------------------------------------------------
  const badge = (await page.textContent('#circuit-badge'))?.trim() ?? '';
  if (/neurons/.test(badge)) ok.push(`circuit loaded: ${badge}`);
  else fail.push(`circuit badge never resolved (got "${badge}")`);

  // --- the joke -----------------------------------------------------------
  await setPreset('fourOnTheFloor');
  await page.waitForTimeout(4000);
  const edm = await readPeak(3);
  ok.push(`Four on the Floor: A=${edm.approval.toFixed(3)} — "${edm.status}"`);

  await setPreset('courtshipRiddim');
  await page.waitForTimeout(5000);
  const riddim = await readPeak(4);
  ok.push(`Courtship Riddim:  A=${riddim.approval.toFixed(3)} — "${riddim.status}"`);

  if (riddim.approval > Math.max(0.3, edm.approval * 3)) {
    ok.push(`the joke lands in the browser: ${riddim.approval.toFixed(2)} vs ${edm.approval.toFixed(2)}`);
  } else {
    fail.push(`courtship approval ${riddim.approval.toFixed(3)} did not clear 3x EDM ${edm.approval.toFixed(3)}`);
  }

  // --- clock --------------------------------------------------------------
  if (/audio latency/.test(riddim.behaviour)) ok.push(`behaviour line live: ${riddim.behaviour}`);
  else fail.push('behaviour line never updated — the render loop may not be receiving frames');

  // --- drum and bass ------------------------------------------------------
  await setPreset('rollers174');
  await page.waitForTimeout(5000);
  const dnb = await readPeak(5);
  ok.push(`Rollers 174:       A=${dnb.approval.toFixed(3)} — "${dnb.status}"`);
  if (dnb.approval > 0.6) ok.push('the fly is into drum and bass');
  else fail.push(`Rollers 174 approval ${dnb.approval.toFixed(3)} did not clear 0.6`);

  // --- auto-fit on Bass Rolls --------------------------------------------
  await setPreset('bassRolls');
  await page.waitForTimeout(4000);
  await page.check('#ctl-autoFit');
  await page.waitForTimeout(9000);
  const k = Number(await page.inputValue('#ctl-k'));
  if (k > 1.5) ok.push(`auto-fit resized the fly to ${k.toFixed(2)}x on Bass Rolls`);
  else fail.push(`auto-fit left fly size at ${k.toFixed(2)}x`);

  // --- compare ------------------------------------------------------------
  // The drawer action is the real path: it runs the compare AND switches the
  // second row to the Compare panel, which is otherwise hidden on desktop.
  await page.getByRole('button', { name: 'Compare wirings' }).click();
  await page.waitForTimeout(4000);
  const compareNote = (await page.textContent('#compare-note'))?.trim() ?? '';
  if (compareNote.length > 40) ok.push(`compare reported: ${compareNote.slice(0, 110)}…`);
  else fail.push(`compare produced no caption (got "${compareNote}")`);

  // --- panels actually painted -------------------------------------------
  const painted = await page.evaluate(() => {
    const out: Record<string, boolean> = {};
    for (const id of ['hear-canvas', 'graph-canvas', 'compare-canvas']) {
      const c = document.getElementById(id) as HTMLCanvasElement | null;
      if (!c) {
        out[id] = false;
        continue;
      }
      const ctx = c.getContext('2d');
      if (!ctx) {
        out[id] = false;
        continue;
      }
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let distinct = 0;
      const seen = new Set<number>();
      for (let i = 0; i < data.length; i += 4 * 97) {
        const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        if (!seen.has(key)) {
          seen.add(key);
          distinct++;
        }
        if (distinct > 6) break;
      }
      out[id] = distinct > 3;
    }
    return out;
  });
  for (const [id, drew] of Object.entries(painted)) {
    if (drew) ok.push(`${id} is painting`);
    else fail.push(`${id} looks blank`);
  }

  // --- URL state round-trip ----------------------------------------------
  const hash = await page.evaluate(() => window.location.hash);
  if (hash.includes('preset=bassRolls')) ok.push(`URL carries state: ${hash.slice(0, 80)}`);
  else fail.push(`URL hash did not capture state (got "${hash}")`);

  // --- about panel --------------------------------------------------------
  await page.click('#about-btn');
  await page.waitForTimeout(400);
  const aboutText = (await page.textContent('#about-body')) ?? '';
  if (aboutText.includes('Modelling assumptions')) ok.push('About renders ASSUMPTIONS.md');
  else fail.push('About panel is missing the assumptions list');
  await page.click('#about-close');

  await page.screenshot({ path: 'smoke-desktop.png', fullPage: false });

  // --- mobile layout ------------------------------------------------------
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(700);
  await page.click('.tab[data-tab="hear"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'smoke-mobile.png', fullPage: false });
  ok.push('mobile layout rendered at 390x844');

  // --- network and console ------------------------------------------------
  if (foreign.length === 0) ok.push('no third-party network requests');
  else fail.push(`third-party requests: ${[...new Set(foreign)].join(', ')}`);

  const realErrors = errors.filter((e) => !/favicon/i.test(e));
  if (realErrors.length === 0) ok.push('no console errors');
  else fail.push(`console errors:\n    ${realErrors.slice(0, 6).join('\n    ')}`);

  await browser.close();

  console.log('\nPASS');
  for (const line of ok) console.log(`  + ${line}`);
  if (fail.length > 0) {
    console.log('\nFAIL');
    for (const line of fail) console.log(`  - ${line}`);
    process.exit(1);
  }
  console.log('\nAll browser checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
