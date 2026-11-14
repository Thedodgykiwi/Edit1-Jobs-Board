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
  window.addEventListener('account:change', (e) => {
    document.getElementById('settings-account-email').textContent = e.detail.user?.email || '';
  });
})();
