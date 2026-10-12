import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { applyAction, createGame, hydrateGameHistory } from '../src/domain.js';
import {
  CURRENT_KEY, DB_NAME, LEGACY_KEY, MAX_ARCHIVES, MAX_IMPORT_BYTES, MAX_TOTAL_HISTORY_EVENTS, STORE_NAME,
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
const withoutHistory = game => {
  const old = structuredClone(game);
  for (const card of old.cards) delete card.history;
  return old;
};

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
    id: `fixture-card-${index}`, name: 'خیابان طولانی برای آزمایش سابقه و بازیابی'.repeat(2), history: undefined }));
  const hydrated = hydrateGameHistory(game);
  const envelope = createEnvelope(hydrated);
  envelope.undo = Array.from({ length: 50 }, () => ({ label: 'اقدام آزمایشی', game: hydrated }));
  envelope.archives = Array(30).fill(hydrated);
  const exported = exportEnvelope(envelope);
  const size = new TextEncoder().encode(exported).byteLength;
  assert.ok(size > 5 * 1024 * 1024);
  assert.ok(size < MAX_IMPORT_BYTES);
  const imported = parseImport(exported);
  assert.equal(imported.undo.length, 50);
  assert.equal(imported.archives.length, 30);
  assert.equal(imported.game.cards.length, 500);
  assert.deepEqual(imported.game, hydrated);
});

test('existing schema-2 saves atomically persist honest baselines for current, undo and archives once', async () => {
  const { store, options, indexedDB } = setup();
  const beforeLap = added(createGame(['رامین']));
  const old = {
    schemaVersion: 2, revision: 7,
    game: withoutHistory(applyAction(beforeLap, { type: 'lap', ownerId: 'p1' })),
    undo: [{ label: 'دور قدیمی', game: withoutHistory(beforeLap) }],
    archives: [withoutHistory(added(createGame(['قدیمی'])))],
  };
  await rawTransaction(indexedDB, objectStore => objectStore.put(old, CURRENT_KEY), 'readwrite');
  try {
    const upgraded = await store.init();
    assert.equal(upgraded.schemaVersion, 2);
    assert.equal(upgraded.revision, 8);
    for (const game of [upgraded.game, upgraded.undo[0].game, upgraded.archives[0]]) {
      const [event] = game.cards[0].history;
      assert.equal(game.cards[0].history.length, 1);
      assert.equal(event.type, 'baseline');
      assert.equal(event.at, null);
      assert.equal(event.before, null);
      assert.equal(event.after.laps, game.cards[0].laps);
      assert.equal(event.after.price, game.cards[0].price);
    }
    assert.equal(upgraded.game.cards[0].laps, 1);
    assert.equal(upgraded.undo[0].game.cards[0].laps, 0);
    assert.deepEqual(await rawTransaction(indexedDB, objectStore => objectStore.get(CURRENT_KEY)), upgraded);
    assert.deepEqual(await store.reload(), upgraded);
    assert.deepEqual(parseImport(exportEnvelope(upgraded)), upgraded);
    const reopened = new LedgerStore(options);
    try { assert.deepEqual(await reopened.init(), upgraded); }
    finally { reopened.close(); }
  } finally { store.close(); }
});

test('two simultaneous upgrades commit one revision and reuse the winner baseline IDs', async () => {
  const { store: first, options, indexedDB } = setup();
  const second = new LedgerStore(options);
  const old = { ...createEnvelope(withoutHistory(added(createGame()))), revision: 4 };
  await rawTransaction(indexedDB, objectStore => objectStore.put(old, CURRENT_KEY), 'readwrite');
  try {
    const [a, b] = await Promise.all([first.init(), second.init()]);
    assert.equal(a.revision, 5);
    assert.deepEqual(a, b);
    assert.equal(a.game.cards[0].history.length, 1);
    assert.deepEqual(await rawTransaction(indexedDB, objectStore => objectStore.get(CURRENT_KEY)), a);
  } finally { first.close(); second.close(); }
});

