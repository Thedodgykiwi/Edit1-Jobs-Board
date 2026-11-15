// End-to-end check of the board's main features (issue #21).
// Run from the repo root:   npm run test:board
// It starts throwaway Firebase emulators (project demo-edit1, never the real
// one), serves this folder, seeds a sample day, signs in with the emulator's
// fake Google account and drives the board in a headless browser.
//
// Needs Playwright with Chromium. Claude's cloud sessions have it already;
// elsewhere: npm i -g playwright && npx playwright install chromium
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  ({ chromium } = await import(`${process.env.NODE_PATH || '/usr/local/lib/node_modules'}/playwright/index.js`));
}

const ROOT = normalize(join(import.meta.dirname, '..'));
const PORT = 8090;
const FS = 'http://127.0.0.1:8081/v1/projects/demo-edit1/databases/(default)/documents';
const TODAY = new Date().toISOString().slice(0, 10);   // the board uses the browser's date; tests run in UTC

// ---- static server for the app ------------------------------------------------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = normalize(join(ROOT, path.endsWith('/') ? path + 'index.html' : path));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try { const body = await readFile(file); res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(body); }
  catch { res.writeHead(404).end(); }
}).listen(PORT);

// ---- sample day ------------------------------------------------------------------
async function seed() {
  const t = (h, m) => `${TODAY}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
  const eds = [['ed-shift-lead', 'Brendan Gibbons', 'BG'], ['ed-ps', 'Priya Shah', 'PS'], ['ed-th', 'Tom Hart', 'TH'], ['ed-jk', 'Joe King', 'JK']];
  const job = (id, title, status, extra = {}) => ({ id, title, workType: 'On the day', type: 'Package', priority: 'standard', due: '', editorId: null, contact: '', note: '', createdAt: t(8, 0), status, history: [{ type: 'created', at: t(8, 0) }], ...extra });
  const board = {
    version: 12, date: TODAY, daySheet: { html: '' },
    editors: eds.map(([id, name, initials]) => ({ id, name, initials, onBreak: false })),
    suites: { ...Object.fromEntries([...Array(11)].map((_, i) => [String(i + 1), null])), 1: 'ed-shift-lead', 2: 'ed-ps', 3: 'ed-th', 5: 'ed-jk' },
    suiteModes: Object.fromEntries([...Array(11)].map((_, i) => [String(i + 1), 'unused'])),
    jobs: [
      job('j1', 'Chancellor interview highlights', 'active', { editorId: 'ed-shift-lead', suite: 1, startedAt: '09:40' }),
      job('j2', 'Flood clean-up package', 'active', { editorId: 'ed-ps', suite: 2, startedAt: '09:10' }),
      job('j3', 'Weekend sport round-up', 'active', { editorId: 'ed-jk', suite: 5, startedAt: '10:00' }),
      job('j4', 'Weather promo', 'planned'),
    ],
  };
  const put = (path, fields) => fetch(`${FS}/${path}`, { method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
  await put('access/members', { emails: { arrayValue: { values: [{ stringValue: 'tester@example.com' }] } } });
  await put(`stages/local/boards/${TODAY}`, { payload: { stringValue: JSON.stringify(board) }, revision: { integerValue: '1' }, mutationId: { stringValue: 'seed' }, updatedAt: { timestampValue: t(8, 0) }, updatedBy: { stringValue: 'seed' } });
}

// ---- checks ----------------------------------------------------------------------
let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('PASS', name); } catch (e) { fail++; console.log('FAIL', name, '·', e.message.split('\n')[0]); }
}
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };

await seed();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route('**/firebase-config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: "window.FIREBASE_CONFIG={apiKey:'demo-key',authDomain:'demo-edit1.firebaseapp.com',projectId:'demo-edit1',appId:'1:1:web:1'};" }));
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/404|releases\.json/.test(m.text())) errors.push(m.text()); });

const p = page;
const upToDate = () => p.waitForFunction(() => /up to date|saved/i.test(document.getElementById('syncText').textContent), null, { timeout: 30000 });
const where = (title) => p.evaluate((t) => {
  const card = [...document.querySelectorAll('.suite-card')].find((c) => c.textContent.includes(t));
  if (card) return card.querySelector('.active-job')?.textContent.includes(t) ? 'running' : 'coming up';
  for (const [id, name] of [['plannedJobs', 'job queue'], ['completedJobs', 'completed'], ['biffedJobs', 'biffed']]) if (document.getElementById(id).textContent.includes(t)) return name;
  return 'missing';
}, title);
const suite = (editor) => p.locator('.suite-card', { hasText: editor }).first();
// Undo must offer the action just taken (not an older one still on screen).
const undo = async (title, verb) => {
  await p.waitForSelector('.undo-bar:not([hidden])', { timeout: 5000 });
  const msg = await p.textContent('.undo-message');
  ok(msg.includes(title) && msg.includes(verb), `Undo bar says "${msg}", expected ${title} ${verb}`);
  await p.click('.undo-button'); await p.waitForTimeout(600); await upToDate();
};

await check('sign-in panel shows', async () => {
  await p.goto(`http://localhost:${PORT}/?emulators`);
  await p.waitForSelector('#sign-in:not([hidden])', { timeout: 30000 });
});
await check('signs in and loads the shared board', async () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const [pop] = await Promise.all([ctx.waitForEvent('page'), p.click('#sign-in')]);
    await pop.waitForLoadState(); await pop.getByText('Add new account').click();
    await pop.locator('#email-input').fill('tester@example.com'); await pop.locator('#display-name-input').fill('Test User');
    await pop.locator('#sign-in').click();
    for (let i = 0; i < 45; i++) { await p.waitForTimeout(2000); if (await p.locator('#gate').isHidden()) break; }
    if (await p.locator('#gate').isHidden()) break;
  }
  await upToDate();
  ok(await where('Chancellor interview highlights') === 'running', 'seeded job not running in Edit 1');
});
await check('Job Queue title opens the queue; Cards / List switch works', async () => {
  if (await p.evaluate(() => document.getElementById('poolSection').classList.contains('collapsed'))) await p.click('#poolTitleToggle');
  ok(await p.isVisible('#plannedJobs'), 'queue did not open');
  await p.click('[data-queue-view=list]'); ok(await p.evaluate(() => document.getElementById('plannedJobs').classList.contains('compact-job-cards')), 'list view not applied');
  await p.click('[data-queue-view=cards]');
});
await check('pick an editor, then "Send to Tom" queues the job', async () => {
  const card = p.locator('#plannedJobs article', { hasText: 'Weather promo' });
  ok(await card.locator('[data-push-job]').count() === 0, 'Send button shown before an editor is picked');
  const tom = (await card.locator('select option').allTextContents()).find((o) => o.includes('Tom'));
  await card.locator('select').selectOption({ label: tom }); await p.waitForTimeout(400);
  ok((await card.locator('[data-push-job]').textContent()).trim() === 'Send to Tom', 'button not named after the editor');
  await card.locator('[data-push-job]').click(); await upToDate();
  ok(await where('Weather promo') === 'coming up', 'not in Tom\'s Coming up next');
});
await check('Pause keeps the job on its suite; play resumes it', async () => {
  await suite('Priya Shah').locator('.active-job [data-park-job]').click(); await p.waitForTimeout(500);
  ok(await where('Flood clean-up package') === 'coming up', 'paused job left the suite');
  ok(await suite('Priya Shah').locator('.queued-job .paused-label').count() === 1, 'no Paused label');
  await suite('Priya Shah').locator('.queued-job [data-start-queued]').click(); await p.waitForTimeout(500);
  ok(await where('Flood clean-up package') === 'running', 'did not resume');
});
await check('Complete, then Undo puts the job back', async () => {
  await suite('Joe King').locator('.active-job [data-complete-job]').click(); await p.waitForTimeout(500);
  ok(await where('Weekend sport round-up') === 'completed', 'not completed');
  await undo('Weekend sport round-up', 'signed off'); ok(await where('Weekend sport round-up') === 'running', 'Undo did not restore');
});
await check('Biff happens straight away, then Undo puts it back', async () => {
  await suite('Joe King').locator('.active-job [data-biff-job]').click(); await p.waitForTimeout(500);
  ok(!(await p.evaluate(() => document.getElementById('biffDialog').open)), 'Biff asked a question with confirm off');
  ok(await where('Weekend sport round-up') === 'biffed', 'not biffed');
  await undo('Weekend sport round-up', 'biffed'); ok(await where('Weekend sport round-up') === 'running', 'Undo did not restore');
});
await check('Return sends a waiting job back to the Job Queue', async () => {
  await suite('Tom Hart').locator('.queued-job', { hasText: 'Weather promo' }).locator('[data-unqueue-job]').click(); await p.waitForTimeout(500);
  ok(await where('Weather promo') === 'job queue', 'not back in the Job Queue');
});
await check('Editors & suites arrow collapses and reopens the suites', async () => {
  await p.click('#suitesCollapseToggle'); ok(await p.isHidden('#suiteGrid'), 'suites still showing');
  await p.click('#suitesCollapseToggle'); ok(await p.isVisible('#suiteGrid'), 'suites did not reopen');
});
await check('profile menu: theme switch and Board settings', async () => {
  await p.click('#profileButton'); await p.click('[data-theme-choice=Dark]');
  ok(await p.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'theme not dark');
  await p.click('[data-theme-choice=Light]'); await p.click('#profileSettings');
  ok(await p.evaluate(() => document.getElementById('settingsDialog').open), 'Board settings did not open');
  await p.keyboard.press('Escape');
});
await check('changes are still there after a reload', async () => {
  await p.reload(); await upToDate();
  ok(await where('Weather promo') === 'job queue', 'Weather promo moved');
  ok(await where('Weekend sport round-up') === 'running', 'undone job not running');
  ok(await where('Flood clean-up package') === 'running', 'resumed job not running');
});
await check('phone width: nothing scrolls sideways', async () => {
  await p.setViewportSize({ width: 375, height: 800 }); await p.waitForTimeout(400);
  ok(!(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'page wider than the phone');
});
await check('no errors in the browser console', async () => { ok(!errors.length, errors.join(' | ')); });

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
