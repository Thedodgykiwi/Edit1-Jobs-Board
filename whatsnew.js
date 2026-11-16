// Version + "What's new" at the bottom of the profile menu (issue #2).
// Same as the playbook starter's menu.js: reads releases.json, which the
// shared deploy writes for each stage from the promotions' release notes
// (Dev: recent changes by day). Replaces the board's old built-in changelog.
(function () {
  'use strict';
  const STAGE = window.STAGE || 'local';
  const STAGE_NAMES = { main: 'Production', staging: 'Staging', alpha: 'Alpha', dev: 'Dev', local: 'Local' };
  const $ = (id) => document.getElementById(id);

  // ---- Version + What's new (releases.json, written per stage by the deploy) --
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // "(#12)" at the end of a note = the GitHub issue it relates to: a small pill
  // in that issue's label colour (from releases.json "issues"), not a link.
  function pill(n) {
    const info = data?.issues?.[n] || {};
    const color = /^[0-9a-f]{6}$/i.test(info.color || '') ? info.color : null;
    if (!color) return `<span class="issue-pill" title="Issue #${n}">#${n}</span>`;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(color.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;   // dark or white text, whichever reads better
    const text = (lum + 0.05) / 0.0637 >= 1.05 / (lum + 0.05) ? '#1d1f23' : '#fff';
    const label = info.label ? `${esc(info.label)} ` : '';
    return `<span class="issue-pill" style="background:#${color};color:${text};border-color:transparent" title="Issue #${n}">${label}#${n}</span>`;
  }
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\s*\(#(\d+)\)/g, (m, n) => `&nbsp;${pill(n)}`);
  function markdown(src) {  // ## / ### headings, "- " bullets, paragraphs, **bold**
    const out = []; let list = null, para = null;
    const flush = () => {
      if (para) { out.push(`<p>${inline(para.join(' '))}</p>`); para = null; }
      if (list) { out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`); list = null; }
    };
    for (const raw of src.split('\n')) {
      const line = raw.trimEnd(), h = line.match(/^(#{2,3})\s+(.*)/);
      if (h) { flush(); out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`); }
      else if (/^\s*[-*]\s+/.test(line)) { if (para) flush(); (list ||= []).push(line.replace(/^\s*[-*]\s+/, '')); }
      else if (!line.trim()) flush();
      else if (list && /^\s+/.test(raw)) list[list.length - 1] += ' ' + line.trim();
      else { if (list) flush(); (para ||= []).push(line.trim()); }
    }
    flush();
    return out.join('');
  }
  const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  let data = null;
  const loaded = fetch('releases.json', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null)
    .then((d) => { data = d; showVersion(); });

  function showVersion() {
    const latest = data?.releases?.[0], recent = data?.recent?.[0];
    let label = 'Local copy';
    if (latest?.version) label = `Version ${latest.version.replace(/^v/, '')}`;
    else if (latest) label = `${STAGE_NAMES[STAGE] || STAGE} · ${latest.sha}`;
    else if (recent) label = `${STAGE_NAMES[STAGE] || STAGE} build ${recent.sha}`;
    else if (data) label = STAGE_NAMES[STAGE] || STAGE;
    $('version-btn').textContent = `${label} · What's new`;
  }
  showVersion();

  // Older notes fold away: the newest release (or Dev's newest day) stays open;
  // the rest sit under centred dividers (Last 7 days / Last 30 days / Older),
  // closed until tapped. Open ones are remembered per app and stage.
  const RANGES = [['week', 'Last 7 days', 7], ['month', 'Last 30 days', 30], ['older', 'Older', Infinity]];
  const OPEN_KEY = `whats-new-open:${location.pathname.split('/')[1] || 'app'}:${STAGE}`;
  const openRanges = () => { try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || '[]')); } catch { return new Set(); } };
  function folded(groups, dateOf, draw, countWord) {
    if (!groups.length) return '';
    const [latest, ...rest] = groups;
    const now = Date.now(), open = openRanges();
    const age = (g) => (now - new Date(dateOf(g)).getTime()) / 864e5;
    const sections = RANGES.map(([key, label, max], i) => {
      const min = i ? RANGES[i - 1][2] : -Infinity;
      const items = rest.filter((g) => age(g) >= min && age(g) < max);
      if (!items.length) return '';
      const isOpen = open.has(key), id = `wn-${key}`;
      return `<h3 class="wn-range"><button type="button" class="done-divider" data-range="${key}" aria-expanded="${isOpen}" aria-controls="${id}">
          <span>${label} · ${items.length} ${countWord(items.length)}</span><span class="chevron" aria-hidden="true">${isOpen ? '▴' : '▾'}</span></button></h3>
        <div id="${id}" ${isOpen ? '' : 'hidden'}>${items.map(draw).join('')}</div>`;
    }).join('');
    return draw(latest) + sections;
  }
  // Tap a divider: open/close it and remember.
  $('whats-new-body').addEventListener('click', (e) => {
    const b = e.target.closest('[data-range]'); if (!b) return;
    const open = openRanges(), key = b.dataset.range, isOpen = !open.has(key);
    isOpen ? open.add(key) : open.delete(key);
    try { localStorage.setItem(OPEN_KEY, JSON.stringify([...open])); } catch { /* storage blocked */ }
    $(b.getAttribute('aria-controls')).hidden = !isOpen;
    b.setAttribute('aria-expanded', isOpen);
    b.querySelector('.chevron').textContent = isOpen ? '▴' : '▾';
  });

  function render() {
    if (!data) return "<p class=\"muted\">Release notes appear here once this version is published to one of the stages. (You're looking at a local copy.)</p>";
    if (data.releases?.length) {
      const draw = (r) => `<article class="release${r.rolled_back ? ' rolled-back' : ''}">
        <p class="release-meta">${day(r.date)}${r.version ? ` · ${esc(r.version)}` : ''}${r.rolled_back ? ' · rolled back' : ''}</p>
        ${markdown(r.notes || '')}</article>`;
      return folded(data.releases, (r) => r.date, draw, (n) => (n === 1 ? 'release' : 'releases'));
    }
    if (data.recent?.length) return recentByDay(data.recent);
    return `<p class="muted">No releases in ${esc(STAGE_NAMES[STAGE] || STAGE)} yet.</p>`;
  }
  // Dev: the latest changes grouped by day, in cards (option C from the mock-up).
  // Each change: an emoji for its type (from its issue's label, else its wording),
  // the issue pill(s) and the time. Proper release notes start at Alpha.
  const TYPE_EMOJI = { feature: '✨', tweak: '🎨', bug: '🐛', performance: '⚡' };
  function changeType(c) {
    const label = (c.issues || []).map((n) => data.issues?.[n]?.label).find((l) => TYPE_EMOJI[l]);
    return label || (/^fix\b/i.test(c.title) ? 'bug' : 'scenes');
  }
  function recentByDay(list) {
    const dayKey = (d) => new Date(d).toDateString();
    const today = new Date(), yesterday = new Date(Date.now() - 864e5);
    const dayName = (d) => (dayKey(d) === today.toDateString() ? 'Today'
      : dayKey(d) === yesterday.toDateString() ? 'Yesterday'
      : new Date(d).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' }));
    const time = (d) => new Date(d).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const days = [];
    for (const c of list) {
      const k = dayKey(c.date);
      if (!days.length || days[days.length - 1].k !== k) days.push({ k, name: dayName(c.date), items: [] });
      days[days.length - 1].items.push(c);
    }
    const row = (c) => {
      const type = changeType(c);
      const title = esc(c.title.replace(/^fix:\s*(.)/i, (m, a) => a.toUpperCase()));
      const pills = (c.issues || []).map((n) => `&nbsp;${pill(n)}`).join('');
      return `<li><span class="change-emoji" aria-hidden="true">${TYPE_EMOJI[type] || '🧰'}</span>
        <span class="grow">${title}${pills}</span><span class="change-time">${time(c.date)}</span></li>`;
    };
    const drawDay = (d) => `
        <div class="day-head"><strong>${esc(d.name)}</strong><span class="muted">${d.items.length} change${d.items.length === 1 ? '' : 's'}</span></div>
        <ul class="list changes">${d.items.map(row).join('')}</ul>`;
    return `<p class="muted">🧪 Work in progress on ${esc(STAGE_NAMES[STAGE] || STAGE)}. These get proper release notes when they move on to Alpha.</p>
      ${folded(days, (d) => d.items[0].date, drawDay, (n) => (n === 1 ? 'day' : 'days'))}`;
  }

  $('version-btn').addEventListener('click', async () => {
    $('profileButton').click();   // close the profile menu
    await loaded;
    $('whats-new-body').innerHTML = render();
    $('whats-new').showModal();
  });
  $('whats-new').addEventListener('click', (e) => { if (e.target === $('whats-new') || e.target.closest('[data-close]')) $('whats-new').close(); });
})();