test('an old app action appends one unknown-time gap while a player-name change preserves event-time names', async () => {
  const { store, indexedDB } = setup();
  try {
    const initial = await store.init();
    const game = added(createGame(['رامین']));
    const original = await store.save({ ...initial, game }, initial.revision);
    const oldTab = structuredClone(original);
    oldTab.game.cards[0].laps = 2;
    oldTab.revision += 1;
    await rawTransaction(indexedDB, objectStore => objectStore.put(oldTab, CURRENT_KEY), 'readwrite');
    const upgraded = await store.reload();
    assert.equal(upgraded.revision, oldTab.revision + 1);
    assert.equal(upgraded.game.cards[0].history.length, 2);
    const gap = upgraded.game.cards[0].history.at(-1);
    assert.equal(gap.type, 'baseline');
    assert.equal(gap.at, null);
    assert.equal(gap.before, null);
    assert.equal(gap.after.laps, 2);
    assert.equal(gap.after.debt, 121);
    assert.deepEqual(upgraded.game.cards[0].history[0], original.game.cards[0].history[0]);
    assert.deepEqual(await store.reload(), upgraded);
    assert.deepEqual(parseImport(exportEnvelope(upgraded)), upgraded);

    const renamedOldTab = structuredClone(upgraded);
    renamedOldTab.game.players[0].name = 'نام تازه';
    renamedOldTab.revision += 1;
    renamedOldTab.ignoredEnvelopeMetadata = 'preserve on disk without an upgrade';
    await rawTransaction(indexedDB, objectStore => objectStore.put(renamedOldTab, CURRENT_KEY), 'readwrite');
    const reloaded = await store.reload();
    assert.equal(reloaded.revision, renamedOldTab.revision);
    assert.equal(reloaded.game.cards[0].history.length, 2);
    assert.equal(reloaded.game.cards[0].history.at(-1).after.ownerName, 'رامین');
    assert.equal((await rawTransaction(indexedDB, objectStore => objectStore.get(CURRENT_KEY))).ignoredEnvelopeMetadata,
      renamedOldTab.ignoredEnvelopeMetadata);
  } finally { store.close(); }
});

test('failed additive upgrade leaves the old healthy financial snapshot and exposes pending history', async () => {
  const { store, indexedDB } = setup();
  const old = { ...createEnvelope(withoutHistory(added(createGame()))), revision: 9 };
  await rawTransaction(indexedDB, objectStore => objectStore.put(old, CURRENT_KEY), 'readwrite');
  const originalPut = IDBObjectStore.prototype.put;
  try {
    IDBObjectStore.prototype.put = function () { throw new DOMException('Test quota exhausted', 'QuotaExceededError'); };
    await assert.rejects(store.init(), error => error.code === 'QUOTA');
    assert.equal(store.lastGood, null);
    assert.equal(store.pending.game.cards[0].history[0].type, 'baseline');
    assert.deepEqual(JSON.parse(store.readRaw()), old);
    IDBObjectStore.prototype.put = originalPut;
    assert.deepEqual(await rawTransaction(indexedDB, objectStore => objectStore.get(CURRENT_KEY)), old);
    await assert.rejects(store.recover(createEnvelope()), error => error.code === 'CONFLICT');
    assert.deepEqual(await rawTransaction(indexedDB, objectStore => objectStore.get(CURRENT_KEY)), old);
    const upgraded = await store.reload();
    assert.equal(upgraded.revision, 10);
    assert.equal(upgraded.game.cards[0].laps, 0);
    assert.equal(upgraded.game.cards[0].price, 200);
  } finally { IDBObjectStore.prototype.put = originalPut; store.close(); }
});

test('an edited card and its event remain in pending recovery while failed save preserves the previous price and laps', async () => {
  const { store } = setup();
  const originalPut = IDBObjectStore.prototype.put;
  try {
    const initial = await store.init();
    let game = added(initial.game);
    game = applyAction(applyAction(game, { type: 'lap', ownerId: 'p1' }), { type: 'lap', ownerId: 'p1' });
    const before = await store.save({ ...initial, game }, initial.revision);
    const candidate = { ...before,
      game: applyAction(game, { type: 'editCard', cardId: game.cards[0].id, name: 'نام اصلاح‌شده', price: 201 }),
      undo: [{ label: 'اصلاح کارت', game }],
    };
    IDBObjectStore.prototype.put = function () { throw new DOMException('Test quota exhausted', 'QuotaExceededError'); };
    await assert.rejects(store.save(candidate, before.revision), error => error.code === 'QUOTA');
    assert.deepEqual(store.lastGood, before);
    assert.deepEqual(store.pending, candidate);
    assert.equal(parseImport(exportEnvelope(store.pending)).game.cards[0].history.at(-1).type, 'editCard');
    IDBObjectStore.prototype.put = originalPut;
    assert.deepEqual(await store.reload(), before);
    const saved = await store.save(candidate, before.revision);
    assert.equal(saved.game.cards[0].price, 201);
    assert.equal(saved.game.cards[0].laps, 2);
    assert.equal(saved.game.cards[0].history.at(-1).after.debt, 122);
    const undone = await store.save({ ...saved, game: saved.undo[0].game, undo: [] }, saved.revision);
    assert.equal(undone.game.cards[0].name, 'خیابان نمونه');
    assert.equal(undone.game.cards[0].price, 200);
    assert.equal(undone.game.cards[0].laps, 2);
    assert.equal(undone.game.cards[0].history.at(-1).type, 'lap');
    assert.deepEqual(parseImport(exportEnvelope(undone)), undone);
  } finally { IDBObjectStore.prototype.put = originalPut; store.close(); }
});

