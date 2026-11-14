// Cloud storage for the board (Cloud Firestore), replacing the old ChatGPT
// Sites server API (/api/boards, /api/tasks, /api/job-search).
//
// board.js calls window.Edit1Cloud with the same shapes the old API returned,
// so the board's screens and save logic are unchanged:
//   board(date)                       -> { board, revision, mutationId }
//   board(date, { board, revision, mutationId })   -> { revision }  (409 if someone else saved first)
//   board(date, null, { revisionOnly: true })      -> { revision }
//   tasks() / tasks(payload) / tasks(null, { revisionOnly: true })   (same, for the checklist)
//   search({ q, editor, suite, offset })            -> { results, hasMore, nextOffset }
//   facets()                                        -> { editors: [{ key, name, suites }] }
//
// Data (one copy per stage, so testing on Dev never touches Production):
//   access/members                       { emails: [...] }  who may open the board (edited in the Firebase console)
//   stages/{stage}/boards/{YYYY-MM-DD}   the shared board for that day
//   stages/{stage}/tasks/{uid}           each person's own checklist
// Each saved doc: { payload: JSON text, revision, mutationId, updatedAt, updatedBy }.
// The payload is stored as JSON text so the board's shape can change without
// touching the database rules; the rules check size, revision and who saved.

const STAGE = window.STAGE || 'local';
let fsApi = null;      // { db, fs } once signed in
let user = null;
const live = new Map(); // doc path -> latest revision seen by a live listener (saves reads vs. polling)
const unsubs = new Map();

let resolveAllowed;
const allowed = new Promise((r) => { resolveAllowed = r; });

const fail = (message, status) => Object.assign(new Error(message), { status });
const friendly = (err, what) => {
  if (err?.status) return err;
  if (err?.code === 'permission-denied') return fail("Your Google account isn't on this board's access list.", 403);
  if (err?.code === 'unavailable' || !navigator.onLine) return fail(`Can't reach the ${what} right now (offline?). Your changes are kept on this device; retry when connected.`, 503);
  return fail(`The ${what} is unavailable (${err?.code || err?.message || 'error'}). Please retry.`, 503);
};

const boardRef = (date) => fsApi.fs.doc(fsApi.db, 'stages', STAGE, 'boards', date);
const tasksRef = () => fsApi.fs.doc(fsApi.db, 'stages', STAGE, 'tasks', user.uid);

function watch(ref) {
  if (unsubs.has(ref.path)) return;
  unsubs.set(ref.path, fsApi.fs.onSnapshot(ref, (snap) => {
    if (!snap.metadata.fromCache) live.set(ref.path, snap.exists() ? snap.data().revision : 0);
  }, () => { unsubs.get(ref.path)?.(); unsubs.delete(ref.path); live.delete(ref.path); }));
}
function unwatchBoardsExcept(path) {
  for (const [p, off] of unsubs) if (p.includes('/boards/') && p !== path) { off(); unsubs.delete(p); live.delete(p); }
}

async function readDoc(ref) {
  const snap = await fsApi.fs.getDocFromServer(ref);
  if (!snap.exists()) return { data: null, revision: 0, mutationId: null };
  const d = snap.data();
  return { data: JSON.parse(d.payload), revision: d.revision, mutationId: d.mutationId };
}

// Compare-and-swap save: only succeeds if nobody saved since `revision`.
// A retry of a save that already went through (same mutationId) succeeds.
async function writeDoc(ref, data, revision, mutationId, conflictMessage) {
  const payload = JSON.stringify(data);
  if (payload.length > 900000) throw fail('This is too large to save.', 413);
  return fsApi.fs.runTransaction(fsApi.db, async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists() ? snap.data() : null;
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== revision) {
      if (current?.mutationId === mutationId) return { revision: currentRevision };
      throw fail(conflictMessage, 409);
    }
    tx.set(ref, {
      payload, revision: revision + 1, mutationId,
      updatedAt: fsApi.fs.serverTimestamp(), updatedBy: user.uid,
    });
    return { revision: revision + 1 };
  });
}

