# Edit 1 Job Board

Day-to-day shift board for Edit 1: jobs, suites, editors, tasks and bookings.
Plain HTML/CSS/JS, no build step, hosted on GitHub Pages.

## Playbook

General processes, design patterns and gotchas live in
https://github.com/Thedodgykiwi/app-playbook. Before setting up anything it
covers (new app, stages, deploys, Firebase, icons, design), attach that repo
to the session and read its README and the relevant guide.

**Keep the playbook growing.** Whenever work on this app teaches something
that would help *any* app (a gotcha, a missing or wrong step, a setup
process, a design or wording pattern that worked), update the right guide
in the playbook in the same session, commit it to the playbook's `main`, and
tell the user what was added. App-specific facts stay in this file instead.

## Stages and branches

| Branch    | Stage      | URL                                              |
|-----------|------------|--------------------------------------------------|
| `dev`     | Dev        | https://thedodgykiwi.github.io/Edit1-Jobs-Board/dev/             |
| `alpha`   | Alpha      | https://thedodgykiwi.github.io/Edit1-Jobs-Board/alpha/           |
| `staging` | Staging    | https://thedodgykiwi.github.io/Edit1-Jobs-Board/staging/         |
| `main`    | Production | https://thedodgykiwi.github.io/Edit1-Jobs-Board/                 |

Any push to one of these branches redeploys the site (`.github/workflows/deploy.yml`).

## Rules

- **All new work happens on `dev`.** Start with `git checkout dev && git pull`.
- **Never commit or push directly to `alpha`, `staging` or `main`.** Changes
  reach them only through the `promote` skill, one stage at a time.
- **Production (`main`) needs the user's explicit "yes"** for each release.
- **Rollbacks** (undo the last Production release) only with the promote
  skill's `rollback` command, after the user's "yes" and their reason.
- Hotfixes only when the user asks: branch from `main`, release, merge back into `dev`.

## Issues (bugs, requests, tweaks)

The repo's GitHub Issues are the to-do list (playbook `issues.md`).
**Every request starts with a choice card** (playbook `issues.md`): for any
feature, fix, tweak or idea, show the AskUserQuestion card with "Log it,
build later" / "Log it + mock-up first" / "Build it now", recommended first.
**Every issue uses the playbook's layout** (`issues.md`, "Writing a good issue").
**Every bug reported or change asked for gets an issue, automatically**
(no need to say "log it"): create it with the right label before starting,
commit with `Issue #<n>`. **"Log it" means record only:** create the issue,
don't change code. Fix
later on `dev` with `Issue #<n>` (not "Fixes") in the commit message; the
Production release closes the issue automatically. No client names or private details in
issues (public repo = public issues).

## Concept first (for bigger ideas)

Offered through the choice card ("Log it + mock-up first", recommended for new
features or noticeable changes with more than one reasonable design): a Claude
artifact with 2–3 options, not in the repo. Details: playbook `working-with-the-user.md`.

## Working on a change

1. Make the change on `dev`.
2. Preview: `python3 -m http.server 8080` from the repo root (banner says "LOCAL").
3. Commit with a clear message, push to `dev`, confirm the deploy succeeded.
4. Ask the user to try it on the Dev URL. Promote only when they're happy.

## Working with the user

- Plain English; briefly define technical terms.
- Screenshot visual changes before pushing.
- Ambiguous → make a sensible choice and say so. Ask first for anything hard to undo.
- Report honestly what was and wasn't tested.
- End with status: what changed, committed/pushed, where to see it.
- **Every deploy ends with a link:** the full, clickable address of each stage
  that changed (pushed to Dev or promoted), plus one line on what to look at.

## Quality checklist (before pushing)

- No errors in the browser console.
- Existing features still work: the page loads without errors.
- Works at ~375px wide and on desktop.
- Labelled buttons/inputs, good contrast, keyboard works.
- One feature or fix per commit, clear message.

## Guardrails