test('concurrent edits use the existing revision guard and preserve the winner event log', async () => {
  const { store: first, options } = setup();
  const second = new LedgerStore(options);
  try {
    const initial = await first.init();
    const before = await first.save({ ...initial, game: added(initial.game) }, initial.revision);
    const other = await second.init();
    const edit = (envelope, name, price) => ({ ...envelope,
      game: applyAction(envelope.game, { type: 'editCard', cardId: envelope.game.cards[0].id, name, price }),
      undo: [{ label: 'اصلاح کارت', game: envelope.game }],
    });
    const results = await Promise.allSettled([
      first.save(edit(before, 'الف', 201), before.revision),
      second.save(edit(other, 'ب', 400), other.revision),
    ]);
    const winner = results.find(result => result.status === 'fulfilled').value;
    const loser = results.find(result => result.status === 'rejected').reason;
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(loser.code, 'CONFLICT');
    assert.deepEqual(loser.latest, winner);
    assert.equal(winner.game.cards[0].history.at(-1).type, 'editCard');
    assert.deepEqual(await second.reload(), winner);
  } finally { first.close(); second.close(); }
});

test('history import validates events and bounds the aggregate before traversing event snapshots', () => {
  const valid = createEnvelope(added(createGame()));
  for (const mutate of [
    envelope => { envelope.game.cards[0].history = []; },
    envelope => { envelope.game.cards[0].history = 'not an array'; },
    envelope => { envelope.game.cards[0].history[0].type = 'unknown'; },
    envelope => { envelope.game.cards[0].history[0].at = '2026-02-31T00:00:00.000Z'; },
    envelope => { envelope.game.cards[0].history[0].after.laps = 1_000_000; },
    envelope => { envelope.game.cards[0].history[0].after.debt += 1; },
    envelope => { envelope.game.cards[0].history = Array(501).fill(envelope.game.cards[0].history[0]); },
  ]) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    assert.throws(() => parseImport(JSON.stringify(invalid)), error => error.code === 'INVALID_DATA');
  }
  const event = valid.game.cards[0].history[0];
  const fullGap = structuredClone(valid);
  fullGap.game.cards[0].history = Array.from({ length: 500 }, (_, index) => ({
    id: `full-baseline-${index}`, type: 'baseline', at: null, before: null, after: structuredClone(event.after),
  }));
  fullGap.game.cards[0].laps = 2;
  assert.throws(() => parseImport(JSON.stringify(fullGap)), error => error.code === 'INVALID_DATA');
  const tooLarge = structuredClone(valid);
  tooLarge.game.cards = Array.from({ length: Math.floor(MAX_TOTAL_HISTORY_EVENTS / 500) + 1 }, (_, index) => ({
    ...valid.game.cards[0], id: `bounded-${index}`, history: Array(500).fill(event),
  }));
  // These repeated events are intentionally invalid too: the aggregate count
  // must reject them before per-event validation or rational arithmetic.
  assert.throws(() => validateEnvelope(tooLarge), /مجموع تاریخچه/);
});

test('unavailable browser storage fails clearly without fabricating a saved game', async () => {
  const store = new LedgerStore({ indexedDB: { open() { throw new DOMException('denied', 'SecurityError'); } }, localStorage: null, BroadcastChannel: null });
  try {
    await assert.rejects(store.init(), error => error.code === 'STORAGE');
    assert.equal(store.lastGood, null);
    assert.equal(store.readRaw(), null);
  } finally { store.close(); }
});