async function board(date, payload, options = {}) {
  await allowed;
  const ref = boardRef(date);
  try {
    if (options.revisionOnly) {
      if (live.has(ref.path)) return { revision: live.get(ref.path) };
      return { revision: (await readDoc(ref)).revision };
    }
    if (payload) {
      return await writeDoc(ref, payload.board, payload.revision, payload.mutationId,
        'Someone else changed this board. Your unsaved copy has been kept; load the shared version before editing again.');
    }
    const r = await readDoc(ref);
    unwatchBoardsExcept(ref.path); watch(ref);
    return { board: r.data, revision: r.revision, mutationId: r.mutationId };
  } catch (err) { throw friendly(err, 'shared board'); }
}

async function tasks(payload, options = {}) {
  await allowed;
  const ref = tasksRef();
  try {
    if (options.revisionOnly) {
      if (live.has(ref.path)) return { revision: live.get(ref.path) };
      return { revision: (await readDoc(ref)).revision };
    }
    if (payload) {
      return await writeDoc(ref, payload.tasks, payload.revision, payload.mutationId,
        'Your checklist changed on another device. The latest list will be loaded.');
    }
    const r = await readDoc(ref);
    watch(ref);
    return { tasks: r.data || [], revision: r.revision, mutationId: r.mutationId };
  } catch (err) { throw friendly(err, 'checklist'); }
}

// ---- History search: done in the browser over every saved day (newest first). ----
// Small team, one doc per day: a few hundred reads per search session at most.
let historyCache = null; // { at, rows: [{ date, board }] }
async function allBoards() {
  if (historyCache && Date.now() - historyCache.at < 60000) return historyCache.rows;
  const snap = await fsApi.fs.getDocs(fsApi.fs.collection(fsApi.db, 'stages', STAGE, 'boards'));
  const rows = [];
  snap.forEach((d) => { try { rows.push({ date: d.id, board: JSON.parse(d.data().payload) }); } catch { /* skip unreadable day */ } });
  rows.sort((a, b) => (a.date < b.date ? 1 : -1));
  historyCache = { at: Date.now(), rows };
  return rows;
}

const norm = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const IGNORED = new Set(['', 'unassigned', 'unassigned editor']);

function jobMatchesEditor(job, board, editor) {
  const roster = Array.isArray(board.editors) ? board.editors : [];
  const idIsEditor = (id) => id != null && roster.some((e) => e && e.id === id && norm(e.name) === editor);
  if ([job.completedBy, job.biffedBy, job.parkedFromEditorName].some((n) => norm(n) === editor)) return true;
  if (idIsEditor(job.editorId) || idIsEditor(job.parkedFromEditorId)) return true;
  return (job.history || []).some((h) => h && (norm(h.editorName) === editor || norm(h.previousEditorName) === editor
    || idIsEditor(h.editorId) || idIsEditor(h.previousEditorId)));
}
function jobMatchesSuite(job, suite) {
  if ([job.suite, job.completedSuite, job.biffedSuite, job.parkedFromSuite].some((s) => Number(s) === suite)) return true;
  return (job.history || []).some((h) => h && (Number(h.suite) === suite || Number(h.previousSuite) === suite));
}
// Editor AND suite: the editor must have been in that suite for this job.
function jobMatchesPair(job, board, editor, suite) {
  const roster = Array.isArray(board.editors) ? board.editors : [];
  const nameFor = (id) => roster.find((e) => e && e.id === id)?.name;
  const is = (name, id) => norm(name) === editor || norm(nameFor(id)) === editor;
  const at = (s) => Number(s) === suite;
  if (at(job.suite) && is(null, job.editorId)) return true;
  if (at(job.completedSuite) && is(job.completedBy, job.editorId)) return true;
  if (at(job.biffedSuite) && is(job.biffedBy, job.editorId)) return true;
  if (at(job.parkedFromSuite) && is(job.parkedFromEditorName, job.parkedFromEditorId)) return true;
  return (job.history || []).some((h) => h && (
    (at(h.suite) && (is(h.editorName, h.editorId) || (h.type === 'unassigned' && is(h.previousEditorName, h.previousEditorId))))
    || (at(h.previousSuite) && is(h.previousEditorName, h.previousEditorId))));
}