- **No secrets or personal data in the repo** (it's public).
- **Ask before adding** libraries, third-party services, tracking/analytics,
  or anything that costs money or needs an account.
- **Don't delete or reset user data** without asking; migrate formats.
- Plain HTML/CSS/JS with no build step unless the user agrees otherwise.
- Never edit `stage.js` by hand for deploys.

## How this app is built

Rebuilt from the original ChatGPT Sites version (export kept in
`reference/edit-1-job-board-source.zip`; its README/MIGRATION notes describe
the original server). The board's screens and logic were **ported as-is**
(plain JavaScript, its own look), and only its storage was swapped for
Firestore. So this app does **not** use the starter's Preact/style kit.

| File | What it is |
|---|---|
| `index.html` | The board's markup + stage banner + sign-in panel |
| `board.js` | The board (original `app.js`): rendering, jobs, suites, editors, checklist, history search UI |
| `board.css` | All styles in one file (issue #24), in three sections that must stay in order: 1. the board's original styles (light/dark theme), 2. the playbook look (issue #1), 3. the page shell (banner, sign-in, profile menu, section headers, suite columns, Undo bar, offline/install/update bars). Restyle in section 2 or 3, not by editing markup. 11 `!important` remain on purpose (font, flat cards, phone header, `[hidden]`): each was checked to be needed |
| `cloud.js` | Firestore storage (`window.Edit1Cloud`) + sign-in gate / access check |
| `pwa.js`, `sw.js` | Works offline, Install app (profile menu + one-time tip), "A new version is ready · Reload" bar. From the playbook starter |
| `whatsnew.js` | Version + "What's new" at the bottom of the profile menu, from the deploy's `releases.json` (ported from the starter's menu.js). The board's old built-in changelog button is hidden |
| `shell.js` | Stage banner, the profile menu (Google photo → theme, Board settings, Sign out), the Job Queue header (issue #3: title opens/closes, Cards / List switch), the Editors & suites header (issue #4: editor-list and Job Queue icons; issue #17: collapse arrow, remembered per device and stage) and the suite-card columns (issue #6: 3 / 2 below 1260px / 1 below 800px). These controls call the board directly through `window.Edit1Board` (setTheme, openSettings, togglePool, toggleEditors, toggleQueueShown, setCompactQueueCards) and follow its `board:ui` event (issue #22); the board's old buttons for them have been removed |
| `account.js`, `firebase-config.js` | Google sign-in (playbook starter) |
| `firestore.rules`, `tests/` | Security rules + tests (`npm install && npm run test:rules`), and a check of the board's main features against the emulators (`npm run test:board`, issue #21; needs Playwright) |

- `board.js` must load **after** `cloud.js` (it's `defer`, cloud.js is a module; both run in order).
- Saves use a **revision number** (compare-and-swap): a save only goes
  through if nobody saved since; otherwise the board shows "Someone else
  changed this board" and keeps the unsaved copy on the device. A live
  listener tells the board's 10-second check about new revisions without
  extra reads.
- History search runs in the browser over all saved days (`cloud.js`
  `search`/`facets`, a port of the old SQL in the reference zip).
- Display settings stay per device (localStorage); unsaved-draft keys are per stage.
- Undo (issue #12): Complete, Pause, Biff and Return show an 8-second Undo bar (board.js `offerUndo`). Undo restores the whole day's board from just before the action, and refuses if the board changed from the cloud in between (`remoteBoardChanges`).
- Offline + install + "new version ready" bar (issue #8): `pwa.js` / `sw.js` from the starter. Offline, `cloud.js` falls back to the copy saved on the device (read-only in practice: saves need a connection), and the board's sync line is hidden behind the offline strip.
- Browser storage is shared by all stages and apps on `thedodgykiwi.github.io`: key it per app and stage.

## Firebase (set up 2026-11-14)

- Project `edit1-jobs-6f37bc`, web app `1:255253263372:web:543f231296af4962f72a29`,
  Firestore `(default)` in **eur3**, Standard, free tier, delete protection on.
- Google sign-in on; authorised domains: localhost, the project's own two, `thedodgykiwi.github.io`.
- Data: `stages/{stage}/boards/{YYYY-MM-DD}` (shared board per day),
  `stages/{stage}/tasks/{uid}` (each person's checklist). Each doc:
  `payload` (JSON text), `revision`, `mutationId`, `updatedAt`, `updatedBy`.
- **Who can use it:** the `access/members` document, field `emails` (array
  of lower-case addresses). Edit it in the Firebase console (Firestore →
  access → members). Never put the addresses in the repo.
- Emulator testing: `npx -y firebase-tools@latest emulators:start --only auth,firestore --project demo-edit1`,
  seed `access/members` in the emulator, serve the repo and open
  `http://localhost:8080/?emulators` with `firebase-config.js` swapped for a
  `demo-edit1` config (Playwright route).
