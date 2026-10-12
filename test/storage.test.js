import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { applyAction, createGame } from '../src/domain.js';
import {
  CURRENT_KEY, DB_NAME, LEGACY_KEY, MAX_ARCHIVES, MAX_IMPORT_BYTES, STORE_NAME,
  LedgerStore, createEnvelope, exportEnvelope, parseImport, validateEnvelope,
} from '../src/storage.js';

function memoryStorage(values = {}) {
  const data = new Map(Object.entries(values));
  return {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
  };
}

function setup(localStorage = memoryStorage()) {
  const indexedDB = new IDBFactory();
  const options = { indexedDB, localStorage, BroadcastChannel: null };
  const store = new LedgerStore(options);
  return { store, options, indexedDB, localStorage };
}

const added = game => applyAction(game, { type: 'add', ownerId: 'p1', name: 'خیابان نمونه', price: 200 });
const renamed = (envelope, name) => ({ ...envelope, game: applyAction(envelope.game, { type: 'rename', ownerId: 'p1', name }) });

async function rawTransaction(indexedDB, action, mode = 'readonly') {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const request = action(tx.objectStore(STORE_NAME));
      let result;
      request.onsuccess = () => { result = request.result; };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(tx.error ?? request.error);
    });
  } finally { db.close(); }
}

test('a committed snapshot, undo, archive and ownership reopen in another store', async () => {
  const { store, options } = setup();
  try {
    const initial = await store.init();
    let game = added(initial.game);
    game = applyAction(game, { type: 'lap', ownerId: 'p1' });
    game = applyAction(game, { type: 'transfer', cardId: game.cards[0].id, ownerId: 'p2' });
    game = applyAction(game, { type: 'settle', cardId: game.cards[0].id });
    const candidate = { ...initial, game, undo: [{ label: 'ثبت کارت', game: initial.game }], archives: [createGame(['قدیمی'])] };
    const saved = await store.save(candidate, 0);
    assert.equal(saved.revision, 1);
    assert.equal(saved.game.cards[0].settlement.amount, 110);
    store.close();
    const reopened = new LedgerStore(options);
    try {
      assert.deepEqual(await reopened.init(), saved);
      assert.deepEqual(parseImport(exportEnvelope(saved)), saved);
    } finally { reopened.close(); }
  } finally { store.close(); }
});

test('failed write leaves the last healthy snapshot durable and exposes pending recovery data', async () => {
  const { store } = setup();
  const originalPut = IDBObjectStore.prototype.put;
  try {
    const initial = await store.init();
    const candidate = { ...initial, game: added(initial.game) };
    IDBObjectStore.prototype.put = function () { throw new DOMException('Test quota exhausted', 'QuotaExceededError'); };
    await assert.rejects(store.save(candidate, initial.revision), error => error.code === 'QUOTA');
    assert.deepEqual(store.lastGood, initial);
    assert.deepEqual(store.pending, candidate);
    assert.equal(parseImport(exportEnvelope(store.pending)).game.cards.length, 1);
    IDBObjectStore.prototype.put = originalPut;
    const saved = await store.save(store.pending, initial.revision);
    assert.equal(saved.game.cards.length, 1);
    assert.equal(saved.revision, 1);
    assert.equal(store.pending, null);
    assert.deepEqual(await store.reload(), saved);
  } finally {
    IDBObjectStore.prototype.put = originalPut;
    store.close();
  }
});

test('two tabs racing the same revision commit exactly one action; loser must explicitly reload', async () => {
  const { store: first, options } = setup();
  const second = new LedgerStore(options);
  try {
    const [a, b] = await Promise.all([first.init(), second.init()]);
    assert.equal(a.game.id, b.game.id);
    const results = await Promise.allSettled([
      first.save(renamed(a, 'رامین'), 0),
      second.save(renamed(b, 'مینا'), 0),
    ]);
    const winners = results.filter(result => result.status === 'fulfilled');
    const failures = results.filter(result => result.status === 'rejected');
    assert.equal(winners.length, 1);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].reason.code, 'CONFLICT');
    assert.deepEqual(failures[0].reason.latest, winners[0].value);
    const loser = results[0].status === 'rejected' ? first : second;
    assert.equal(loser.lastGood.revision, 0);
    assert.ok(loser.pending);
    assert.deepEqual(await loser.reload(), winners[0].value);
    assert.equal(loser.pending, null);
  } finally { first.close(); second.close(); }
});

