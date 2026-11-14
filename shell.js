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
  // Only real clicks outside close it (the theme choice clicks the hidden theme button itself).
  document.addEventListener('click', (e) => { if (e.isTrusted && !panel.hidden && !e.target.closest('.profile')) open(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) { open(false); btn.focus(); } });

  // Theme: the board keeps its own theme setting (board.js, behind the hidden
  // #themeButton, which cycles Auto → Light → Dark). Step it to the choice.
  const currentTheme = () => $('themeMode').textContent.trim();
  function syncTheme() {
    panel.querySelectorAll('[data-theme-choice]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeChoice === currentTheme())));
  }
  panel.querySelectorAll('[data-theme-choice]').forEach((b) => b.addEventListener('click', () => {
    for (let i = 0; i < 3 && currentTheme() !== b.dataset.themeChoice; i++) $('themeButton').click();
    syncTheme();
  }));
  $('profileSettings').addEventListener('click', () => { open(false); $('settingsButton').click(); });
  $('sign-out').addEventListener('click', () => open(false));

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
