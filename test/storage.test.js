import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { applyAction, calculate, createGame, hydrateGameHistory, SCHEMA_VERSION } from '../src/domain.js';
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

// Genuine schema-2 snapshots never contain rules or exact accrual plans.
const asV2Game = game => {
  const old = structuredClone(game);
  delete old.rules;
  for (const card of old.cards) {
    delete card.accrual;
    for (const event of card.history ?? []) {
      delete event.interest;
      for (const snapshot of [event.before, event.after]) if (snapshot) delete snapshot.accrual;
    }
  }
  return old;
};

const asV2Envelope = envelope => ({ ...structuredClone(envelope), schemaVersion: 2,
  game: asV2Game(envelope.game),
  undo: envelope.undo.map(entry => ({ ...entry, game: asV2Game(entry.game) })),
  archives: envelope.archives.map(asV2Game),
});

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
    game: asV2Game(withoutHistory(applyAction(beforeLap, { type: 'lap', ownerId: 'p1' }))),
    undo: [{ label: 'دور قدیمی', game: asV2Game(withoutHistory(beforeLap)) }],
    archives: [asV2Game(withoutHistory(added(createGame(['قدیمی']))))],
  };
  await rawTransaction(indexedDB, objectStore => objectStore.put(old, CURRENT_KEY), 'readwrite');
  try {
    const upgraded = await store.init();
    assert.equal(upgraded.schemaVersion, SCHEMA_VERSION);
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
  const old = { schemaVersion: 2, revision: 4, game: asV2Game(withoutHistory(added(createGame()))), undo: [], archives: [] };
  await rawTransaction(indexedDB, objectStore => objectStore.put(old, CURRENT_KEY), 'readwrite');
  try {
    const [a, b] = await Promise.all([first.init(), second.init()]);
    assert.equal(a.revision, 5);
    assert.deepEqual(a, b);
    assert.equal(a.game.cards[0].history.length, 1);
    assert.deepEqual(await rawTransaction(indexedDB, objectStore => objectStore.get(CURRENT_KEY)), a);
  } finally { first.close(); second.close(); }
});

