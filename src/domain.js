// Exact fractions keep display rounding out of subsequent interest calculations.
export const SCHEMA_VERSION = 3;
export const MAX_PRICE = 9_999_999_999;
export const MAX_CARDS = 500;
export const MAX_CARD_HISTORY = 500;
export const MAX_LAPS = 500;
const MAX_RAW_LAPS = 1_000_000;
const MAX_SETTLEMENT = MAX_PRICE * 2;
const MODELS = new Set(['compound', 'legacy-simple']);
const INTEREST_MODES = new Set(['compound', 'simple']);
const STATUSES = new Set(['active', 'grace', 'auction', 'settled', 'auction_closed']);
const EVENT_TYPES = new Set(['baseline', 'created', 'lap', 'lapAll', 'rulesChanged', 'transfer', 'settle', 'auction', 'closeAuction', 'editCard']);
const SNAPSHOT_FIELDS = ['name', 'price', 'laps', 'accrual', 'ownerId', 'status', 'debt', 'paid'];
const RULE_FIELDS = ['mode', 'compoundRateBps', 'simpleRateBps', 'hardcore'];
const OWNER_IDS = Array.from({ length: 8 }, (_, i) => `p${i + 1}`);
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const fail = (message) => { throw new Error(message); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const validId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 160;
const validText = (value, max) => typeof value === 'string' && value.length <= max;
const validDate = (value) => value === null || (typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const now = () => new Date().toISOString();
const id = () => globalThis.crypto.randomUUID();
const clone = (value) => structuredClone(value);
const latinDigits = (value) => value.replace(/[۰-۹]/g, (digit) => String(FA_DIGITS.indexOf(digit)))
  .replace(/[٠-٩]/g, (digit) => String(AR_DIGITS.indexOf(digit)));
const defaults = (model = 'compound') => ({ mode: model === 'legacy-simple' ? 'simple' : 'compound',
  compoundRateBps: 1000, simpleRateBps: 1000, hardcore: false });

export function parsePrice(value) {
  if (typeof value !== 'string' || value.length > 32) fail('قیمت را با یک عدد صحیح مثبت بنویسید.');
  const text = latinDigits(value.trim()).replace(/[\u00a0\u202f]/g, ' ');
  let digits;
  if (/^\d+$/.test(text)) digits = text;
  else {
    const match = text.match(/^(\d{1,3})([,٬، ])(\d{3})(?:\2\d{3})*$/);
    if (!match) fail('قیمت معتبر نیست؛ عدد صحیح یا گروه‌های سه‌رقمی مثل ۱٬۲۰۰ وارد کنید.');
    digits = text.replace(/[,٬، ]/g, '');
  }
  if (digits.length > 10) fail('قیمت باید بین ۱ و ۹٬۹۹۹٬۹۹۹٬۹۹۹ باشد.');
  const result = Number(digits);
  if (!integer(result, 1, MAX_PRICE)) fail('قیمت باید بین ۱ و ۹٬۹۹۹٬۹۹۹٬۹۹۹ باشد.');
  return result;
}

/** Hundredths of one percent, with no grouping, exponents or signs. */
export function parseRate(value) {
  if (typeof value !== 'string' || value.length > 32) fail('نرخ بهره باید بین صفر و ۱۰۰ درصد با حداکثر دو رقم اعشار باشد.');
  const text = latinDigits(value.trim()).replace(/٫/g, '.');
  const match = text.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) fail('نرخ بهره باید بین صفر و ۱۰۰ درصد با حداکثر دو رقم اعشار باشد.');
  const result = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (!integer(result, 0, 10000)) fail('نرخ بهره باید بین صفر و ۱۰۰ درصد باشد.');
  return result;
}

function validateRules(rules) {
  if (!object(rules) || !INTEREST_MODES.has(rules.mode)
    || !integer(rules.compoundRateBps, 0, 10000) || !integer(rules.simpleRateBps, 0, 10000)
    || typeof rules.hardcore !== 'boolean') fail('نوع یا نرخ بهره و تنظیم هاردکور معتبر نیست.');
  return rules;
}

function plan(card, model) {
  return card.accrual ?? (card.laps ? [{ mode: model === 'legacy-simple' ? 'simple' : 'compound', rateBps: 1000, laps: card.laps }] : []);
}

function validatePlan(card) {
  if (card.accrual === undefined) return;
  if (!Array.isArray(card.accrual) || card.accrual.length > MAX_LAPS) fail('ساختار سابقهٔ بهره معتبر نیست.');
  let laps = 0;
  let previous;
  for (const segment of card.accrual) {
    if (!object(segment) || !INTEREST_MODES.has(segment.mode) || !integer(segment.rateBps, 0, 10000)
      || !integer(segment.laps, 1, MAX_LAPS)
      || (previous && previous.mode === segment.mode && previous.rateBps === segment.rateBps)) {
      fail('نرخ، نوع یا تعداد دور سابقهٔ بهره معتبر نیست.');
    }
    laps += segment.laps;
    if (laps > MAX_LAPS) fail('تعداد دور سابقهٔ بهره خارج از محدوده است.');
    previous = segment;
  }
  if (laps !== card.laps) fail('سابقهٔ بهره با تعداد دور کارت سازگار نیست.');
}

function validateCalculationBounds(card, model) {
  if (!MODELS.has(model) || !object(card) || !integer(card.price, 1, MAX_PRICE)
    || !integer(card.laps, 0, MAX_LAPS)) fail('دادهٔ محاسبهٔ بدهی معتبر نیست.');
  validatePlan(card);
}

function gcd(a, b) {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}
function reduced(numerator, denominator) {
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}
function increment(exact, price, mode, rateBps, laps) {
  if (!laps || !rateBps) return exact;
  const rate = BigInt(rateBps);
  const count = BigInt(laps);
  if (mode === 'compound') return reduced(exact.numerator * ((10000n + rate) ** count),
    exact.denominator * (10000n ** count));
  // Simple interest uses the original mortgage principal, never current debt.
  return reduced(exact.numerator * 20000n + BigInt(price) * rate * count * exact.denominator,
    exact.denominator * 20000n);
}
function fraction(card, model, limit = card.laps) {
  let exact = { numerator: BigInt(card.price), denominator: 2n };
  let remaining = limit;
  for (const segment of plan(card, model)) {
    const laps = Math.min(segment.laps, remaining);
    exact = increment(exact, card.price, segment.mode, segment.rateBps, laps);
    remaining -= laps;
    if (!remaining) break;
  }
  return exact;
}
function halfUp(numerator, denominator) {
  return Number((numerator * 2n + denominator) / (denominator * 2n));
}
const over = (price, exact) => exact.numerator > BigInt(price) * exact.denominator;
const interestRule = (rules) => ({ mode: rules.mode, rateBps: rules.mode === 'compound' ? rules.compoundRateBps : rules.simpleRateBps });

export function calculate(card, model = 'compound', rules) {
  validateCalculationBounds(card, model);
  const liveRules = validateRules(rules ?? defaults(model));
  const exact = fraction(card, model);
  const debt = halfUp(exact.numerator, exact.denominator);
  const loan = halfUp(BigInt(card.price), 2n);
  const isOver = over(card.price, exact);
  const nextRule = interestRule(liveRules);
  return { debt, loan, interest: debt - loan, bid: halfUp(BigInt(card.price), 4n), over: isOver,
    nextOver: over(card.price, increment(exact, card.price, nextRule.mode, nextRule.rateBps, 1)),
    roundedAtLimit: isOver && debt === card.price };
}

export function createGame(names = [], rules = defaults()) {
  if (!Array.isArray(names)) fail('فهرست نام بازیکنان معتبر نیست.');
  validateRules(rules);
  return validateGame({ id: id(), createdAt: now(), model: 'compound', rules: clone(rules),
    players: OWNER_IDS.map((ownerId, index) => ({ id: ownerId, name: names[index] ?? '' })), cards: [] });
}
function cardSnapshot(card, game) {
  return { name: card.name, price: card.price, laps: card.laps, accrual: clone(plan(card, game.model)), ownerId: card.ownerId,
    ownerName: game.players[OWNER_IDS.indexOf(card.ownerId)].name, status: card.status,
    debt: calculate(card, game.model, game.rules).debt, paid: card.status === 'settled' ? card.settlement.amount : null };
}
function sameSnapshot(left, right, fields = SNAPSHOT_FIELDS, model = 'compound') {
  return fields.every((field) => field === 'accrual'
    ? samePlan(plan(left, model), plan(right, model)) : left[field] === right[field]);
}
function samePlan(left, right) {
  return left.length === right.length && left.every((segment, index) => segment.mode === right[index].mode
    && segment.rateBps === right[index].rateBps && segment.laps === right[index].laps);
}
const sameRules = (left, right) => RULE_FIELDS.every((field) => left[field] === right[field]);

function validateSnapshotBounds(snapshot) {
  if (!object(snapshot) || !validText(snapshot.name, 120) || !validText(snapshot.ownerName, 80)
    || !OWNER_IDS.includes(snapshot.ownerId) || !integer(snapshot.price, 1, MAX_PRICE)
    || !integer(snapshot.laps, 0, MAX_LAPS) || !STATUSES.has(snapshot.status)
    || !integer(snapshot.debt, 0, MAX_SETTLEMENT)
    || (snapshot.status === 'settled' ? !integer(snapshot.paid, 0, MAX_SETTLEMENT) : snapshot.paid !== null)) {
    fail('مشخصات یکی از رویدادهای کارت معتبر نیست.');
  }
  validatePlan(snapshot);
}
function validateHistoryBounds(history) {
  if (!Array.isArray(history) || history.length < 1 || history.length > MAX_CARD_HISTORY) fail('تاریخچهٔ کارت باید بین ۱ و ۵۰۰ رویداد داشته باشد.');
  const ids = new Set();
  for (const [index, event] of history.entries()) {
    if (!object(event) || !validId(event.id) || ids.has(event.id) || !EVENT_TYPES.has(event.type)
      || !validDate(event.at) || (event.type === 'baseline' ? event.at !== null : event.at === null)) {
      fail('شناسه، نوع یا زمان یکی از رویدادهای کارت معتبر نیست.');
    }
    ids.add(event.id);
    const initial = ['baseline', 'created'].includes(event.type);
    if ((initial && event.before !== null) || (event.type === 'created' && index !== 0)
      || (!initial && (index === 0 || !object(event.before)))) fail('ترتیب یا مبنای تاریخچهٔ کارت معتبر نیست.');
    if (event.before !== null) validateSnapshotBounds(event.before);
    validateSnapshotBounds(event.after);
    if (['lap', 'lapAll'].includes(event.type)) {
      if (event.interest !== undefined && (!object(event.interest) || !INTEREST_MODES.has(event.interest.mode)
        || !integer(event.interest.rateBps, 0, 10000))) fail('بهرهٔ ثبت‌شده در رویداد معتبر نیست.');
      if (event.interest === undefined && (event.type === 'lapAll'
        || event.before.accrual !== undefined || event.after.accrual !== undefined)) fail('بهرهٔ رویداد دور ثبت نشده است.');
      if (event.triggerOwnerId !== undefined || event.triggerOwnerName !== undefined || event.type === 'lapAll') {
        if (!((event.triggerOwnerId === null && event.triggerOwnerName === null)
          || (OWNER_IDS.includes(event.triggerOwnerId) && validText(event.triggerOwnerName, 80)))) fail('بازیکن آغازکنندهٔ دور معتبر نیست.');
      }
    }
    if (event.type === 'rulesChanged') {
      validateRules(event.rulesBefore);
      validateRules(event.rulesAfter);
      if (sameRules(event.rulesBefore, event.rulesAfter)) fail('تغییر قواعد رویداد خالی است.');
    }
  }
}
function validateStateRules(card, model) {
  const exact = fraction(card, model);
  const isOver = over(card.price, exact);
  // Nonnegative rates make debt monotone: the last-lap prefix determines
  // whether this was the first crossing, for any combination of rule segments.
  if (card.laps > 0 && over(card.price, fraction(card, model, card.laps - 1))) fail('دور مؤثر کارت از اولین عبور از سقف بیشتر است.');
  if (card.status === 'active' && isOver) fail('کارت فعال نمی‌تواند از سقف بدهی گذشته باشد.');
  if (['grace', 'auction', 'auction_closed'].includes(card.status) && !isOver) fail('آخرین شانس و مزایده باید در اولین عبور دقیق از سقف ثابت باشند.');
  return { debt: halfUp(exact.numerator, exact.denominator) };
}
function advancedPlan(card, model, rule) {
  const next = clone(plan(card, model));
  const last = next.at(-1);
  if (last && last.mode === rule.mode && last.rateBps === rule.rateBps) last.laps += 1;
  else next.push({ ...rule, laps: 1 });
  return next;
}
function validateHistory(card, game, allowHistoryGap) {
  if (card.history === undefined) return;
  let previous;
  for (const event of card.history) {
    const { before, after, type } = event;
    for (const snapshot of [before, after]) {
      if (snapshot && validateStateRules(snapshot, game.model).debt !== snapshot.debt) fail('مبلغ رویداد کارت با قیمت و سابقهٔ بهرهٔ آن سازگار نیست.');
    }
    if (previous && type !== 'baseline' && !sameSnapshot(previous, before, SNAPSHOT_FIELDS, game.model)) fail('رویدادهای کارت به ترتیب به هم متصل نیستند.');
    const unchanged = (fields) => sameSnapshot(before, after, fields, game.model);
    const facts = ['name', 'price', 'laps', 'accrual', 'ownerId', 'ownerName'];
    let valid = true;
    switch (type) {
      case 'baseline': break;
      case 'created': valid = after.status === 'active' && after.laps === 0 && after.paid === null; break;
      case 'lap':
      case 'lapAll': {
        const rule = event.interest ?? interestRule(defaults(game.model));
        valid = before.status === 'active' && ['active', 'grace'].includes(after.status)
          && after.laps === before.laps + 1 && unchanged(['name', 'price', 'ownerId', 'ownerName', 'paid'])
          && samePlan(plan(after, game.model), advancedPlan(before, game.model, rule));
        break;
      }
      case 'rulesChanged': valid = before.status === 'active' && unchanged([...SNAPSHOT_FIELDS, 'ownerName']); break;
      case 'transfer': valid = ['active', 'grace'].includes(before.status) && before.ownerId !== after.ownerId
        && unchanged(['name', 'price', 'laps', 'accrual', 'status', 'debt', 'paid']); break;
      case 'settle': valid = ['active', 'grace'].includes(before.status) && after.status === 'settled'
        && after.paid === before.debt && unchanged([...facts, 'debt']); break;
      case 'auction': valid = before.status === 'grace' && after.status === 'auction' && unchanged([...facts, 'debt', 'paid']); break;
      case 'closeAuction': valid = before.status === 'auction' && after.status === 'auction_closed' && unchanged([...facts, 'debt', 'paid']); break;
      case 'editCard': valid = (before.name !== after.name || before.price !== after.price)
        && unchanged(['laps', 'accrual', 'ownerId', 'ownerName', 'status', 'paid']); break;
      default: valid = false;
    }
    if (!valid) fail('تغییر ثبت‌شده با نوع رویداد کارت سازگار نیست.');
    previous = after;
  }
  if (!allowHistoryGap && !sameSnapshot(previous, cardSnapshot(card, game), SNAPSHOT_FIELDS, game.model)) fail('آخرین رویداد کارت با وضعیت فعلی سازگار نیست.');
}

/** Upgrade old 10% saves without inventing past events, names or timestamps. */
export function hydrateGameHistory(game) {
  validateGame(game, { allowHistoryGap: true });
  let hydrated;
  const writable = () => { hydrated ??= clone(game); return hydrated; };
  if (game.rules === undefined) writable().rules = defaults(game.model);
  for (const [index, original] of game.cards.entries()) {
    if (original.accrual === undefined) writable().cards[index].accrual = clone(plan(original, game.model));
    for (const [eventIndex, event] of (original.history ?? []).entries()) {
      for (const side of ['before', 'after']) {
        if (event[side] && event[side].accrual === undefined) writable().cards[index].history[eventIndex][side].accrual = clone(plan(event[side], game.model));
      }
      if (event.type === 'lap' && event.interest === undefined) writable().cards[index].history[eventIndex].interest = interestRule(defaults(game.model));
    }
    const currentGame = hydrated ?? game;
    const current = currentGame.cards[index];
    if (current.history === undefined || !sameSnapshot(current.history.at(-1).after, cardSnapshot(current, currentGame), SNAPSHOT_FIELDS, game.model)) {
      const next = writable().cards[index];
      next.history ??= [];
      appendEvent(next, hydrated, 'baseline', null, null);
    }
  }
  return hydrated ? validateGame(hydrated) : game;
}
function appendEvent(card, game, type, before, at, extra = {}) {
  if (card.history.length >= MAX_CARD_HISTORY) fail('تاریخچهٔ این کارت به سقف ۵۰۰ رویداد رسیده است؛ تغییر ثبت نشد.');
  card.history.push({ id: id(), type, at, before, after: cardSnapshot(card, game), ...clone(extra) });
}

/** Structural preflight is separate so imports can check every game first. */
export function validateGameBounds(game) {
  if (!object(game) || !validId(game.id) || !validDate(game.createdAt) || !MODELS.has(game.model)) fail('ساختار یا نسخهٔ قواعد بازی معتبر نیست.');
  if (game.rules !== undefined) validateRules(game.rules);
  if (!Array.isArray(game.players) || game.players.length !== 8
    || game.players.some((player, index) => !object(player) || player.id !== OWNER_IDS[index]
      || !validText(player.name, 80))) fail('بازی باید هشت جایگاه معتبر با نام حداکثر ۸۰ نویسه داشته باشد.');
  if (!Array.isArray(game.cards) || game.cards.length > MAX_CARDS) fail('تعداد یا ساختار کارت‌ها معتبر نیست؛ حداکثر ۵۰۰ کارت.');
  if (game.migration !== undefined && (!object(game.migration) || game.migration.source !== 'monopoly-mortgage-v1'
    || typeof game.migration.compoundDefaulted !== 'boolean')) fail('اطلاعات مهاجرت معتبر نیست.');
  const ids = new Set();
  // Preflight EVERY card and snapshot before computing ANY BigInt power.
  for (const card of game.cards) {
    if (!object(card) || !validId(card.id) || ids.has(card.id)) fail('شناسهٔ کارت نامعتبر یا تکراری است.');
    ids.add(card.id);
    if (!OWNER_IDS.includes(card.ownerId)) fail('صاحب کارت معتبر نیست.');
    if (!validText(card.name, 120)) fail('نام کارت باید حداکثر ۱۲۰ نویسه باشد.');
    if (!integer(card.price, 1, MAX_PRICE) || !integer(card.laps, 0, MAX_LAPS)) fail('قیمت یا تعداد دور کارت خارج از محدوده است.');
    validatePlan(card);
    if (!STATUSES.has(card.status) || !validDate(card.createdAt)) fail('وضعیت یا زمان کارت معتبر نیست.');
    if (card.legacy !== undefined && (!object(card.legacy) || !integer(card.legacy.rawLaps, 0, MAX_RAW_LAPS))) fail('تعداد دور تاریخی کارت معتبر نیست.');
    if (card.status === 'settled') {
      if (!object(card.settlement) || !integer(card.settlement.amount, 0, MAX_SETTLEMENT)
        || !OWNER_IDS.includes(card.settlement.ownerId) || !validDate(card.settlement.at)) fail('سابقهٔ تسویهٔ کارت معتبر نیست.');
    } else if (card.settlement !== undefined) fail('مبلغ تسویه با وضعیت کارت سازگار نیست.');
    if (card.status === 'auction_closed') {
      if (!validDate(card.closedAt)) fail('زمان بستن مزایده معتبر نیست.');
    } else if (card.closedAt !== undefined) fail('سابقهٔ بستن مزایده با وضعیت کارت سازگار نیست.');
    if (card.history !== undefined) validateHistoryBounds(card.history);
  }
  return game;
}
export function validateGame(game, { allowHistoryGap = false } = {}) {
  validateGameBounds(game);
  for (const card of game.cards) {
    validateStateRules(card, game.model);
    validateHistory(card, game, allowHistoryGap);
  }
  return game;
}

const ownerBlocked = (game, ownerId) => game.cards.some((card) => card.ownerId === ownerId && card.status === 'grace');
const eligibleCard = (game, card) => card.status === 'active' && !ownerBlocked(game, card.ownerId);
export function canLapAll(game) { return game.cards.some((card) => eligibleCard(game, card)); }
export function canLap(game, ownerId) {
  return OWNER_IDS.includes(ownerId) && !ownerBlocked(game, ownerId)
    && (game.rules?.hardcore ? canLapAll(game) : game.cards.some((card) => card.ownerId === ownerId && eligibleCard(game, card)));
}

export function applyAction(game, action) {
  if (!object(action)) return game;
  const owner = OWNER_IDS.includes(action.ownerId);
  const cardIndex = game.cards.findIndex((card) => card.id === action.cardId);
  const card = game.cards[cardIndex];
  const prepare = () => clone(hydrateGameHistory(game));
  const at = now();
  let updated;
  switch (action.type) {
    case 'rename': {
      if (!owner) return game;
      if (!validText(action.name, 80)) fail('نام بازیکن باید حداکثر ۸۰ نویسه باشد.');
      const index = OWNER_IDS.indexOf(action.ownerId);
      if (game.players[index].name === action.name) return game;
      updated = prepare();
      updated.players[index].name = action.name;
      break;
    }
    case 'setRules': {
      if (!object(action.rules) || Object.keys(action.rules).some((key) => !RULE_FIELDS.includes(key))) fail('تنظیم بهره معتبر نیست.');
      const beforeRules = game.rules ?? defaults(game.model);
      const afterRules = validateRules({ ...beforeRules, ...action.rules });
      if (sameRules(beforeRules, afterRules)) return game;
      updated = prepare();
      updated.rules = clone(afterRules);
      for (const current of updated.cards) {
        if (current.status === 'active') appendEvent(current, updated, 'rulesChanged', cardSnapshot(current, updated), at,
          { rulesBefore: beforeRules, rulesAfter: afterRules });
      }
      break;
    }
    case 'add': {
      if (!owner) fail('صاحب کارت را انتخاب کنید.');
      if (!integer(action.price, 1, MAX_PRICE)) fail('قیمت باید یک عدد صحیح مثبت در محدودهٔ مجاز باشد.');
      if (!validText(action.name, 120)) fail('نام کارت باید حداکثر ۱۲۰ نویسه باشد.');
      if (game.cards.length >= MAX_CARDS) fail('حداکثر ۵۰۰ کارت در یک بازی قابل ثبت است.');
      updated = prepare();
      const created = { id: id(), ownerId: action.ownerId,
        name: action.name.trim() || `کارت ${String(game.cards.length + 1).replace(/\d/g, (digit) => FA_DIGITS[digit])}`,
        price: action.price, laps: 0, accrual: [], status: 'active', createdAt: at, history: [] };
      appendEvent(created, updated, 'created', null, at);
      updated.cards.push(created);
      break;
    }
    case 'lap':
    case 'lapAll': {
      if (action.type === 'lap' ? !canLap(game, action.ownerId) : !canLapAll(game)) return game;
      const collective = action.type === 'lapAll' || Boolean(game.rules?.hardcore);
      // Decide eligibility first: one newly crossing card cannot block siblings.
      const affected = new Set(game.cards.filter((current) => eligibleCard(game, current)
        && (collective || current.ownerId === action.ownerId)).map((current) => current.id));
      if (game.cards.some((current) => affected.has(current.id) && current.laps >= MAX_LAPS)) {
        fail('یکی از کارت‌ها به سقف ۵۰۰ دور رسیده است؛ هیچ دوری ثبت نشد.');
      }
      updated = prepare();
      const rule = interestRule(updated.rules);
      for (const current of updated.cards) {
        if (!affected.has(current.id)) continue;
        const before = cardSnapshot(current, updated);
        current.accrual = advancedPlan(current, updated.model, rule);
        current.laps += 1;
        if (calculate(current, updated.model, updated.rules).over) current.status = 'grace';
        const extra = { interest: rule };
        if (collective) {
          extra.triggerOwnerId = action.type === 'lap' ? action.ownerId : null;
          extra.triggerOwnerName = action.type === 'lap' ? updated.players[OWNER_IDS.indexOf(action.ownerId)].name : null;
        }
        appendEvent(current, updated, collective ? 'lapAll' : 'lap', before, at, extra);
      }
      break;
    }
    case 'transfer': {
      if (!card || !owner || card.ownerId === action.ownerId || !['active', 'grace'].includes(card.status)) return game;
      updated = prepare();
      const before = cardSnapshot(updated.cards[cardIndex], updated);
      updated.cards[cardIndex].ownerId = action.ownerId;
      appendEvent(updated.cards[cardIndex], updated, 'transfer', before, at);
      break;
    }
    case 'settle': {
      if (!card || !['active', 'grace'].includes(card.status)) return game;
      updated = prepare();
      const before = cardSnapshot(updated.cards[cardIndex], updated);
      updated.cards[cardIndex].status = 'settled';
      updated.cards[cardIndex].settlement = { amount: before.debt, ownerId: card.ownerId, at };
      appendEvent(updated.cards[cardIndex], updated, 'settle', before, at);
      break;
    }
    case 'auction': {
      if (!card || card.status !== 'grace') return game;
      updated = prepare();
      const before = cardSnapshot(updated.cards[cardIndex], updated);
      updated.cards[cardIndex].status = 'auction';
      appendEvent(updated.cards[cardIndex], updated, 'auction', before, at);
      break;
    }
    case 'closeAuction': {
      if (!card || card.status !== 'auction') return game;
      updated = prepare();
      const before = cardSnapshot(updated.cards[cardIndex], updated);
      updated.cards[cardIndex].status = 'auction_closed';
      updated.cards[cardIndex].closedAt = at;
      appendEvent(updated.cards[cardIndex], updated, 'closeAuction', before, at);
      break;
    }
    case 'editCard': {
      if (!card) return game;
      if (!validText(action.name, 120)) fail('نام کارت باید حداکثر ۱۲۰ نویسه باشد.');
      if (!integer(action.price, 1, MAX_PRICE)) fail('قیمت باید یک عدد صحیح مثبت در محدودهٔ مجاز باشد.');
      const name = action.name.trim();
      if (!name) fail('نام کارت را وارد کنید.');
      if (name === card.name && action.price === card.price) return game;
      updated = prepare();
      const current = updated.cards[cardIndex];
      const before = cardSnapshot(current, updated);
      current.name = name;
      current.price = action.price;
      appendEvent(current, updated, 'editCard', before, at);
      break;
    }
    default: return game;
  }
  return validateGame(updated);
}

export function migrateLegacy(raw) {
  if (!object(raw) || !Array.isArray(raw.players) || raw.players.length !== 8
    || raw.players.some((name) => !validText(name, 80)) || !Array.isArray(raw.cards)
    || raw.cards.length > MAX_CARDS) fail('ساختار دفتر قدیمی معتبر نیست؛ نسخهٔ خام را نگه دارید.');
  if (raw.seq !== undefined && !integer(raw.seq, 0, MAX_RAW_LAPS)) fail('شمارهٔ ثبت دفتر قدیمی معتبر نیست.');
  const compoundDefaulted = typeof raw.compound !== 'boolean';
  const model = raw.compound === false ? 'legacy-simple' : 'compound';
  const limit = model === 'compound' ? 8 : 11;
  const ids = new Set();
  for (const card of raw.cards) {
    if (!object(card) || !validId(card.id) || ids.has(card.id)
      || !integer(card.p, 0, 7) || !validText(card.name, 120)
      || !integer(card.price, 1, MAX_PRICE) || !integer(card.laps, 0, MAX_RAW_LAPS)
      || typeof card.auction !== 'boolean' || (card.paid != null && !integer(card.paid, 0, MAX_SETTLEMENT))) {
      fail('کارت قدیمی ناقص یا نامعتبر است؛ بدون تغییر مالی، نسخهٔ خام را نگه دارید.');
    }
    ids.add(card.id);
  }
  const game = { id: id(), createdAt: null, model,
    players: OWNER_IDS.map((ownerId, index) => ({ id: ownerId, name: raw.players[index] })),
    migration: { source: 'monopoly-mortgage-v1', compoundDefaulted },
    cards: raw.cards.map((old) => {
      const card = { id: old.id, ownerId: OWNER_IDS[old.p], name: old.name,
        price: old.price, laps: Math.min(old.laps, limit), status: 'active', createdAt: null, legacy: { rawLaps: old.laps } };
      if (old.paid != null) {
        card.status = 'settled';
        card.settlement = { amount: old.paid, ownerId: card.ownerId, at: null };
      } else if (old.auction) card.status = 'auction';
      else if (calculate(card, model).over) card.status = 'grace';
      return card;
    }) };
  return hydrateGameHistory(game);
}
