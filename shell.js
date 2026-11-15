// Edit 1 Job Board: page shell (stage banner, signed-in account in Settings).
// The board itself is board.js; storage and sign-in gate are cloud.js.
//
// The stage this copy is running on: 'local', 'dev', 'alpha', 'staging' or
// 'main' (Production). Set per stage by the deploy (stage.js).
(function () {
  const stage = window.STAGE || 'local';
  // Stage banner on every stage except Production, with a link to the pipeline
  // page (built by the shared deploy at the site root; not on local copies).
  if (stage !== 'main') {
    const banner = document.getElementById('stage-banner');
    document.getElementById('stage-name').textContent = `${stage.toUpperCase()} environment`;
    banner.className = `stage-${stage}`;
    banner.hidden = false;
    if (stage !== 'local') document.getElementById('pipeline-link').hidden = false;
  }

  // ---- Profile menu: Google photo; theme, Settings and Sign out inside ----
  const $ = (id) => document.getElementById(id);
  const btn = $('profileButton');
  const panel = $('profileMenu');
  const open = (on) => {
    panel.hidden = !on;
    btn.setAttribute('aria-expanded', String(on));
    if (on) { syncTheme(); panel.querySelector('[aria-checked="true"]')?.focus(); }
  };
  btn.addEventListener('click', () => open(panel.hidden));
  // Only real clicks outside close it (a programmatic click elsewhere must not; playbook design.md).
  document.addEventListener('click', (e) => { if (e.isTrusted && !panel.hidden && !e.target.closest('.profile')) open(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) { open(false); btn.focus(); } });

  // The board (board.js) offers direct commands as window.Edit1Board and announces
  // its display settings with a "board:ui" event (issue #22). board.js loads after
  // this file, so look the commands up when a control is used.
  const board = () => window.Edit1Board;
  let ui = {};

  // Theme (profile menu)
  function syncTheme() {
    panel.querySelectorAll('[data-theme-choice]').forEach((b) =>
      b.setAttribute('aria-checked', String(b.dataset.themeChoice.toLowerCase() === ui.theme)));
  }
  panel.querySelectorAll('[data-theme-choice]').forEach((b) => b.addEventListener('click', () => board()?.setTheme(b.dataset.themeChoice.toLowerCase())));
  $('profileSettings').addEventListener('click', () => { open(false); board()?.openSettings(); });
  $('sign-out').addEventListener('click', () => open(false));

  // ---- Job Queue header (issue #3): tap the title to open/close; Cards / List switch ----
  const titleToggle = $('poolTitleToggle');
  titleToggle.addEventListener('click', () => board()?.togglePool());
  const pool = $('poolSection');
  pool.querySelectorAll('[data-queue-view]').forEach((b) => b.addEventListener('click', () => board()?.setCompactQueueCards(b.dataset.queueView === 'list')));

  // ---- Editors & suites header (issue #4): editor list + Job Queue as two icon buttons ----
  const edBtn = $('editorsIconButton'), qBtn = $('queueIconButton');
  edBtn.addEventListener('click', () => board()?.toggleEditors());
  qBtn.addEventListener('click', () => board()?.toggleQueueShown());

  // Keep every control in step with the board's settings (also when changed in Board settings or by a shortcut key).
  document.addEventListener('board:ui', (e) => {
    ui = e.detail;
    syncTheme();
    titleToggle.setAttribute('aria-expanded', String(!ui.poolCollapsed));
    pool.querySelectorAll('[data-queue-view]').forEach((b) =>
      b.setAttribute('aria-checked', String((b.dataset.queueView === 'list') === ui.compactQueueCards)));
    edBtn.setAttribute('aria-expanded', String(!ui.editorsCollapsed));
    edBtn.title = `${ui.editorsCollapsed ? 'Show' : 'Hide'} editor list`; edBtn.setAttribute('aria-label', edBtn.title);
    qBtn.setAttribute('aria-pressed', String(!ui.poolHidden));
    qBtn.title = `${ui.poolHidden ? 'Show' : 'Hide'} Job Queue (E)`;
  });

  $('ios-install').addEventListener('click', (e) => { if (e.target === $('ios-install') || e.target.closest('[data-close]')) $('ios-install').close(); });

  // ---- Editors & suites collapse (issue #17): arrow beside the title, remembered per device and stage ----
  const ops = document.querySelector('.operations');
  const suitesToggle = $('suitesCollapseToggle');
  const SUITES_KEY = `edit1:${window.STAGE || 'local'}:suites-collapsed`;
  const setSuites = (collapsed) => {
    ops.classList.toggle('suites-collapsed', collapsed);
    suitesToggle.setAttribute('aria-expanded', String(!collapsed));
    suitesToggle.title = suitesToggle.ariaLabel = collapsed ? 'Show suites' : 'Hide suites';
    suitesToggle.setAttribute('aria-label', suitesToggle.title);
    try { localStorage.setItem(SUITES_KEY, collapsed ? '1' : ''); } catch { /* storage blocked */ }
  };
  suitesToggle.addEventListener('click', () => setSuites(!ops.classList.contains('suites-collapsed')));
  try { setSuites(localStorage.getItem(SUITES_KEY) === '1'); } catch { setSuites(false); }

  window.addEventListener('account:change', (e) => {
    const u = e.detail.user;
    const label = u?.displayName || u?.email || '';
    $('profileName').textContent = u?.displayName || '';
    $('profileEmail').textContent = u?.email || '';
    $('profileLetter').textContent = label.trim().charAt(0).toUpperCase();
    const img = $('profileImg');
    img.hidden = !u?.photoURL; $('profileLetter').hidden = !!u?.photoURL;
    if (u?.photoURL) { img.onerror = () => { img.hidden = true; $('profileLetter').hidden = false; }; img.src = u.photoURL; }
  });
})();
