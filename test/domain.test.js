import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA_VERSION, MAX_PRICE, MAX_CARD_HISTORY, createGame, validateGame, parsePrice, calculate,
  canLap, applyAction, migrateLegacy, hydrateGameHistory,
} from '../src/domain.js';

const action = (game, type, extra = {}) => applyAction(game, { type, ...extra });
const add = (game, ownerId = 'p1', price = 200, name = 'خیابان') => action(game, 'add', { ownerId, price, name });
const lap = (game, ownerId = 'p1', count = 1) => {
  let next = game;
  for (let i = 0; i < count; i += 1) next = action(next, 'lap', { ownerId });
  return next;
};
const roundTrip = (game) => validateGame(JSON.parse(JSON.stringify(game)));
const legacy = (cards = [], compound = true) => ({ players: Array(8).fill(''), cards, seq: 10, compound });
const legacyCard = (id = 'old-card', extra = {}) => ({ id, p: 0, name: 'کارت قدیمی', price: 200, laps: 0, auction: false, ...extra });

test('schema version and exact independently specified compound debt vector', () => {
  assert.equal(SCHEMA_VERSION, 2);
  const expected = [100, 110, 121, 133, 146, 161, 177, 195, 214];
  assert.deepEqual(expected.map((_, laps) => calculate({ price: 200, laps }).debt), expected);
  assert.notEqual(calculate({ price: 200, laps: 8 }).debt, 215);
  assert.deepEqual(calculate({ price: 200, laps: 2 }), {
    debt: 121, loan: 100, interest: 21, bid: 50,
    over: false, nextOver: false, roundedAtLimit: false,
  });
});

test('odd-price precision and uniform half-up auction rounding', () => {
  assert.equal(calculate({ price: 201, laps: 0 }).loan, 101);
  assert.equal(calculate({ price: 201, laps: 0 }).debt, 101);
  assert.equal(calculate({ price: 201, laps: 1 }).debt, 111);
  assert.equal(calculate({ price: 201, laps: 8 }).debt, 215);
  assert.equal(calculate({ price: 150, laps: 0 }).bid, 38);
  assert.equal(calculate({ price: 201, laps: 0 }).bid, 50);
  assert.equal(calculate({ price: 202, laps: 0 }).bid, 51);
  assert.equal(calculate({ price: MAX_PRICE, laps: 0 }).loan, 5_000_000_000);
  assert.equal(calculate({ price: MAX_PRICE, laps: 0 }).bid, 2_500_000_000);
  const odd = calculate({ price: 201, laps: 8 });
  assert.equal(odd.loan + odd.interest, odd.debt);
});

test('strict exact crossing, equality and tiny rounded-price explanation', () => {
  assert.equal(calculate({ price: 200, laps: 10 }, 'legacy-simple').debt, 200);
  assert.equal(calculate({ price: 200, laps: 10 }, 'legacy-simple').over, false);
  assert.equal(calculate({ price: 200, laps: 10 }, 'legacy-simple').nextOver, true);
  assert.equal(calculate({ price: 200, laps: 11 }, 'legacy-simple').debt, 210);
  assert.equal(calculate({ price: 200, laps: 11 }, 'legacy-simple').over, true);
  const tiny = calculate({ price: 1, laps: 8 });
  assert.equal(tiny.debt, 1);
  assert.equal(tiny.over, true);
  assert.equal(tiny.roundedAtLimit, true);
  assert.equal(calculate({ price: 1, laps: 7 }).over, false);
  assert.equal(calculate({ price: 1, laps: 7 }).nextOver, true);
});

test('numeric inputs accept all three alphabets and valid thousands grouping', () => {
  for (const [input, expected] of [
    ['۲۰۰', 200], ['٢٠١', 201], ['202', 202], [' ۱٬۲۳۴٬۵۶۷ ', 1_234_567],
    ['1,234,567', 1_234_567], ['١،٢٣٤', 1_234], ['1 234', 1_234],
    ['۱\u00a0۲۳۴', 1_234], ['۱\u202f۲۳۴', 1_234], ['۹٬۹۹۹٬۹۹۹٬۹۹۹', MAX_PRICE],
  ]) assert.equal(parsePrice(input), expected, input);
  for (const input of ['', '۰', '0', '-1', '+1', '1.5', '۱٫۵', 'NaN', 'Infinity',
    '1e3', '1,23', '12 34', '1,234 567', '1\n000', '10,000,000,000', '000000000001',
    '<script>1</script>', '1/2', '۱٬۲۳۴،۵۶۷']) assert.throws(() => parsePrice(input), undefined, input);
  assert.throws(() => parsePrice(200));
});