test('automatic legacy migration preserves raw text and all statuses once, without overriding newer data', async () => {
  const legacy = JSON.stringify({
    players: ['رامین', '', '', '', '', '', '', ''], seq: 4, compound: true,
    cards: [
      { id: 'old-active', p: 0, name: 'فعال', price: 200, laps: 2, auction: false },
      { id: 'old-grace', p: 0, name: 'فرصت آخر', price: 200, laps: 99, auction: false },
      { id: 'old-paid', p: 1, name: 'تسویه', price: 200, laps: 2, auction: false, paid: 121 },
      { id: 'old-auction', p: 2, name: 'مزایده', price: 150, laps: 9, auction: true },
    ],
  });
  const { store, options, indexedDB, localStorage } = setup(memoryStorage({ [LEGACY_KEY]: legacy }));
  try {
    const migrated = await store.init();
    assert.deepEqual(migrated.game.cards.map(card => card.status), ['active', 'grace', 'settled', 'auction']);
    assert.equal(migrated.game.cards[1].laps, 8);
    assert.equal(migrated.game.cards[1].legacy.rawLaps, 99);
    assert.equal(migrated.game.cards[2].settlement.at, null);
    assert.equal(migrated.legacyRaw, legacy);
    assert.equal(localStorage.getItem(LEGACY_KEY), legacy);
    assert.equal((await rawTransaction(indexedDB, objectStore => objectStore.get('legacy-raw'))).raw, legacy);
    const saved = await store.save(renamed(migrated, 'نام جدید'), 0);
    localStorage.setItem(LEGACY_KEY, '{broken legacy data');
    const other = new LedgerStore(options);
    try {
      assert.deepEqual(await other.init(), saved);
      assert.equal((await other.reload()).game.cards.length, 4);
    } finally { other.close(); }
  } finally { store.close(); }
});

test('legacy simple import keeps its locked model and original raw rounds', () => {
  const legacy = JSON.stringify({ players: Array(8).fill(''), compound: false, seq: 1,
    cards: [{ id: 'flat', p: 7, name: 'قدیمی', price: 200, laps: 500, auction: false }] });
  const result = parseImport(legacy);
  assert.equal(result.game.model, 'legacy-simple');
  assert.equal(result.game.cards[0].laps, 11);
  assert.equal(result.game.cards[0].status, 'grace');
  assert.equal(result.game.cards[0].legacy.rawLaps, 500);
  assert.equal(result.legacyRaw, legacy);
});

test('malformed legacy data does not initialize an empty game or delete the source', async () => {
  const raw = '{broken';
  const { store, indexedDB, localStorage } = setup(memoryStorage({ [LEGACY_KEY]: raw }));
  try {
    await assert.rejects(store.init(), error => error.code === 'INVALID_DATA');
    assert.equal(store.lastGood, null);
    assert.equal(store.readRaw(), raw);
    assert.equal(localStorage.getItem(LEGACY_KEY), raw);
    assert.equal(await rawTransaction(indexedDB, objectStore => objectStore.get(CURRENT_KEY)), undefined);
    const fresh = await store.recover(createEnvelope());
    assert.equal(fresh.revision, 0);
    const records = await rawTransaction(indexedDB, objectStore => objectStore.getAll());
    assert.ok(records.some(record => record.legacyRaw === raw));
    assert.equal(localStorage.getItem(LEGACY_KEY), raw);
  } finally { store.close(); }
});

test('corrupt current data remains untouched until confirmed recovery preserves it separately', async () => {
  const { store, indexedDB } = setup();
  const corrupt = { schemaVersion: 2, revision: 8, game: { cards: [] }, undo: [], archives: [] };
  await rawTransaction(indexedDB, objectStore => objectStore.put(corrupt, CURRENT_KEY), 'readwrite');
  try {
    await assert.rejects(store.init(), error => error.code === 'INVALID_DATA');
    assert.deepEqual(await rawTransaction(indexedDB, objectStore => objectStore.get(CURRENT_KEY)), corrupt);
    assert.deepEqual(JSON.parse(store.readRaw()), corrupt);
    const recovered = await store.recover(createEnvelope());
    const records = await rawTransaction(indexedDB, objectStore => objectStore.getAll());
    assert.ok(records.some(record => JSON.stringify(record.raw) === JSON.stringify(corrupt)));
    assert.deepEqual(await store.reload(), recovered);
  } finally { store.close(); }
});

