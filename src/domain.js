// All money comes from these exact rational calculations. Rounded values never
// become the basis of the next lap.
export const SCHEMA_VERSION = 2;
export const MAX_PRICE = 9_999_999_999;
export const MAX_CARDS = 500;
const MAX_RAW_LAPS = 1_000_000;
const MAX_SETTLEMENT = MAX_PRICE * 2;
const MODELS = new Set(['compound', 'legacy-simple']);
const STATUSES = new Set(['active', 'grace', 'auction', 'settled', 'auction_closed']);
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

export function parsePrice(value) {
  if (typeof value !== 'string' || value.length > 32) fail('قیمت را با یک عدد صحیح مثبت بنویسید.');
  const text = value.trim()
    .replace(/[۰-۹]/g, (digit) => String(FA_DIGITS.indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String(AR_DIGITS.indexOf(digit)))
    .replace(/[\u00a0\u202f]/g, ' ');
  // Grouping must be complete and consistent: 1,234 or 1 234, never 1,23.
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

function fraction(price, laps, model) {
  const p = BigInt(price);
  if (model === 'legacy-simple') return { numerator: p * BigInt(10 + laps), denominator: 20n };
  const n = BigInt(laps);
  return { numerator: p * (11n ** n), denominator: 2n * (10n ** n) };
}

function halfUp(numerator, denominator) {
  return Number((numerator * 2n + denominator) / (denominator * 2n));
}

function over(price, laps, model) {
  const { numerator, denominator } = fraction(price, laps, model);
  return numerator > BigInt(price) * denominator;
}

export function calculate(card, model = 'compound') {
  if (!MODELS.has(model) || !object(card) || !integer(card.price, 1, MAX_PRICE)
    || !integer(card.laps, 0, 11)) fail('دادهٔ محاسبهٔ بدهی معتبر نیست.');
  const exact = fraction(card.price, card.laps, model);
  const debt = halfUp(exact.numerator, exact.denominator);
  const loan = halfUp(BigInt(card.price), 2n);
  const isOver = exact.numerator > BigInt(card.price) * exact.denominator;
  return {
    debt,
    loan,
    // This display difference keeps displayed totals consistent; it never
    // feeds back into the exact interest calculation.
    interest: debt - loan,
    bid: halfUp(BigInt(card.price), 4n),
    over: isOver,
    nextOver: over(card.price, card.laps + 1, model),
    roundedAtLimit: isOver && debt === card.price,
  };
}

export function createGame(names = []) {
  if (!Array.isArray(names)) fail('فهرست نام بازیکنان معتبر نیست.');
  const game = {
    id: id(),
    createdAt: now(),
    model: 'compound',
    players: OWNER_IDS.map((ownerId, index) => ({ id: ownerId, name: names[index] ?? '' })),
    cards: [],
  };
  return validateGame(game);
}

export function validateGame(game) {
  if (!object(game) || !validId(game.id) || !validDate(game.createdAt) || !MODELS.has(game.model)) {
    fail('ساختار یا نسخهٔ قواعد بازی معتبر نیست.');
  }
  if (!Array.isArray(game.players) || game.players.length !== 8
    || game.players.some((player, index) => !object(player) || player.id !== OWNER_IDS[index]
      || !validText(player.name, 80))) fail('بازی باید هشت جایگاه معتبر با نام حداکثر ۸۰ نویسه داشته باشد.');
  if (!Array.isArray(game.cards) || game.cards.length > MAX_CARDS) fail('تعداد یا ساختار کارت‌ها معتبر نیست؛ حداکثر ۵۰۰ کارت.');
  if (game.migration !== undefined && (!object(game.migration)
    || game.migration.source !== 'monopoly-mortgage-v1'
    || typeof game.migration.compoundDefaulted !== 'boolean')) fail('اطلاعات مهاجرت معتبر نیست.');
  const ids = new Set();
  // Bounds and identity are validated for every card before any BigInt power.
  for (const card of game.cards) {
    if (!object(card) || !validId(card.id) || ids.has(card.id)) fail('شناسهٔ کارت نامعتبر یا تکراری است.');
    ids.add(card.id);
    if (!OWNER_IDS.includes(card.ownerId)) fail('صاحب کارت معتبر نیست.');
    if (!validText(card.name, 120)) fail('نام کارت باید حداکثر ۱۲۰ نویسه باشد.');
    if (!integer(card.price, 1, MAX_PRICE) || !integer(card.laps, 0, 11)) fail('قیمت یا تعداد دور کارت خارج از محدوده است.');
    if (!STATUSES.has(card.status) || !validDate(card.createdAt)) fail('وضعیت یا زمان کارت معتبر نیست.');
    if (card.legacy !== undefined && (!object(card.legacy)
      || !integer(card.legacy.rawLaps, 0, MAX_RAW_LAPS))) fail('تعداد دور تاریخی کارت معتبر نیست.');
    if (card.status === 'settled') {
      if (!object(card.settlement) || !integer(card.settlement.amount, 0, MAX_SETTLEMENT)
        || !OWNER_IDS.includes(card.settlement.ownerId) || !validDate(card.settlement.at)) fail('سابقهٔ تسویهٔ کارت معتبر نیست.');
    } else if (card.settlement !== undefined) fail('مبلغ تسویه با وضعیت کارت سازگار نیست.');
    if (card.status === 'auction_closed') {
      if (!validDate(card.closedAt)) fail('زمان بستن مزایده معتبر نیست.');
    } else if (card.closedAt !== undefined) fail('سابقهٔ بستن مزایده با وضعیت کارت سازگار نیست.');
  }
  for (const card of game.cards) {
    const firstOver = game.model === 'compound' ? 8 : 11;
    if (card.laps > firstOver) fail('دور مؤثر کارت از اولین عبور از سقف بیشتر است.');
    const money = calculate(card, game.model);
    if (card.status === 'active' && money.over) fail('کارت فعال نمی‌تواند از سقف بدهی گذشته باشد.');
    if (['grace', 'auction', 'auction_closed'].includes(card.status)
      && (!money.over || (card.laps > 0 && over(card.price, card.laps - 1, game.model)))) {
      fail('آخرین شانس و مزایده باید در اولین عبور دقیق از سقف ثابت باشند.');
    }
  }
  return game;
}

export function canLap(game, ownerId) {
  return OWNER_IDS.includes(ownerId)
    && !game.cards.some((card) => card.ownerId === ownerId && card.status === 'grace')
    && game.cards.some((card) => card.ownerId === ownerId && card.status === 'active');
}

export function applyAction(game, action) {
  if (!object(action)) return game;
  const owner = OWNER_IDS.includes(action.ownerId);
  const cardIndex = game.cards.findIndex((card) => card.id === action.cardId);
  const card = game.cards[cardIndex];
  let updated;
  switch (action.type) {
    case 'rename': {
      if (!owner) return game;
      if (!validText(action.name, 80)) fail('نام بازیکن باید حداکثر ۸۰ نویسه باشد.');
      const index = OWNER_IDS.indexOf(action.ownerId);
      if (game.players[index].name === action.name) return game;
      updated = clone(game);
      updated.players[index].name = action.name;
      break;
    }
    case 'add': {
      if (!owner) fail('صاحب کارت را انتخاب کنید.');
      if (!integer(action.price, 1, MAX_PRICE)) fail('قیمت باید یک عدد صحیح مثبت در محدودهٔ مجاز باشد.');
      if (!validText(action.name, 120)) fail('نام کارت باید حداکثر ۱۲۰ نویسه باشد.');
      if (game.cards.length >= MAX_CARDS) fail('حداکثر ۵۰۰ کارت در یک بازی قابل ثبت است.');
      updated = clone(game);
      updated.cards.push({ id: id(), ownerId: action.ownerId,
        name: action.name.trim() || `کارت ${String(game.cards.length + 1).replace(/\d/g, (digit) => FA_DIGITS[digit])}`,
        price: action.price, laps: 0, status: 'active', createdAt: now() });
      break;
    }
    case 'lap': {
      if (!canLap(game, action.ownerId)) return game;
      updated = clone(game);
      for (const current of updated.cards) {
        if (current.ownerId === action.ownerId && current.status === 'active') {
          current.laps += 1;
          if (calculate(current, game.model).over) current.status = 'grace';
        }
      }
      break;
    }
    case 'transfer': {
      if (!card || !owner || card.ownerId === action.ownerId || !['active', 'grace'].includes(card.status)) return game;
      updated = clone(game);
      updated.cards[cardIndex].ownerId = action.ownerId;
      break;
    }
    case 'settle': {
      if (!card || !['active', 'grace'].includes(card.status)) return game;
      updated = clone(game);
      updated.cards[cardIndex].status = 'settled';
      updated.cards[cardIndex].settlement = { amount: calculate(card, game.model).debt, ownerId: card.ownerId, at: now() };
      break;
    }
    case 'auction': {
      if (!card || card.status !== 'grace') return game;
      updated = clone(game);
      updated.cards[cardIndex].status = 'auction';
      break;
    }
    case 'closeAuction': {
      if (!card || card.status !== 'auction') return game;
      updated = clone(game);
      updated.cards[cardIndex].status = 'auction_closed';
      updated.cards[cardIndex].closedAt = now();
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
  // Legacy input gets the same preflight before its first calculation.
  for (const card of raw.cards) {
    if (!object(card) || !validId(card.id) || ids.has(card.id)
      || !integer(card.p, 0, 7) || !validText(card.name, 120)
      || !integer(card.price, 1, MAX_PRICE) || !integer(card.laps, 0, MAX_RAW_LAPS)
      || typeof card.auction !== 'boolean'
      || (card.paid != null && !integer(card.paid, 0, MAX_SETTLEMENT))) {
      fail('کارت قدیمی ناقص یا نامعتبر است؛ بدون تغییر مالی، نسخهٔ خام را نگه دارید.');
    }
    ids.add(card.id);
  }
  const game = {
    id: id(), createdAt: null, model,
    players: OWNER_IDS.map((ownerId, index) => ({ id: ownerId, name: raw.players[index] })),
    migration: { source: 'monopoly-mortgage-v1', compoundDefaulted },
    cards: raw.cards.map((old) => {
      const card = { id: old.id, ownerId: OWNER_IDS[old.p], name: old.name,
        price: old.price, laps: Math.min(old.laps, limit), status: 'active', createdAt: null,
        legacy: { rawLaps: old.laps } };
      if (old.paid != null) {
        card.status = 'settled';
        card.settlement = { amount: old.paid, ownerId: card.ownerId, at: null };
      } else if (old.auction) card.status = 'auction';
      else if (calculate(card, model).over) card.status = 'grace';
      return card;
    }),
  };
  return validateGame(game);
}