test('eight stable seats, names preserved, no-op rename and independent identities', () => {
  let game = createGame(['رامین', 'رامین', '']);
  assert.equal(game.model, 'compound');
  assert.deepEqual(game.players.map((player) => player.id), ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']);
  assert.deepEqual(game.players.map((player) => player.name), ['رامین', 'رامین', '', '', '', '', '', '']);
  game = add(game);
  const id = game.cards[0].id;
  const renamed = action(game, 'rename', { ownerId: 'p1', name: 'سارا' });
  assert.equal(renamed.cards[0].id, id);
  assert.equal(renamed.cards[0].ownerId, 'p1');
  assert.equal(game.players[0].name, 'رامین');
  assert.equal(action(renamed, 'rename', { ownerId: 'p1', name: 'سارا' }), renamed);
  assert.equal(action(renamed, 'rename', { ownerId: 'invalid', name: 'عوض' }), renamed);
  assert.throws(() => action(game, 'rename', { ownerId: 'p1', name: 'x'.repeat(81) }));
});

test('one lap updates only that owner active cards; new mortgage always starts at zero', () => {
  let game = add(add(add(createGame()), 'p1', 201, 'دوم'), 'p2', 150, 'سوم');
  const before = roundTrip(game);
  game = lap(game, 'p1', 2);
  assert.deepEqual(game.cards.map((card) => card.laps), [2, 2, 0]);
  assert.deepEqual(game.cards.map((card) => calculate(card).debt), [121, 122, 75]);
  assert.deepEqual(before.cards.map((card) => card.laps), [0, 0, 0]);
  game = add(game, 'p1', 400, 'تازه');
  assert.equal(game.cards.at(-1).laps, 0);
  assert.equal(calculate(game.cards.at(-1)).debt, 200);
  assert.equal(canLap(game, 'p3'), false);
  assert.equal(lap(game, 'p3'), game);
});

test('simultaneous crossing is atomic, grace decisions independent and all owner laps blocked', () => {
  let game = add(add(add(createGame()), 'p1', 201, 'دوم'), 'p2', 400, 'دیگری');
  game = lap(game, 'p1', 7);
  assert.equal(calculate(game.cards[0]).nextOver, true);
  game = lap(game, 'p1');
  assert.deepEqual(game.cards.map((card) => card.status), ['grace', 'grace', 'active']);
  assert.deepEqual(game.cards.map((card) => calculate(card).debt), [214, 215, 200]);
  game = add(game, 'p1', 150, 'هنوز فعال');
  assert.equal(canLap(game, 'p1'), false);
  assert.equal(lap(game), game);
  assert.equal(roundTrip(game).cards[0].laps, 8);
  game = action(game, 'settle', { cardId: game.cards[0].id });
  assert.deepEqual(game.cards.map((card) => card.status), ['settled', 'grace', 'active', 'active']);
  assert.equal(canLap(game, 'p1'), false);
  game = action(game, 'auction', { cardId: game.cards[1].id });
  assert.equal(canLap(game, 'p1'), true);
  game = lap(game, 'p1');
  assert.deepEqual(game.cards.map((card) => card.laps), [8, 8, 0, 1]);
  assert.equal(game.cards[0].settlement.amount, 214);
});

test('settlement freezes one card amount, owner and time without changing siblings', () => {
  let game = lap(add(add(createGame()), 'p1', 300, 'دیگر'), 'p1', 2);
  const cardId = game.cards[0].id;
  game = action(game, 'settle', { cardId });
  assert.equal(game.cards[0].status, 'settled');
  assert.equal(game.cards[0].settlement.amount, 121);
  assert.equal(game.cards[0].settlement.ownerId, 'p1');
  assert.ok(Number.isFinite(Date.parse(game.cards[0].settlement.at)));
  const paid = structuredClone(game.cards[0]);
  game = lap(game, 'p1', 3);
  assert.deepEqual(game.cards[0], paid);
  assert.deepEqual(roundTrip(game).cards[0], paid);
  assert.equal(action(game, 'settle', { cardId }), game);
  assert.equal(action(game, 'transfer', { cardId, ownerId: 'p2' }), game);
});

test('required transfer of debt 121 moves only future lap responsibility', () => {
  let game = lap(add(createGame()), 'p1', 2);
  const before = structuredClone(game.cards[0]);
  game = action(game, 'transfer', { cardId: before.id, ownerId: 'p2' });
  assert.deepEqual({ ...game.cards[0], history: before.history }, { ...before, ownerId: 'p2' });
  assert.equal(game.cards[0].history.at(-1).type, 'transfer');
  assert.equal(calculate(game.cards[0]).debt, 121);
  assert.equal(lap(game, 'p1'), game);
  game = lap(game, 'p2');
  assert.equal(calculate(game.cards[0]).debt, 133);
  assert.equal(action(game, 'transfer', { cardId: before.id, ownerId: 'p2' }), game);
  assert.equal(action(game, 'transfer', { cardId: before.id, ownerId: 'p9' }), game);
  assert.equal(action(game, 'transfer', { cardId: 'absent', ownerId: 'p1' }), game);
});

test('transfer of grace preserves frozen debt and transfers the unresolved-decision block', () => {
  let game = lap(add(createGame()), 'p1', 8);
  game = add(add(game, 'p1', 300, 'A active'), 'p2', 300, 'B active');
  const before = structuredClone(game.cards[0]);
  assert.equal(canLap(game, 'p1'), false);
  assert.equal(canLap(game, 'p2'), true);
  game = action(game, 'transfer', { cardId: before.id, ownerId: 'p2' });
  assert.deepEqual({ ...game.cards[0], history: before.history }, { ...before, ownerId: 'p2' });
  assert.equal(game.cards[0].history.at(-1).after.debt, 214);
  assert.equal(canLap(game, 'p1'), true);
  assert.equal(canLap(game, 'p2'), false);
  assert.equal(lap(game, 'p2'), game);
  game = roundTrip(lap(game, 'p1'));
  assert.equal(game.cards[0].status, 'grace');
  assert.equal(calculate(game.cards[0]).debt, 214);
  assert.equal(game.cards[0].laps, 8);
});

test('auction is an explicit grace decision, stays frozen and close retains record', () => {
  let game = add(createGame());
  const cardId = game.cards[0].id;
  assert.equal(action(game, 'auction', { cardId }), game);
  assert.equal(action(game, 'closeAuction', { cardId }), game);
  game = lap(game, 'p1', 8);
  game = action(game, 'auction', { cardId });
  assert.equal(game.cards[0].status, 'auction');
  assert.equal(calculate(game.cards[0]).bid, 50);
  assert.equal(lap(game), game);
  assert.equal(action(game, 'transfer', { cardId, ownerId: 'p2' }), game);
  assert.equal(action(game, 'settle', { cardId }), game);
  game = action(game, 'closeAuction', { cardId });
  assert.equal(game.cards.length, 1);
  assert.equal(game.cards[0].status, 'auction_closed');
  assert.ok(Number.isFinite(Date.parse(game.cards[0].closedAt)));
  assert.equal(calculate(game.cards[0]).debt, 214);
  assert.equal(roundTrip(game).cards[0].status, 'auction_closed');
  assert.equal(action(game, 'closeAuction', { cardId }), game);
});

test('immutable action snapshots permit coherent reverse undo through all operation types', () => {
  let game = createGame();
  const history = [];
  const doAction = (type, extra) => { history.push(game); game = action(game, type, extra); };
  doAction('rename', { ownerId: 'p1', name: 'رامین' });
  doAction('add', { ownerId: 'p1', name: 'خیابان', price: 200 });
  const cardId = game.cards[0].id;
  doAction('lap', { ownerId: 'p1' });
  doAction('transfer', { cardId, ownerId: 'p2' });
  doAction('settle', { cardId });
  assert.equal(game.cards[0].settlement.amount, 110);
  game = history.pop();
  assert.equal(game.cards[0].ownerId, 'p2');
  assert.equal(game.cards[0].status, 'active');
  game = history.pop();
  assert.equal(game.cards[0].ownerId, 'p1');
  game = history.pop();
  assert.equal(game.cards[0].laps, 0);
  game = history.pop();
  assert.equal(game.cards.length, 0);
  assert.equal(game.players[0].name, 'رامین');
  game = history.pop();
  assert.equal(game.players[0].name, '');
});

test('legacy fixture preserves active, grace, settled, auction, IDs and unknown historical times', () => {
  const fixture = legacy([
    legacyCard('active', { laps: 2, p: 1 }),
    legacyCard('grace', { laps: 99 }),
    legacyCard('paid', { laps: 3, paid: 125, auction: true }),
    legacyCard('auction', { laps: 8, auction: true }),
  ]);
  fixture.players[1] = 'رامین';
  const before = JSON.stringify(fixture);
  const game = migrateLegacy(fixture);
  assert.equal(JSON.stringify(fixture), before);
  assert.equal(game.model, 'compound');
  assert.equal(game.createdAt, null);
  assert.equal(game.players[1].name, 'رامین');
  assert.deepEqual(game.cards.map((card) => card.id), ['active', 'grace', 'paid', 'auction']);
  assert.deepEqual(game.cards.map((card) => card.status), ['active', 'grace', 'settled', 'auction']);
  assert.deepEqual(game.cards.map((card) => card.laps), [2, 8, 3, 8]);
  assert.equal(game.cards[0].ownerId, 'p2');
  assert.equal(game.cards[1].legacy.rawLaps, 99);
  assert.equal(calculate(game.cards[1]).debt, 214);
  assert.equal(game.cards[2].settlement.amount, 125); // historical paid amount is not rewritten to 133
  assert.equal(game.cards[2].settlement.at, null);
  assert.ok(game.cards.every((card) => card.createdAt === null));
  assert.deepEqual(roundTrip(game), game);
});

test('legacy-simple stays locked, exact equality does not produce grace and new game is compound', () => {
  let game = migrateLegacy(legacy([
    legacyCard('active', { laps: 10 }), legacyCard('frozen', { laps: 999, p: 1 }),
  ], false));
  assert.equal(game.model, 'legacy-simple');
  assert.equal(game.cards[0].status, 'active');
  assert.equal(game.cards[1].laps, 11);
  assert.equal(game.cards[1].legacy.rawLaps, 999);
  assert.equal(calculate(game.cards[1], game.model).debt, 210);
  game = lap(game, 'p1');
  assert.equal(game.cards[0].laps, 11);
  assert.equal(game.cards[0].status, 'grace');
  assert.equal(calculate(game.cards[0], game.model).debt, 210);
  assert.equal(createGame(game.players.map((player) => player.name)).model, 'compound');
  assert.equal(action(game, 'setMode', { model: 'compound' }), game);
});

test('a migrated active compound card can advance while its raw provenance remains fixed', () => {
  const original = migrateLegacy(legacy([legacyCard('continuing', { laps: 2 })]));
  const advanced = lap(original, 'p1');
  assert.equal(advanced.cards[0].laps, 3);
  assert.equal(advanced.cards[0].legacy.rawLaps, 2);
  assert.equal(calculate(advanced.cards[0]).debt, 133);
  assert.equal(original.cards[0].laps, 2);
  assert.deepEqual(roundTrip(advanced), advanced);
});

test('legacy missing or nonboolean compound defaults compatibly with explicit migration record', () => {
  for (const compound of [undefined, null, 'false', 0]) {
    const fixture = legacy([legacyCard('default', { laps: 8 })], compound);
    if (compound === undefined) delete fixture.compound;
    const game = migrateLegacy(fixture);
    assert.equal(game.model, 'compound');
    assert.equal(game.cards[0].status, 'grace');
    assert.equal(game.migration.compoundDefaulted, true);
  }
  assert.equal(migrateLegacy(legacy()).migration.compoundDefaulted, false);
});

test('validation rejects malformed state, duplicate IDs, ownership and contradictory statuses', () => {
  const base = add(createGame());
  const reject = (mutate) => { const candidate = structuredClone(base); mutate(candidate); assert.throws(() => validateGame(candidate)); };
  reject((game) => { game.id = ''; });
  reject((game) => { game.createdAt = '2026-02-31T00:00:00.000Z'; });
  reject((game) => { game.model = 'flat'; });
  reject((game) => { game.players.pop(); });
  reject((game) => { game.players[1].id = 'p1'; });
  reject((game) => { game.players[0].name = 'a'.repeat(81); });
  reject((game) => { game.cards.push(structuredClone(game.cards[0])); });
  reject((game) => { game.cards[0].ownerId = 'p9'; });
  reject((game) => { game.cards[0].name = 'a'.repeat(121); });
  for (const price of [0, -1, 2.5, NaN, Infinity, MAX_PRICE + 1, '200']) reject((game) => { game.cards[0].price = price; });
  for (const laps of [-1, 0.5, Infinity, 12, 1_000_000, '2']) reject((game) => { game.cards[0].laps = laps; });
  reject((game) => { game.cards[0].status = 'missing'; });
  reject((game) => { game.cards[0].laps = 8; });
  reject((game) => { game.cards[0].status = 'grace'; });
  reject((game) => { game.cards[0].status = 'auction'; });
  reject((game) => { game.cards[0].status = 'settled'; });
  reject((game) => { game.cards[0].settlement = { amount: 100, ownerId: 'p1', at: null }; });
  reject((game) => { game.cards[0].legacy = { rawLaps: 1_000_001 }; });
  reject((game) => { game.cards[0].closedAt = null; });
  reject((game) => { game.migration = { source: 'unknown', compoundDefaulted: false }; });
  const excess = structuredClone(base);
  excess.cards = Array.from({ length: 501 }, (_, i) => ({ ...excess.cards[0], id: `c${i}` }));
  assert.throws(() => validateGame(excess));
  assert.equal(validateGame(base), base);
});

test('settlement and frozen-state validation preserve lawful historical zero but reject malformed money', () => {
  const game = action(add(createGame()), 'settle', {});
  assert.equal(game.cards[0].status, 'active');
  const fixture = migrateLegacy(legacy([legacyCard('paid', { paid: 0 })]));
  assert.equal(fixture.cards[0].settlement.amount, 0);
  for (const amount of [-1, 1.5, Infinity, '100', MAX_PRICE * 2 + 1]) {
    const invalid = structuredClone(fixture);
    invalid.cards[0].settlement.amount = amount;
    assert.throws(() => validateGame(invalid));
  }
  const invalidOwner = structuredClone(fixture);
  invalidOwner.cards[0].settlement.ownerId = 'p9';
  assert.throws(() => validateGame(invalidOwner));
  const tooLate = structuredClone(fixture);
  tooLate.cards[0].laps = 9;
  tooLate.cards[0].legacy.rawLaps = 9;
  assert.throws(() => validateGame(tooLate));
});

test('legacy invalid input is rejected without silently repairing or modifying raw source', () => {
  const invalids = [
    legacy([legacyCard('bad', { p: 8 })]),
    legacy([legacyCard('same'), legacyCard('same')]),
    legacy([legacyCard('bad', { price: MAX_PRICE + 1 })]),
    legacy([legacyCard('bad', { laps: 1_000_001 })]),
    legacy([legacyCard('bad', { paid: '121' })]),
    legacy([legacyCard('bad', { auction: true, laps: 2 })]),
    legacy([legacyCard('bad', { auction: 'yes' })]),
  ];
  for (const fixture of invalids) {
    const before = JSON.stringify(fixture);
    assert.throws(() => migrateLegacy(fixture));
    assert.equal(JSON.stringify(fixture), before);
  }
  const incomplete = legacy([legacyCard()]);
  delete incomplete.cards[0].name;
  assert.throws(() => migrateLegacy(incomplete));
});

test('calculation rejects hostile bounds before exponentiation', () => {
  for (const card of [{ price: 200, laps: 1_000_000 }, { price: Infinity, laps: 0 },
    { price: 200, laps: -1 }, { price: 200, laps: '8' }, { price: 0, laps: 8 }]) {
    assert.throws(() => calculate(card));
  }
  assert.throws(() => calculate({ price: 200, laps: 1 }, 'unknown'));
});

test('new per-card history records exact event order and immutable owner names', () => {
  let game = add(createGame(['رامین', 'سارا']));
  const cardId = game.cards[0].id;
  const created = structuredClone(game.cards[0].history[0]);
  assert.equal(created.type, 'created');
  assert.equal(created.at, game.cards[0].createdAt);
  assert.equal(created.before, null);
  assert.deepEqual(created.after, { name: 'خیابان', price: 200, laps: 0, ownerId: 'p1',
    ownerName: 'رامین', status: 'active', debt: 100, paid: null });
  game = lap(game, 'p1', 2);
  game = action(game, 'rename', { ownerId: 'p1', name: 'نام تازه' });
  game = action(game, 'transfer', { cardId, ownerId: 'p2' });
  game = action(game, 'rename', { ownerId: 'p2', name: 'سارا تازه' });
  game = action(game, 'settle', { cardId });
  const events = game.cards[0].history;
  assert.deepEqual(events.map((event) => event.type), ['created', 'lap', 'lap', 'transfer', 'settle']);
  assert.deepEqual(events.map((event) => event.after.debt), [100, 110, 121, 121, 121]);
  assert.deepEqual(events[0], created);
  assert.equal(events[1].before.ownerName, 'رامین');
  assert.equal(events[3].before.ownerName, 'نام تازه');
  assert.equal(events[3].after.ownerName, 'سارا');
  assert.equal(events[4].after.ownerName, 'سارا تازه');
  assert.equal(events[4].after.paid, 121);
  assert.equal(new Set(events.map((event) => event.id)).size, events.length);
  assert.ok(events.every((event) => Number.isFinite(Date.parse(event.at))));
  assert.deepEqual(roundTrip(game), game);
});

test('one lap yields independent card events with the same action timestamp and exact odd-price amounts', () => {
  const original = add(add(add(createGame(['رامین'])), 'p1', 201, 'دوم'), 'p2', 150, 'دیگری');
  const next = lap(original);
  const [first, second, other] = next.cards;
  assert.equal(first.history.at(-1).after.debt, 110);
  assert.equal(second.history.at(-1).after.debt, 111);
  assert.equal(first.history.at(-1).at, second.history.at(-1).at);
  assert.notEqual(first.history.at(-1).id, second.history.at(-1).id);
  assert.equal(other.history.length, 1);
  assert.ok(original.cards.every((card) => card.history.length === 1));
});

test('old v2 history hydration is immutable and idempotent with only a known-state baseline', () => {
  const original = lap(add(createGame(['رامین'])), 'p1', 2);
  delete original.cards[0].history;
  const before = structuredClone(original);
  assert.equal(validateGame(original), original);
  const hydrated = hydrateGameHistory(original);
  assert.deepEqual(original, before);
  assert.notEqual(hydrated, original);
  const [event] = hydrated.cards[0].history;
  assert.equal(event.type, 'baseline');
  assert.equal(event.at, null);
  assert.equal(event.before, null);
  assert.deepEqual(event.after, { name: 'خیابان', price: 200, laps: 2, ownerId: 'p1',
    ownerName: 'رامین', status: 'active', debt: 121, paid: null });
  assert.equal(hydrated.cards[0].history.length, 1);
  assert.equal(hydrateGameHistory(hydrated), hydrated);
  const continued = lap(original);
  assert.deepEqual(continued.cards[0].history.map((item) => item.type), ['baseline', 'lap']);
  assert.equal(continued.cards[0].history[0].at, null);
  assert.equal(continued.cards[0].history[1].after.debt, 133);
});

test('changes carried forward by an old tab add a dated-unknown baseline gap and retain known prior events', () => {
  const oldTab = lap(add(createGame(['رامین', 'سارا'])), 'p1', 2);
  const previousEvents = structuredClone(oldTab.cards[0].history);
  oldTab.cards[0].ownerId = 'p2';
  oldTab.cards[0].laps = 3;
  const before = structuredClone(oldTab);
  assert.throws(() => validateGame(oldTab));
  assert.equal(validateGame(oldTab, { allowHistoryGap: true }), oldTab);
  const hydrated = hydrateGameHistory(oldTab);
  assert.deepEqual(oldTab, before);
  assert.deepEqual(hydrated.cards[0].history.slice(0, -1), previousEvents);
  const baseline = hydrated.cards[0].history.at(-1);
  assert.equal(baseline.type, 'baseline');
  assert.equal(baseline.at, null);
  assert.equal(baseline.before, null);
  assert.equal(baseline.after.ownerId, 'p2');
  assert.equal(baseline.after.ownerName, 'سارا');
  assert.equal(baseline.after.laps, 3);
  assert.equal(baseline.after.debt, 133);
  assert.equal(hydrateGameHistory(hydrated), hydrated);
  const continued = lap(hydrated, 'p2');
  assert.deepEqual(continued.cards[0].history.map((event) => event.type), ['created', 'lap', 'lap', 'baseline', 'lap']);
  assert.equal(continued.cards[0].history.at(-1).before.debt, 133);
  assert.equal(continued.cards[0].history.at(-1).after.debt, 146);
  assert.deepEqual(roundTrip(continued), continued);
});

test('owner-name drift never fabricates a gap and a corrupt event chain still cannot hydrate', () => {
  const renamed = add(createGame(['رامین']));
  renamed.players[0].name = 'نام تازه';
  assert.equal(hydrateGameHistory(renamed), renamed);
  assert.equal(renamed.cards[0].history[0].after.ownerName, 'رامین');
  const corrupted = lap(renamed);
  corrupted.cards[0].history[1].before.price = 300;
  const before = JSON.stringify(corrupted);
  assert.throws(() => hydrateGameHistory(corrupted));
  assert.equal(JSON.stringify(corrupted), before);
});

test('legacy migration adds a baseline without inventing past payments or timestamps', () => {
  const game = migrateLegacy(legacy([legacyCard('paid', { laps: 3, paid: 125 })]));
  const event = game.cards[0].history[0];
  assert.equal(event.type, 'baseline');
  assert.equal(event.at, null);
  assert.equal(event.before, null);
  assert.equal(event.after.debt, 133);
  assert.equal(event.after.paid, 125);
  assert.equal(game.cards[0].history.length, 1);
});

test('editing name and price keeps two laps and corrects exact debt 121 to 182', () => {
  const original = lap(add(createGame(['رامین'])), 'p1', 2);
  const previous = structuredClone(original);
  const cardId = original.cards[0].id;
  const corrected = action(original, 'editCard', { cardId, name: '  خیابان درست  ', price: 300 });
  assert.deepEqual(original, previous);
  const card = corrected.cards[0];
  assert.equal(card.id, cardId);
  assert.equal(card.ownerId, original.cards[0].ownerId);
  assert.equal(card.createdAt, original.cards[0].createdAt);
  assert.equal(card.status, 'active');
  assert.equal(card.laps, 2);
  assert.equal(card.name, 'خیابان درست');
  assert.equal(calculate(card).loan, 150);
  assert.equal(calculate(card).debt, 182);
  const event = card.history.at(-1);
  assert.equal(event.type, 'editCard');
  assert.equal(event.before.name, 'خیابان');
  assert.equal(event.before.price, 200);
  assert.equal(event.before.debt, 121);
  assert.equal(event.after.name, 'خیابان درست');
  assert.equal(event.after.price, 300);
  assert.equal(event.after.debt, 182);
  assert.equal(event.after.laps, 2);
  const advanced = lap(corrected);
  assert.equal(calculate(advanced.cards[0]).debt, 200); // exact 199.65, not 182 * 1.1 = 200.2
  assert.deepEqual(roundTrip(corrected), corrected);
});

test('odd-price and legacy-simple corrections keep the original interest model and raw laps', () => {
  const original = lap(add(createGame()), 'p1', 2);
  const odd = action(original, 'editCard', { cardId: original.cards[0].id, name: 'خیابان', price: 201 });
  assert.equal(calculate(odd.cards[0]).loan, 101);
  assert.equal(calculate(odd.cards[0]).debt, 122);
  assert.equal(odd.cards[0].laps, 2);
  const simple = migrateLegacy(legacy([legacyCard('simple', { laps: 10 })], false));
  const corrected = action(simple, 'editCard', { cardId: 'simple', name: 'اصلاح شده', price: 301 });
  assert.equal(corrected.model, 'legacy-simple');
  assert.equal(corrected.cards[0].laps, 10);
  assert.deepEqual(corrected.cards[0].legacy, { rawLaps: 10 });
  assert.equal(calculate(corrected.cards[0], corrected.model).debt, 301);
  assert.equal(corrected.cards[0].status, 'active');
});

test('correction preserves grace, auction and closed-auction status while recomputing debt and bid', () => {
  for (const status of ['grace', 'auction', 'auction_closed']) {
    let game = lap(add(createGame()), 'p1', 8);
    const cardId = game.cards[0].id;
    if (status !== 'grace') game = action(game, 'auction', { cardId });
    if (status === 'auction_closed') game = action(game, 'closeAuction', { cardId });
    const original = structuredClone(game.cards[0]);
    const corrected = action(game, 'editCard', { cardId, name: 'درست', price: 302 });
    const card = corrected.cards[0];
    assert.equal(card.status, status);
    assert.equal(card.laps, 8);
    assert.equal(card.createdAt, original.createdAt);
    assert.equal(card.closedAt, original.closedAt);
    assert.equal(calculate(card).debt, 324);
    assert.equal(calculate(card).bid, 76);
    assert.equal(card.history.at(-1).before.status, status);
    assert.equal(card.history.at(-1).after.status, status);
    assert.deepEqual(roundTrip(corrected), corrected);
  }
});

test('editing settled cards preserves the actual settlement amount, time and owner', () => {
  let game = lap(add(createGame(['رامین'])), 'p1', 2);
  const cardId = game.cards[0].id;
  game = action(game, 'transfer', { cardId, ownerId: 'p2' });
  game = action(game, 'settle', { cardId });
  const settlement = structuredClone(game.cards[0].settlement);
  const corrected = action(game, 'editCard', { cardId, name: 'اصلاح بعد از تسویه', price: 300 });
  const card = corrected.cards[0];
  assert.equal(card.status, 'settled');
  assert.equal(card.ownerId, 'p2');
  assert.equal(card.laps, 2);
  assert.deepEqual(card.settlement, settlement);
  assert.equal(calculate(card).debt, 182);
  assert.equal(card.history.at(-1).before.paid, 121);
  assert.equal(card.history.at(-1).after.paid, 121);
  assert.deepEqual(roundTrip(corrected), corrected);
});

test('undo snapshots restore edited fields and remove the edit event together', () => {
  let game = lap(add(createGame()), 'p1', 2);
  const undo = structuredClone(game);
  game = action(game, 'editCard', { cardId: game.cards[0].id, name: 'اصلاح', price: 300 });
  assert.equal(game.cards[0].history.at(-1).type, 'editCard');
  game = undo;
  assert.equal(game.cards[0].name, 'خیابان');
  assert.equal(game.cards[0].price, 200);
  assert.equal(game.cards[0].laps, 2);
  assert.equal(calculate(game.cards[0]).debt, 121);
  assert.deepEqual(game.cards[0].history.map((event) => event.type), ['created', 'lap', 'lap']);
  assert.deepEqual(roundTrip(game), undo);
});

test('no-op and invalid edits never append history or change their source', () => {
  const game = add(createGame());
  const cardId = game.cards[0].id;
  const before = JSON.stringify(game);
  assert.equal(action(game, 'editCard', { cardId, name: ' خیابان ', price: 200 }), game);
  assert.equal(action(game, 'editCard', { cardId: 'absent', name: 'اصلاح', price: 300 }), game);
  assert.equal(action(game, 'auction', { cardId }), game);
  assert.equal(action(game, 'transfer', { cardId, ownerId: 'p1' }), game);
  assert.equal(lap(game, 'p8'), game);
  for (const name of ['', '   ', null, 'a'.repeat(121)]) {
    assert.throws(() => action(game, 'editCard', { cardId, name, price: 300 }));
  }
  for (const price of [0, -1, 1.5, Infinity, '300', MAX_PRICE + 1]) {
    assert.throws(() => action(game, 'editCard', { cardId, name: 'اصلاح', price }));
  }
  assert.equal(JSON.stringify(game), before);
  const old = structuredClone(game);
  delete old.cards[0].history;
  assert.equal(action(old, 'editCard', { cardId, name: 'خیابان', price: 200 }), old);
  assert.equal(old.cards[0].history, undefined);
});

test('hostile event imports reject bad bounds, identities, money and transitions without mutation', () => {
  const original = lap(add(createGame()), 'p1', 2);
  const reject = (mutate) => {
    const candidate = structuredClone(original);
    mutate(candidate.cards[0]);
    const before = JSON.stringify(candidate);
    assert.throws(() => validateGame(candidate));
    assert.equal(JSON.stringify(candidate), before);
  };
  reject((card) => { card.history = null; });
  reject((card) => { card.history = []; });
  reject((card) => { card.history[1].id = card.history[0].id; });
  reject((card) => { card.history[1].type = 'delete'; });
  reject((card) => { card.history[1].at = '2026-02-31T00:00:00.000Z'; });
  reject((card) => { card.history[1].at = null; });
  reject((card) => { card.history[0].before = {}; });
  reject((card) => { card.history[1].before = null; });
  reject((card) => { card.history[1].after.laps = 1_000_000; });
  reject((card) => { card.history[1].after.ownerId = 'p9'; });
  reject((card) => { card.history[1].after.ownerName = 'x'.repeat(81); });
  reject((card) => { card.history[1].after.name = 'x'.repeat(121); });
  reject((card) => { card.history[1].after.price = MAX_PRICE + 1; });
  reject((card) => { card.history[1].after.debt = 111; });
  reject((card) => { card.history[1].after.paid = 110; });
  reject((card) => { card.history[1].type = 'transfer'; });
  reject((card) => { card.history[1].before.name = 'unrecorded edit'; });
  reject((card) => { card.history[1].after.status = 'grace'; });
  reject((card) => { card.name = 'not matching final event'; });
  reject((card) => { card.history[1].before.debt = MAX_PRICE * 2 + 1; });
});

test('full history rejects the next action atomically without dropping old events', () => {
  const original = add(add(createGame()), 'p1', 200, 'full');
  const full = original.cards[1];
  for (let index = 1; index < MAX_CARD_HISTORY; index += 1) {
    const before = structuredClone(full.history.at(-1).after);
    const after = { ...before, name: `full-${index}` };
    full.history.push({ id: `edit-${index}`, type: 'editCard', at: full.createdAt, before, after });
    full.name = after.name;
  }
  assert.equal(validateGame(original), original);
  const before = JSON.stringify(original);
  assert.throws(() => lap(original), /۵۰۰/);
  assert.throws(() => action(original, 'editCard', { cardId: full.id, name: 'more', price: 300 }), /۵۰۰/);
  assert.throws(() => action(original, 'settle', { cardId: full.id }), /۵۰۰/);
  assert.equal(JSON.stringify(original), before);
  assert.equal(original.cards[0].laps, 0);
  const oversized = structuredClone(original);
  oversized.cards[1].history.push(structuredClone(full.history.at(-1)));
  assert.throws(() => validateGame(oversized));
});