test('a genuine old app action appends one unknown-time gap while a player-name change preserves event-time names', async () => {
  const { store, indexedDB } = setup();
  try {
    const initial = await store.init();
    const game = added(createGame(['رامین']));
    const original = await store.save({ ...initial, game }, initial.revision);
    const oldTab = asV2Envelope(original);
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
  const old = { schemaVersion: 2, revision: 9, game: asV2Game(withoutHistory(added(createGame()))), undo: [], archives: [] };
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

test('schema-2 finance, event identities, settlements and all 50 undo snapshots migrate without rewriting the past', async () => {
  const { store, options, indexedDB } = setup();
  let game = createGame(['رامین', 'سارا']);
  for (const [ownerId, name] of [['p1', 'فعال'], ['p2', 'فرصت آخر'], ['p3', 'تسویه'], ['p4', 'مزایده']]) {
    game = applyAction(game, { type: 'add', ownerId, name, price: 200 });
  }
  for (const ownerId of ['p1', 'p3']) for (let i = 0; i < 2; i += 1) game = applyAction(game, { type: 'lap', ownerId });
  for (const ownerId of ['p2', 'p4']) for (let i = 0; i < 8; i += 1) game = applyAction(game, { type: 'lap', ownerId });
  game = applyAction(game, { type: 'settle', cardId: game.cards[2].id });
  game = applyAction(game, { type: 'auction', cardId: game.cards[3].id });
  const old = asV2Envelope({ ...createEnvelope(game), revision: 17,
    undo: Array.from({ length: 50 }, (_, index) => ({ label: `اقدام ${index}`, game })), archives: [game] });
  const before = structuredClone(old);
  await rawTransaction(indexedDB, objectStore => objectStore.put(old, CURRENT_KEY), 'readwrite');
  try {
    const migrated = await store.init();
    assert.equal(migrated.schemaVersion, 3);
    assert.equal(migrated.revision, 18);
    assert.equal(migrated.undo.length, 50);
    assert.deepEqual(migrated.game.cards.map(card => card.status), ['active', 'grace', 'settled', 'auction']);
    for (const snapshot of [migrated.game, ...migrated.undo.map(entry => entry.game), ...migrated.archives]) {
      assert.deepEqual(snapshot.rules, { mode: 'compound', compoundRateBps: 1000, simpleRateBps: 1000, hardcore: false });
      for (const [index, card] of snapshot.cards.entries()) {
        const original = before.game.cards[index];
        assert.equal(card.laps, original.laps);
        assert.equal(card.ownerId, original.ownerId);
        assert.equal(calculate(card).debt, [121, 214, 121, 214][index]);
        assert.deepEqual(card.settlement, original.settlement);
        assert.deepEqual(card.accrual, [{ mode: 'compound', rateBps: 1000, laps: card.laps }]);
        assert.deepEqual(card.history.map(event => [event.id, event.at, event.type]),
          original.history.map(event => [event.id, event.at, event.type]));
        assert.deepEqual(card.history.map(event => event.after.debt), original.history.map(event => event.after.debt));
      }
    }
    assert.deepEqual(parseImport(exportEnvelope(migrated)), migrated);
    const reopened = new LedgerStore(options);
    try { assert.deepEqual(await reopened.init(), migrated); }
    finally { reopened.close(); }
  } finally { store.close(); }
});

test('even an empty schema-2 ledger persists schema-3 once and concurrent loads share that revision', async () => {
  const { store: first, options, indexedDB } = setup();
  const second = new LedgerStore(options);
  const old = asV2Envelope({ ...createEnvelope(), revision: 23, archives: [createGame()] });
  await rawTransaction(indexedDB, objectStore => objectStore.put(old, CURRENT_KEY), 'readwrite');
  try {
    const [a, b] = await Promise.all([first.init(), second.init()]);
    assert.equal(a.schemaVersion, 3);
    assert.equal(a.revision, 24);
    assert.deepEqual(a, b);
    assert.equal(a.game.cards.length, 0);
    assert.equal(a.archives[0].rules.compoundRateBps, 1000);
    assert.deepEqual(await rawTransaction(indexedDB, objectStore => objectStore.get(CURRENT_KEY)), a);
    assert.deepEqual(await first.reload(), a);
  } finally { first.close(); second.close(); }
});

test('variable future rates, modes and hardcore survive save, reload, export, import and undo', async () => {
  const { store } = setup();
  try {
    const initial = await store.init();
    let game = applyAction(added(initial.game), { type: 'lap', ownerId: 'p1' });
    const before = game;
    game = applyAction(game, { type: 'setRules', rules: {
      mode: 'simple', compoundRateBps: 2500, simpleRateBps: 250, hardcore: true,
    } });
    assert.equal(calculate(game.cards[0]).debt, 110);
    const changed = game;
    game = applyAction(game, { type: 'lapAll' });
    assert.equal(calculate(game.cards[0]).debt, 113);
    game = applyAction(game, { type: 'setRules', rules: { ...game.rules, mode: 'compound' } });
    game = applyAction(game, { type: 'lapAll' });
    assert.equal(calculate(game.cards[0]).debt, 141);
    const saved = await store.save({ ...initial, game, undo: [
      { label: 'تغییر قواعد', game: before }, { label: 'دور جمعی', game: changed },
    ], archives: [game] }, initial.revision);
    assert.deepEqual(await store.reload(), saved);
    assert.deepEqual(parseImport(exportEnvelope(saved)), saved);
    assert.deepEqual(saved.game.cards[0].accrual, [
      { mode: 'compound', rateBps: 1000, laps: 1 },
      { mode: 'simple', rateBps: 250, laps: 1 },
      { mode: 'compound', rateBps: 2500, laps: 1 },
    ]);
    const undone = await store.save({ ...saved, game: saved.undo[1].game, undo: saved.undo.slice(0, 1) }, saved.revision);
    assert.equal(calculate(undone.game.cards[0]).debt, 110);
    assert.equal(undone.game.cards[0].laps, 1);
    assert.equal(undone.game.rules.mode, 'simple');
    assert.deepEqual(parseImport(exportEnvelope(undone)), undone);
  } finally { store.close(); }
});

test('schema-3 imports require complete finance plans and history across current, undo and archives', () => {
  let game = applyAction(added(createGame()), { type: 'lap', ownerId: 'p1' });
  game = applyAction(game, { type: 'setRules', rules: { ...game.rules, simpleRateBps: 375, mode: 'simple' } });
  game = applyAction(game, { type: 'lapAll' });
  const valid = { ...createEnvelope(game), undo: [{ label: 'کار', game }], archives: [game] };
  for (const select of [envelope => envelope.game, envelope => envelope.undo[0].game, envelope => envelope.archives[0]]) {
    for (const mutate of [
      snapshot => { delete snapshot.rules; },
      snapshot => { delete snapshot.cards[0].accrual; },
      snapshot => { delete snapshot.cards[0].history; },
      snapshot => { delete snapshot.cards[0].history[0].after.accrual; },
      snapshot => { delete snapshot.cards[0].history[1].before.accrual; },
      snapshot => { snapshot.cards[0].accrual[0].rateBps = 10_001; },
      snapshot => { snapshot.cards[0].accrual[0].laps = 1_000_000_000; },
      snapshot => { snapshot.cards[0].history[0].after.accrual = Array(501).fill({ mode: 'compound', rateBps: 0, laps: 1 }); },
      snapshot => { snapshot.cards[0].accrual.push({ ...snapshot.cards[0].accrual.at(-1) }); },
    ]) {
      const invalid = structuredClone(valid);
      mutate(select(invalid));
      assert.throws(() => parseImport(JSON.stringify(invalid)), error => error.code === 'INVALID_DATA');
    }
  }
  const gap = structuredClone(valid);
  gap.game.cards[0].name = 'تغییر ثبت‌نشده';
  assert.throws(() => parseImport(JSON.stringify(gap)), error => error.code === 'INVALID_DATA');
});

test('genuine schema-2 imports reject injected new financial fields instead of laundering mixed plans', () => {
  const source = applyAction(added(createGame()), { type: 'lap', ownerId: 'p1' });
  const old = asV2Envelope(createEnvelope(source));
  assert.equal(parseImport(JSON.stringify(old)).schemaVersion, 3);
  for (const mutate of [
    envelope => { envelope.game.rules = source.rules; },
    envelope => { envelope.game.cards[0].accrual = source.cards[0].accrual; },
    envelope => { envelope.game.cards[0].history[0].after.accrual = []; },
    envelope => { envelope.game.cards[0].history[1].before.accrual = []; },
    envelope => { envelope.game.cards[0].history[1].interest = { mode: 'compound', rateBps: 1000 }; },
    envelope => { envelope.game.cards[0].history[1].rulesBefore = source.rules; },
    envelope => { envelope.game.cards[0].history[1].type = 'lapAll'; },
    envelope => { envelope.game.cards[0].interestStopLap = 1; },
    envelope => { envelope.game.cards[0].history[0].after.interestStopLap = 1; },
    envelope => { envelope.game.cards[0].history[1].before.interestStopLap = 1; },
    envelope => { envelope.game.cards[0].history[1].type = 'rulesReapplied'; },
  ]) {
    const invalid = structuredClone(old);
    mutate(invalid);
    assert.throws(() => parseImport(JSON.stringify(invalid)), error => error.code === 'INVALID_DATA');
  }
});

test('a failed collective save keeps every old balance durable and retries the same whole action once', async () => {
  const { store, indexedDB } = setup();
  const originalPut = IDBObjectStore.prototype.put;
  try {
    const initial = await store.init();
    let game = added(initial.game);
    game = applyAction(game, { type: 'add', ownerId: 'p2', name: 'کارت دوم', price: 400 });
    const before = await store.save({ ...initial, game }, initial.revision);
    const candidate = { ...before, game: applyAction(game, { type: 'lapAll' }),
      undo: [{ label: 'یک دور برای همه', game }] };
    IDBObjectStore.prototype.put = function () { throw new DOMException('Test quota exhausted', 'QuotaExceededError'); };
    await assert.rejects(store.save(candidate, before.revision), error => error.code === 'QUOTA');
    assert.deepEqual(store.lastGood, before);
    assert.deepEqual(store.pending, candidate);
    IDBObjectStore.prototype.put = originalPut;
    assert.deepEqual(await rawTransaction(indexedDB, objectStore => objectStore.get(CURRENT_KEY)), before);
    const saved = await store.save(candidate, before.revision);
    assert.deepEqual(saved.game.cards.map(card => [card.laps, calculate(card).debt]), [[1, 110], [1, 220]]);
    assert.equal(saved.undo.length, 1);
    assert.deepEqual(await store.reload(), saved);
  } finally { IDBObjectStore.prototype.put = originalPut; store.close(); }
});

test('concurrent global lap and rules change commit only one complete revision', async () => {
  const { store: first, options } = setup();
  const second = new LedgerStore(options);
  try {
    const initial = await first.init();
    const before = await first.save({ ...initial, game: added(initial.game) }, initial.revision);
    const other = await second.init();
    const results = await Promise.allSettled([
      first.save({ ...before, game: applyAction(before.game, { type: 'lapAll' }),
        undo: [{ label: 'جمعی', game: before.game }] }, before.revision),
      second.save({ ...other, game: applyAction(other.game, { type: 'setRules', rules: {
        ...other.game.rules, compoundRateBps: 2500, hardcore: true,
      } }), undo: [{ label: 'قواعد', game: other.game }] }, other.revision),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const winner = results.find(result => result.status === 'fulfilled').value;
    const loser = results.find(result => result.status === 'rejected').reason;
    assert.equal(loser.code, 'CONFLICT');
    assert.deepEqual(loser.latest, winner);
    assert.equal(winner.undo.length, 1);
    assert.deepEqual(await second.reload(), winner);
  } finally { first.close(); second.close(); }
});

test('unknown schema-4 on disk fails without mutating raw data or permitting a save', async () => {
  const { store, indexedDB } = setup();
  const future = { ...createEnvelope(added(createGame())), schemaVersion: 4, revision: 8 };
  await rawTransaction(indexedDB, objectStore => objectStore.put(future, CURRENT_KEY), 'readwrite');
  try {
    await assert.rejects(store.init(), error => error.code === 'UNKNOWN_SCHEMA');
    assert.deepEqual(JSON.parse(store.readRaw()), future);
    const candidate = { ...createEnvelope(added(createGame())), revision: 8 };
    await assert.rejects(store.save(candidate, 8), error => error.code === 'UNKNOWN_SCHEMA');
    assert.deepEqual(await rawTransaction(indexedDB, objectStore => objectStore.get(CURRENT_KEY)), future);
  } finally { store.close(); }
});

test('the actual shipped schema-2 client cannot overwrite schema-3 from a stale tab', async t => {
  const shipped = '9c537d5e4f20f48bc00e13f34df29faa2bde9a1e';
  let domainSource;
  let storageSource;
  try {
    domainSource = execFileSync('git', ['show', `${shipped}:src/domain.js`], { encoding: 'utf8', windowsHide: true });
    storageSource = execFileSync('git', ['show', `${shipped}:src/storage.js`], { encoding: 'utf8', windowsHide: true });
  } catch {
    t.skip('Shipped schema-2 sources are unavailable in this checkout.');
    return;
  }
  const domainUrl = `data:text/javascript;base64,${Buffer.from(domainSource).toString('base64')}`;
  const oldDomain = await import(domainUrl);
  const oldStorage = await import(`data:text/javascript;base64,${Buffer.from(storageSource.replace("'./domain.js'", JSON.stringify(domainUrl))).toString('base64')}`);
  const { store: upgradedClient, options, indexedDB } = setup();
  const stale = new oldStorage.LedgerStore(options);
  const old = oldStorage.createEnvelope(oldDomain.applyAction(oldDomain.createGame(), {
    type: 'add', ownerId: 'p1', name: 'قدیمی', price: 200,
  }));
  await rawTransaction(indexedDB, objectStore => objectStore.put(old, CURRENT_KEY), 'readwrite');
  try {
    const staleSnapshot = await stale.init();
    const migrated = await upgradedClient.init();
    assert.equal(migrated.schemaVersion, 3);
    const updated = await upgradedClient.save({ ...migrated, game: applyAction(migrated.game, {
      type: 'setRules', rules: { ...migrated.game.rules, compoundRateBps: 3750, hardcore: true },
    }) }, migrated.revision);
    const staleChange = { ...staleSnapshot, game: oldDomain.applyAction(staleSnapshot.game, { type: 'lap', ownerId: 'p1' }) };
    await assert.rejects(stale.save(staleChange, staleSnapshot.revision), error => error.code === 'UNKNOWN_SCHEMA');
    await assert.rejects(stale.reload(), error => error.code === 'UNKNOWN_SCHEMA');
    assert.deepEqual(await rawTransaction(indexedDB, objectStore => objectStore.get(CURRENT_KEY)), updated);
  } finally { stale.close(); upgradedClient.close(); }
});

function retrospectiveFixture() {
  let game = added(createGame());
  for (let lap = 0; lap < 8; lap += 1) game = applyAction(game, { type: 'lap', ownerId: 'p1' });
  game = applyAction(game, { type: 'add', ownerId: 'p2', name: 'فعال', price: 200 });
  for (let lap = 0; lap < 2; lap += 1) game = applyAction(game, { type: 'lap', ownerId: 'p2' });
  game = applyAction(game, { type: 'add', ownerId: 'p3', name: 'تسویه', price: 200 });
  game = applyAction(game, { type: 'lap', ownerId: 'p3' });
  game = applyAction(game, { type: 'settle', cardId: game.cards.at(-1).id });
  for (const [ownerId, close] of [['p4', false], ['p5', true]]) {
    game = applyAction(game, { type: 'add', ownerId, name: 'مزایده', price: 200 });
    for (let lap = 0; lap < 8; lap += 1) game = applyAction(game, { type: 'lap', ownerId });
    const cardId = game.cards.at(-1).id;
    game = applyAction(game, { type: 'auction', cardId });
    if (close) game = applyAction(game, { type: 'closeAuction', cardId });
  }
  return game;
}

const reapplied = game => applyAction(game, { type: 'reapplyRules', rules: {
  ...game.rules, mode: 'compound', compoundRateBps: 4000,
} });

test('retrospective rules, preserved laps and stop markers roundtrip with undo and archives', async () => {
  const { store } = setup();
  try {
    const initial = await store.init();
    const before = retrospectiveFixture();
    const game = reapplied(before);
    assert.equal(game.cards[0].laps, 8);
    assert.equal(game.cards[0].interestStopLap, 3);
    assert.equal(calculate(game.cards[0]).debt, 274);
    assert.equal(calculate(game.cards[1]).debt, 196);
    assert.deepEqual(game.cards.slice(2), before.cards.slice(2));
    const saved = await store.save({ ...initial, game,
      undo: [{ label: 'اعمال روی دورهای قبلی', game: before }], archives: [game] }, initial.revision);
    assert.equal(saved.schemaVersion, 3);
    assert.deepEqual(await store.reload(), saved);
    assert.deepEqual(parseImport(exportEnvelope(saved)), saved);
    assert.deepEqual(saved.game.cards[0].history.slice(0, -1), before.cards[0].history);
    const event = saved.game.cards[0].history.at(-1);
    assert.equal(event.type, 'rulesReapplied');
    assert.equal(event.before.laps, 8);
    assert.equal(event.after.laps, 8);
    assert.equal(event.after.interestStopLap, 3);
    const lowGame = applyAction(saved.game, { type: 'reapplyRules', rules: {
      ...saved.game.rules, compoundRateBps: 0,
    } });
    const low = await store.save({ ...saved, game: lowGame, undo: [
      ...saved.undo, { label: 'کاهش بهرهٔ قبلی', game: saved.game },
    ] }, saved.revision);
    assert.equal(low.game.cards[0].status, 'active');
    assert.equal(low.game.cards[0].laps, 8);
    assert.equal(low.game.cards[0].interestStopLap, undefined);
    assert.equal(calculate(low.game.cards[0]).debt, 100);
    assert.deepEqual(low.game.cards.slice(2), before.cards.slice(2));
    const undone = await store.save({ ...low, game: low.undo.at(-1).game,
      undo: low.undo.slice(0, -1) }, low.revision);
    assert.deepEqual(undone.game, saved.game);
    assert.deepEqual(await store.reload(), undone);
    assert.deepEqual(parseImport(exportEnvelope(undone)), undone);
  } finally { store.close(); }
});

test('retrospective imports reject corrupt stop markers and event chains in every snapshot', () => {
  const game = reapplied(retrospectiveFixture());
  const valid = { ...createEnvelope(game), undo: [{ label: 'دورهای قبلی', game }], archives: [game] };
  for (const select of [envelope => envelope.game, envelope => envelope.undo[0].game, envelope => envelope.archives[0]]) {
    for (const mutate of [
      snapshot => { snapshot.cards[0].interestStopLap = null; },
      snapshot => { snapshot.cards[0].interestStopLap = 0; },
      snapshot => { snapshot.cards[0].interestStopLap = 1.5; },
      snapshot => { snapshot.cards[0].interestStopLap = '3'; },
      snapshot => { snapshot.cards[0].interestStopLap = 8; },
      snapshot => { snapshot.cards[0].interestStopLap = 1_000_000_000; },
      snapshot => { snapshot.cards[0].interestStopLap = 2; },
      snapshot => { delete snapshot.cards[0].interestStopLap; },
      snapshot => { snapshot.cards[1].interestStopLap = 1; },
      snapshot => { snapshot.cards[0].history.at(-1).after.interestStopLap = null; },
      snapshot => { snapshot.cards[0].history.at(-1).after.interestStopLap = 8; },
      snapshot => { snapshot.cards[0].history.at(-1).before.interestStopLap = 1; },
      snapshot => { snapshot.cards[0].history.at(-1).after.debt += 1; },
      snapshot => { snapshot.cards[0].history.at(-1).after.laps -= 1; },
      snapshot => { snapshot.cards[0].history.at(-1).rulesAfter.compoundRateBps = 3000; },
      snapshot => { snapshot.cards[0].history.at(-1).type = 'unknown'; },
    ]) {
      const invalid = structuredClone(valid);
      mutate(select(invalid));
      assert.throws(() => parseImport(JSON.stringify(invalid)), error => error.code === 'INVALID_DATA');
    }
  }
  // Current-schema gaps are errors, never an invitation to invent a baseline.
  const gap = structuredClone(valid);
  gap.game.cards[0].history.pop();
  assert.throws(() => parseImport(JSON.stringify(gap)), error => error.code === 'INVALID_DATA');
});

test('a failed retrospective save preserves the whole old game and retries without duplicate events', async () => {
  const { store, indexedDB } = setup();
  const originalPut = IDBObjectStore.prototype.put;
  try {
    const initial = await store.init();
    const game = retrospectiveFixture();
    const before = await store.save({ ...initial, game }, initial.revision);
    const candidate = { ...before, game: reapplied(game),
      undo: [{ label: 'اعمال روی دورهای قبلی', game }] };
    IDBObjectStore.prototype.put = function () { throw new DOMException('Test quota exhausted', 'QuotaExceededError'); };
    await assert.rejects(store.save(candidate, before.revision), error => error.code === 'QUOTA');
    assert.deepEqual(store.lastGood, before);
    assert.deepEqual(store.pending, candidate);
    IDBObjectStore.prototype.put = originalPut;
    assert.deepEqual(await rawTransaction(indexedDB, objectStore => objectStore.get(CURRENT_KEY)), before);
    assert.deepEqual(parseImport(exportEnvelope(store.pending)), candidate);
    const saved = await store.save(candidate, before.revision);
    assert.deepEqual(saved.game, candidate.game);
    assert.equal(saved.game.cards[0].history.filter(event => event.type === 'rulesReapplied').length, 1);
    assert.equal(saved.game.cards[1].history.filter(event => event.type === 'rulesReapplied').length, 1);
    assert.equal(saved.undo.length, 1);
    assert.deepEqual(await store.reload(), saved);
  } finally { IDBObjectStore.prototype.put = originalPut; store.close(); }
});

test('concurrent retrospective recalculation and lap commit only one complete revision', async () => {
  const { store: first, options } = setup();
  const second = new LedgerStore(options);
  try {
    const initial = await first.init();
    const before = await first.save({ ...initial, game: retrospectiveFixture() }, initial.revision);
    const other = await second.init();
    const results = await Promise.allSettled([
      first.save({ ...before, game: reapplied(before.game),
        undo: [{ label: 'دورهای قبلی', game: before.game }] }, before.revision),
      second.save({ ...other, game: applyAction(other.game, { type: 'lapAll' }),
        undo: [{ label: 'جمعی', game: other.game }] }, other.revision),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const winner = results.find(result => result.status === 'fulfilled').value;
    const loser = results.find(result => result.status === 'rejected').reason;
    assert.equal(loser.code, 'CONFLICT');
    assert.deepEqual(loser.latest, winner);
    assert.equal(winner.undo.length, 1);
    assert.deepEqual(winner.game.cards.slice(2), before.game.cards.slice(2));
    assert.deepEqual(await second.reload(), winner);
  } finally { first.close(); second.close(); }
});

test('the actual shipped schema-3 client rejects retrospective histories and cannot overwrite them', async t => {
  const shipped = '72ddf935343576be833fd2825d2acf3a0ff9a3f9';
  let domainSource;
  let storageSource;
  try {
    domainSource = execFileSync('git', ['show', `${shipped}:src/domain.js`], { encoding: 'utf8', windowsHide: true });
    storageSource = execFileSync('git', ['show', `${shipped}:src/storage.js`], { encoding: 'utf8', windowsHide: true });
  } catch {
    t.skip('Shipped schema-3 sources are unavailable in this checkout.');
    return;
  }
  const domainUrl = `data:text/javascript;base64,${Buffer.from(domainSource).toString('base64')}`;
  const oldDomain = await import(domainUrl);
  const oldStorage = await import(`data:text/javascript;base64,${Buffer.from(storageSource.replace("'./domain.js'", JSON.stringify(domainUrl))).toString('base64')}`);
  let oldGame = oldDomain.applyAction(oldDomain.createGame(), { type: 'add', ownerId: 'p1', name: 'قدیمی', price: 200 });
  for (let lap = 0; lap < 8; lap += 1) oldGame = oldDomain.applyAction(oldGame, { type: 'lap', ownerId: 'p1' });
  const old = oldStorage.createEnvelope(oldGame);
  for (const location of ['current', 'undo', 'archive']) {
    const { store: upgradedClient, options, indexedDB } = setup();
    const stale = new oldStorage.LedgerStore(options);
    await rawTransaction(indexedDB, objectStore => objectStore.put(old, CURRENT_KEY), 'readwrite');
    try {
      const staleSnapshot = await stale.init();
      const loaded = await upgradedClient.init();
      const retro = reapplied(loaded.game);
      const candidate = { ...loaded,
        game: location === 'current' ? retro : loaded.game,
        undo: location === 'undo' ? [{ label: 'دورهای قبلی', game: retro }] : [],
        archives: location === 'archive' ? [retro] : [],
      };
      const updated = await upgradedClient.save(candidate, loaded.revision);
      const staleChange = { ...staleSnapshot, game: oldDomain.applyAction(staleSnapshot.game, {
        type: 'rename', ownerId: 'p1', name: 'تب قدیمی',
      }) };
      await assert.rejects(stale.save(staleChange, staleSnapshot.revision), error => error.code === 'INVALID_DATA');
      await assert.rejects(stale.reload(), error => error.code === 'INVALID_DATA');
      const freshOld = new oldStorage.LedgerStore(options);
      try {
        await assert.rejects(freshOld.init(), error => error.code === 'INVALID_DATA');
        assert.deepEqual(JSON.parse(freshOld.readRaw()), updated);
        await assert.rejects(freshOld.save(staleChange, staleSnapshot.revision), error => error.code === 'INVALID_DATA');
      } finally { freshOld.close(); }
      assert.deepEqual(await rawTransaction(indexedDB, objectStore => objectStore.get(CURRENT_KEY)), updated);
      assert.deepEqual(await upgradedClient.reload(), updated);
    } finally { stale.close(); upgradedClient.close(); }
  }
});
