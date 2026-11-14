// Tests for firestore.rules. Run from the repo root with:  npm run test:rules
// (starts a throwaway Firestore emulator; never touches the real project.)
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc, collection, serverTimestamp, Timestamp, setLogLevel } from 'firebase/firestore';
import { readFileSync } from 'node:fs';

setLogLevel('silent');
const env = await initializeTestEnvironment({
  projectId: 'demo-edit1',
  firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') },
});
await env.clearFirestore();
await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'access', 'members'), { emails: ['alice@example.com', 'bob@example.com'] }));

const ctx = (uid, email, verified = true) => env.authenticatedContext(uid, { email, email_verified: verified }).firestore();
const alice = ctx('alice', 'Alice@Example.com');   // case shouldn't matter
const bob = ctx('bob', 'bob@example.com');
const eve = ctx('eve', 'eve@example.com');          // signed in, not on the list
const unverified = ctx('mal', 'alice@example.com', false);
const anon = env.unauthenticatedContext().firestore();

const save = (uid, revision, extra = {}) => ({ payload: '{"jobs":[]}', revision, mutationId: 'm' + revision, updatedAt: serverTimestamp(), updatedBy: uid, ...extra });
const board = (db, stage = 'dev', date = '2026-11-14') => doc(db, 'stages', stage, 'boards', date);
const tasks = (db, uid, stage = 'dev') => doc(db, 'stages', stage, 'tasks', uid);

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('PASS', name); } catch (e) { fail++; console.log('FAIL', name, e.message); }
}

// Access list
await t('member can read access list', () => assertSucceeds(getDoc(doc(alice, 'access', 'members'))));
await t('non-member cannot read access list', () => assertFails(getDoc(doc(eve, 'access', 'members'))));
await t('member cannot change access list', () => assertFails(setDoc(doc(alice, 'access', 'members'), { emails: ['eve@example.com'] })));

// Shared board
await t('member creates board at revision 1', () => assertSucceeds(setDoc(board(alice), save('alice', 1))));
await t('other member reads shared board', () => assertSucceeds(getDoc(board(bob))));
await t('other member saves next revision', () => assertSucceeds(setDoc(board(bob), save('bob', 2))));
await t('stale revision rejected', () => assertFails(setDoc(board(alice), save('alice', 2))));
await t('skipped revision rejected', () => assertFails(setDoc(board(alice), save('alice', 4))));
await t('create must start at revision 1', () => assertFails(setDoc(board(alice, 'dev', '2026-11-15'), save('alice', 5))));
await t('member lists all days (history search)', () => assertSucceeds(getDocs(collection(alice, 'stages/dev/boards'))));
await t('each valid stage works', async () => { for (const s of ['local', 'alpha', 'staging', 'main']) await assertSucceeds(setDoc(board(alice, s), save('alice', 1))); });
await t('unknown stage rejected', () => assertFails(setDoc(board(alice, 'prod'), save('alice', 1))));
await t('bad date id rejected', () => assertFails(setDoc(board(alice, 'dev', 'today'), save('alice', 1))));
await t('non-member cannot read board', () => assertFails(getDoc(board(eve))));
await t('non-member cannot write board', () => assertFails(setDoc(board(eve, 'dev', '2026-11-16'), save('eve', 1))));
await t('unverified email cannot read', () => assertFails(getDoc(board(unverified))));
await t('signed-out cannot read', () => assertFails(getDoc(board(anon))));
await t('cannot save as someone else', () => assertFails(setDoc(board(alice), save('bob', 3))));
await t('client-chosen time rejected', () => assertFails(setDoc(board(alice), save('alice', 3, { updatedAt: Timestamp.fromMillis(0) }))));
await t('extra field rejected', () => assertFails(setDoc(board(alice), save('alice', 3, { evil: 1 }))));
await t('empty payload rejected', () => assertFails(setDoc(board(alice), save('alice', 3, { payload: '' }))));
await t('non-string payload rejected', () => assertFails(setDoc(board(alice), save('alice', 3, { payload: { jobs: [] } }))));
await t('oversized payload rejected', () => assertFails(setDoc(board(alice), save('alice', 3, { payload: 'x'.repeat(900001) }))));
await t('partial update rejected', () => assertFails(updateDoc(board(alice), { payload: '{}' })));
await t('delete denied', () => assertFails(deleteDoc(board(alice))));

// Personal checklist
await t('member saves own checklist', () => assertSucceeds(setDoc(tasks(alice, 'alice'), save('alice', 1))));
await t('member reads own checklist', () => assertSucceeds(getDoc(tasks(alice, 'alice'))));
await t("member cannot read another's checklist", () => assertFails(getDoc(tasks(bob, 'alice'))));
await t("member cannot write another's checklist", () => assertFails(setDoc(tasks(bob, 'alice'), save('bob', 2))));
await t('non-member cannot keep a checklist', () => assertFails(setDoc(tasks(eve, 'eve'), save('eve', 1))));
await t('other collections denied', () => assertFails(setDoc(doc(alice, 'other', 'x'), { a: 1 })));

console.log(`\n${pass} passed, ${fail} failed`);
await env.cleanup();
process.exit(fail ? 1 : 0);