async function search({ q = '', editor = '', suite = 0, offset = 0 } = {}) {
  await allowed;
  try {
    const query = norm(q); const ed = norm(editor); const st = Number(suite) || 0;
    const matches = [];
    for (const { date, board: b } of await allBoards()) {
      const jobs = Array.isArray(b.jobs) ? b.jobs : [];
      for (let i = jobs.length - 1; i >= 0; i--) {
        const job = jobs[i];
        if (!job || typeof job.title !== 'string') continue;
        if (query && !job.title.toLowerCase().includes(query)) continue;
        if (ed && !jobMatchesEditor(job, b, ed)) continue;
        if (st && !jobMatchesSuite(job, st)) continue;
        if (ed && st && !jobMatchesPair(job, b, ed, st)) continue;
        matches.push({ date, job, editors: b.editors || [] });
      }
    }
    const pageSize = 40;
    const results = matches.slice(offset, offset + pageSize);
    return { results, hasMore: matches.length > offset + pageSize, nextOffset: offset + results.length };
  } catch (err) { throw friendly(err, 'job history'); }
}

// Editors (and the suites each has worked in) for the search filters.
async function facets() {
  await allowed;
  try {
    const options = new Map();
    const add = (name, suiteValue) => {
      if (typeof name !== 'string') return;
      const key = norm(name);
      if (IGNORED.has(key)) return;
      if (!options.has(key)) options.set(key, { key, name: name.trim(), suites: new Set() });
      const s = Number(suiteValue);
      if (Number.isInteger(s) && s >= 1 && s <= 11) options.get(key).suites.add(s);
    };
    for (const { board: b } of await allBoards()) {
      const roster = Array.isArray(b.editors) ? b.editors.filter(Boolean) : [];
      const nameFor = (id) => roster.find((e) => e.id === id)?.name;
      roster.forEach((e) => add(e.name));
      for (const [s, id] of Object.entries(b.suites || {})) add(nameFor(id), s);
      for (const job of b.jobs || []) {
        if (!job) continue;
        add(job.completedBy); add(job.biffedBy); add(job.parkedFromEditorName);
        add(nameFor(job.editorId), job.suite);
        add(job.completedBy || nameFor(job.editorId), job.completedSuite);
        add(job.biffedBy || nameFor(job.editorId), job.biffedSuite);
        add(job.parkedFromEditorName || nameFor(job.parkedFromEditorId), job.parkedFromSuite);
        for (const h of job.history || []) {
          if (!h) continue;
          add(h.editorName || nameFor(h.editorId), h.suite);
          add(h.previousEditorName || nameFor(h.previousEditorId), h.previousSuite);
          if (h.type === 'unassigned') add(h.previousEditorName || nameFor(h.previousEditorId), h.suite);
        }
      }
    }
    const editors = [...options.values()].map((o) => ({ key: o.key, name: o.name, suites: [...o.suites].sort((a, b) => a - b) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
    return { editors };
  } catch (err) { throw friendly(err, 'job history'); }
}

window.Edit1Cloud = { board, tasks, search, facets, allowed };

// ---- Sign-in gate ----------------------------------------------------------
// The board stays behind a full-screen panel until someone on the access
// list is signed in. account.js handles the Google sign-in itself.
const gate = document.getElementById('gate');
const gateText = document.getElementById('gate-text');
const showGate = (text, { signIn = false, signOut = false } = {}) => {
  gateText.textContent = text;
  document.getElementById('sign-in').hidden = !signIn;
  document.getElementById('gate-sign-out').hidden = !signOut;
  gate.hidden = false;
};
document.getElementById('gate-sign-out').addEventListener('click', () => document.getElementById('sign-out').click());

let started = false;
(async () => {
  const ready = await window.AppAccount.ready;
  if (!ready) { showGate("Sign-in isn't available right now. Check your connection and reload."); return; }
  fsApi = ready;
  window.addEventListener('account:change', async (e) => {
    const u = e.detail.user;
    if (!u) {
      if (started) { location.reload(); return; }
      showGate('Sign in with your Google account to open the board.', { signIn: true });
      return;
    }
    user = u;
    showGate('Checking access…');
    try {
      await fsApi.fs.getDocFromServer(fsApi.fs.doc(fsApi.db, 'access', 'members'));
    } catch (err) {
      showGate(err?.code === 'permission-denied'
        ? `${u.email} isn't on this board's access list. Ask the board's owner to add you, then reload.`
        : "Couldn't check access (offline?). Reload to try again.", { signOut: true });
      return;
    }
    gate.hidden = true;
    started = true;
    resolveAllowed();
  });
  if (!window.AppAccount.user) showGate('Sign in with your Google account to open the board.', { signIn: true });
})();