test('recovery refuses to overwrite a healthy snapshot written after the failed load', async () => {
  const { store, indexedDB } = setup();
  await rawTransaction(indexedDB, objectStore => objectStore.put({ broken: true }, CURRENT_KEY), 'readwrite');
  try {
    await assert.rejects(store.init());
    const healthy = createEnvelope(createGame(['تازه']));
    await rawTransaction(indexedDB, objectStore => objectStore.put(healthy, CURRENT_KEY), 'readwrite');
    await assert.rejects(store.recover(createEnvelope()), error => error.code === 'CONFLICT');
    assert.deepEqual(await rawTransaction(indexedDB, objectStore => objectStore.get(CURRENT_KEY)), healthy);
  } finally { store.close(); }
});

test('import rejects malformed JSON, unknown newer schema, owners, duplicate IDs and unbounded numbers', () => {
  const valid = createEnvelope(added(createGame()));
  assert.throws(() => parseImport('{'), error => error.code === 'INVALID_DATA');
  assert.throws(() => parseImport(JSON.stringify({ ...valid, schemaVersion: 999 })), error => error.code === 'UNKNOWN_SCHEMA');
  for (const mutate of [
    envelope => { envelope.game.cards[0].ownerId = 'p9'; },
    envelope => { envelope.game.cards.push(structuredClone(envelope.game.cards[0])); },
    envelope => { envelope.game.cards[0].price = 10_000_000_000; },
    envelope => { envelope.game.cards[0].laps = 1_000_000_000; },
    envelope => { envelope.undo = [{ label: 'خراب', game: { ...envelope.game, players: [] } }]; },
    envelope => { envelope.archives = [{ ...envelope.game, cards: [{ ...envelope.game.cards[0], status: 'settled' }] }]; },
  ]) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    assert.throws(() => parseImport(JSON.stringify(invalid)), error => error.code === 'INVALID_DATA');
  }
  assert.throws(() => parseImport(' '.repeat(MAX_IMPORT_BYTES + 1)), /۶۴ مگابایت/);
  assert.throws(() => parseImport(JSON.stringify({ ...valid, game: { ...valid.game, cards: Array(501).fill(valid.game.cards[0]) } })), /کارت/);
});

test('archive and undo limits refuse extra records instead of dropping history', () => {
  const valid = createEnvelope();
  // Repeated IDs across snapshots preserve provenance; IDs within each game remain unique.
  valid.archives = Array(MAX_ARCHIVES).fill(valid.game);
  validateEnvelope(valid);
  valid.archives.push(valid.game);
  assert.throws(() => validateEnvelope(valid), /بایگانی/);
  valid.archives = [];
  valid.undo = Array(51).fill({ label: 'کار', game: valid.game });
  assert.throws(() => validateEnvelope(valid), /تاریخچه/);
});

test('a full 50-action history plus 30 archived 500-card games exports past 5MiB and reimports', () => {
  const game = createGame(Array(8).fill('نام فارسی'));
  const template = added(game).cards[0];
  game.cards = Array.from({ length: 500 }, (_, index) => ({ ...template,
    id: `fixture-card-${index}`, name: 'خیابان طولانی برای آزمایش سابقه و بازیابی'.repeat(2) }));
  const envelope = createEnvelope(game);
  envelope.undo = Array.from({ length: 50 }, () => ({ label: 'اقدام آزمایشی', game }));
  envelope.archives = Array(30).fill(game);
  const exported = exportEnvelope(envelope);
  const size = new TextEncoder().encode(exported).byteLength;
  assert.ok(size > 5 * 1024 * 1024);
  assert.ok(size < MAX_IMPORT_BYTES);
  const imported = parseImport(exported);
  assert.equal(imported.undo.length, 50);
  assert.equal(imported.archives.length, 30);
  assert.equal(imported.game.cards.length, 500);
  assert.deepEqual(imported.game, game);
});

test('unavailable browser storage fails clearly without fabricating a saved game', async () => {
  const store = new LedgerStore({ indexedDB: { open() { throw new DOMException('denied', 'SecurityError'); } }, localStorage: null, BroadcastChannel: null });
  try {
    await assert.rejects(store.init(), error => error.code === 'STORAGE');
    assert.equal(store.lastGood, null);
    assert.equal(store.readRaw(), null);
  } finally { store.close(); }
});
