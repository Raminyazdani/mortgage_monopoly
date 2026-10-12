import { SCHEMA_VERSION, createGame, validateGame, migrateLegacy } from './domain.js';

export const DB_NAME = 'monopoly-mortgage-ledger-v2';
export const STORE_NAME = 'ledger';
export const CURRENT_KEY = 'current';
export const LEGACY_KEY = 'monopoly-mortgage-v1';
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
export const MAX_LEGACY_BYTES = 5 * 1024 * 1024;
export const MAX_UNDO = 50;
export const MAX_ARCHIVES = 30;
const MAX_TOTAL_CARDS = (1 + MAX_UNDO + MAX_ARCHIVES) * 500;
const NOTIFY_KEY = 'monopoly-mortgage-ledger-notify-v2';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = value => structuredClone(value);
const uid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export class StorageError extends Error {
  constructor(message, code = 'STORAGE', cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'StorageError';
    this.code = code;
  }
}

export class ConflictError extends StorageError {
  constructor(latest) {
    super('دفتر در تب دیگری تغییر کرده است. پیش از ادامه نسخهٔ تازه را بخوانید.', 'CONFLICT');
    this.name = 'ConflictError';
    this.latest = latest;
  }
}

export function createEnvelope(game = createGame()) {
  validateGame(game);
  return { schemaVersion: SCHEMA_VERSION, revision: 0, game: copy(game), undo: [], archives: [] };
}

/** Validate every snapshot before domain arithmetic, including historical games. */
export function validateEnvelope(envelope) {
  if (!isObject(envelope)) throw new StorageError('ساختار دفتر معتبر نیست.', 'INVALID_DATA');
  if (envelope.schemaVersion !== SCHEMA_VERSION) {
    const message = envelope.schemaVersion > SCHEMA_VERSION
      ? 'این فایل با نسخهٔ جدیدتری ساخته شده است؛ با این نسخه قابل بازیابی نیست.'
      : 'نسخهٔ ساختار دفتر پشتیبانی نمی‌شود.';
    throw new StorageError(message, 'UNKNOWN_SCHEMA');
  }
  if (!Number.isSafeInteger(envelope.revision) || envelope.revision < 0 || envelope.revision >= Number.MAX_SAFE_INTEGER) {
    throw new StorageError('شمارهٔ نسخهٔ ذخیره معتبر نیست.', 'INVALID_DATA');
  }
  if (!Array.isArray(envelope.undo) || envelope.undo.length > MAX_UNDO) {
    throw new StorageError(`تاریخچه باید حداکثر ${MAX_UNDO} اقدام داشته باشد.`, 'INVALID_DATA');
  }
  if (!Array.isArray(envelope.archives) || envelope.archives.length > MAX_ARCHIVES) {
    throw new StorageError(`بایگانی باید حداکثر ${MAX_ARCHIVES} بازی داشته باشد؛ ابتدا خروجی بگیرید.`, 'INVALID_DATA');
  }
  if (envelope.legacyRaw !== undefined && (typeof envelope.legacyRaw !== 'string' || byteLength(envelope.legacyRaw) > MAX_LEGACY_BYTES)) {
    throw new StorageError('نسخهٔ خام بازی قدیمی معتبر نیست یا بیش‌ازحد بزرگ است.', 'INVALID_DATA');
  }
  const games = [envelope.game, ...envelope.archives];
  for (const entry of envelope.undo) {
    if (!isObject(entry) || typeof entry.label !== 'string' || entry.label.length > 200) {
      throw new StorageError('یکی از موارد تاریخچه معتبر نیست.', 'INVALID_DATA');
    }
    games.push(entry.game);
  }
  if (envelope.exportId !== undefined && (typeof envelope.exportId !== 'string' || envelope.exportId.length < 1 || envelope.exportId.length > 160)) {
    throw new StorageError('شناسهٔ فایل خروجی معتبر نیست.', 'INVALID_DATA');
  }
  if (envelope.exportedAt !== undefined && (typeof envelope.exportedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(envelope.exportedAt)
    || !Number.isFinite(Date.parse(envelope.exportedAt)))) {
    throw new StorageError('زمان فایل خروجی معتبر نیست.', 'INVALID_DATA');
  }
  let cards = 0;
  // This pass must finish before calling a domain validator that computes debt.
  for (const game of games) {
    if (!isObject(game) || !Array.isArray(game.cards) || game.cards.length > 500) {
      throw new StorageError('ساختار یا تعداد کارت‌های یکی از بازی‌ها معتبر نیست.', 'INVALID_DATA');
    }
    cards += game.cards.length;
  }
  if (cards > MAX_TOTAL_CARDS) throw new StorageError('تعداد کل کارت‌ها بیش‌ازحد بزرگ است.', 'INVALID_DATA');
  for (const game of games) {
    try { validateGame(game); }
    catch (cause) { throw new StorageError(cause.message, 'INVALID_DATA', cause); }
  }
  for (const entry of envelope.undo) {
    if (entry.game.id !== envelope.game.id) {
      throw new StorageError('تاریخچه متعلق به همین بازی جاری نیست.', 'INVALID_DATA');
    }
  }
  // Reserve more than the maximum export metadata so every accepted snapshot
  // can be exported and reimported, even with all undo/archive records present.
  let serialized;
  try {
    serialized = JSON.stringify({ schemaVersion: envelope.schemaVersion, revision: envelope.revision,
      game: envelope.game, undo: envelope.undo, archives: envelope.archives,
      ...(envelope.legacyRaw !== undefined ? { legacyRaw: envelope.legacyRaw } : {}) }, null, 2);
  } catch (cause) { throw new StorageError('ساختار دفتر قابل خروجی JSON نیست.', 'INVALID_DATA', cause); }
  if (byteLength(serialized) > MAX_IMPORT_BYTES - 1024) {
    throw new StorageError('حجم کامل دفتر بیش‌ازحد بزرگ است؛ حداکثر فایل بازیابی ۶۴ مگابایت است.', 'INVALID_DATA');
  }
  return envelope;
}

function byteLength(text) {
  if (text.length > MAX_IMPORT_BYTES) return MAX_IMPORT_BYTES + 1;
  return new TextEncoder().encode(text).byteLength;
}

function parseJSON(text) {
  if (typeof text !== 'string' || byteLength(text) > MAX_IMPORT_BYTES) {
    throw new StorageError('فایل باید JSON متنی و حداکثر ۶۴ مگابایت باشد.', 'INVALID_DATA');
  }
  try { return JSON.parse(text); }
  catch (cause) { throw new StorageError('فایل JSON خراب است؛ دفتر فعلی تغییر نکرد.', 'INVALID_DATA', cause); }
}

function normalized(envelope) {
  validateEnvelope(envelope);
  const result = {
    schemaVersion: SCHEMA_VERSION,
    revision: envelope.revision,
    game: envelope.game,
    undo: envelope.undo,
    archives: envelope.archives,
  };
  if (envelope.legacyRaw !== undefined) result.legacyRaw = envelope.legacyRaw;
  return copy(result);
}

export function parseImport(text) {
  const raw = parseJSON(text);
  if (!isObject(raw)) throw new StorageError('ساختار فایل بازی معتبر نیست.', 'INVALID_DATA');
  if (raw.schemaVersion !== undefined) return normalized(raw);
  if (byteLength(text) > MAX_LEGACY_BYTES) {
    throw new StorageError('فایل قدیمی باید حداکثر ۵ مگابایت باشد.', 'INVALID_DATA');
  }
  // Bound legacy input before migration and its BigInt calculations.
  if (!Array.isArray(raw.players) || raw.players.length !== 8 || !Array.isArray(raw.cards) || raw.cards.length > 500) {
    throw new StorageError('ساختار بازی قدیمی معتبر نیست.', 'INVALID_DATA');
  }
  let game;
  try { game = migrateLegacy(raw); }
  catch (cause) { throw new StorageError(cause.message, 'INVALID_DATA', cause); }
  const envelope = createEnvelope(game);
  envelope.legacyRaw = text;
  return envelope;
}

export function exportEnvelope(envelope) {
  const valid = normalized(envelope);
  return JSON.stringify({ ...valid, exportId: uid(), exportedAt: new Date().toISOString() }, null, 2);
}

function persistenceError(cause) {
  if (cause instanceof StorageError) return cause;
  const isQuota = cause?.name === 'QuotaExceededError';
  const message = isQuota
    ? 'فضای ذخیرهٔ مرورگر پر شده است. تغییر هنوز ذخیره نشده؛ خروجی بگیرید یا دوباره تلاش کنید.'
    : 'ذخیرهٔ مرورگر در دسترس نیست یا نوشتن انجام نشد. تغییر هنوز ذخیره نشده است.';
  return new StorageError(message, isQuota ? 'QUOTA' : 'STORAGE', cause);
}

/**
 * One read/write IndexedDB transaction serializes revision checks and writes.
 * Notifications only announce a change; they never replace pending UI state.
 */
export class LedgerStore {
  constructor(options = {}) {
    this.dbName = options.dbName ?? DB_NAME;
    this.onChange = options.onChange;
    this.lastGood = null;
    this.pending = null;
    this._idbOption = options.indexedDB;
    this._localOption = options.localStorage;
    this._channelOption = options.BroadcastChannel;
    this._tabId = uid();
    this._db = null;
    this._opening = null;
    this._raw = undefined;
    this._legacyRaw = null;
    this._recoverable = false;
    this._closed = false;
  }

  _local() { return this._localOption === undefined ? globalThis.localStorage : this._localOption; }

  async _open() {
    if (this._closed) throw new StorageError('این نشست ذخیره‌سازی بسته شده است.', 'CLOSED');
    if (this._db) return this._db;
    if (this._opening) return this._opening;
    this._opening = new Promise((resolve, reject) => {
      let request;
      let settled = false;
      try {
        const idb = this._idbOption ?? globalThis.indexedDB;
        if (!idb) throw new Error('IndexedDB unavailable');
        request = idb.open(this.dbName, 1);
      } catch (cause) { reject(persistenceError(cause)); return; }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
      };
      request.onerror = () => { settled = true; reject(persistenceError(request.error)); };
      request.onblocked = () => {
        settled = true;
        reject(new StorageError('ذخیره‌سازی توسط تب قدیمی مسدود شده است؛ آن تب را ببندید و دوباره تلاش کنید.', 'BLOCKED'));
      };
      request.onsuccess = () => {
        if (settled || this._closed) { request.result.close(); return; }
        this._db = request.result;
        this._db.onversionchange = () => {
          this._db?.close();
          this._db = null;
          this._opening = null;
          this._emit({ type: 'versionchange' });
        };
        this._subscribe();
        resolve(this._db);
      };
    });
    try { return await this._opening; }
    catch (cause) { this._opening = null; throw cause; }
  }

  _subscribe() {
    if (this._subscribed) return;
    this._subscribed = true;
    try {
      const Channel = this._channelOption === undefined ? globalThis.BroadcastChannel : this._channelOption;
      if (Channel) {
        this._channel = new Channel(`${this.dbName}:changes`);
        this._channel.onmessage = event => {
          if (event.data?.tabId !== this._tabId) this._emit({ type: 'external-change', revision: event.data?.revision });
        };
      }
    } catch { /* Revision transactions still prevent lost updates. */ }
    this._storageListener = event => {
      if (event.key === NOTIFY_KEY && event.newValue) {
        try {
          const notification = JSON.parse(event.newValue);
          if (notification.dbName === this.dbName && notification.tabId !== this._tabId) {
            this._emit({ type: 'external-change', revision: notification.revision });
          }
        } catch { /* Ignore unrelated/invalid notifications. */ }
      }
    };
    globalThis.addEventListener?.('storage', this._storageListener);
    this._focusListener = async () => {
      // Fallback when BroadcastChannel/storage notices are unavailable; do not
      // announce a conflict merely because the user returns to the window.
      try {
        const latest = normalized(await this._readCurrent());
        if (!this.lastGood || latest.revision !== this.lastGood.revision || latest.game.id !== this.lastGood.game.id) {
          this._emit({ type: 'external-change', revision: latest.revision });
        }
      } catch { /* Normal reload/save paths report persistence failures. */ }
    };
    globalThis.addEventListener?.('focus', this._focusListener);
  }

  _emit(event) {
    try { this.onChange?.(event); } catch { /* UI callback cannot undo a committed save. */ }
  }

  _announce(envelope) {
    const notification = { tabId: this._tabId, dbName: this.dbName, revision: envelope.revision, nonce: uid() };
    try { this._channel?.postMessage(notification); } catch { /* Commit is already durable. */ }
    if (!this._channel) {
      try { this._local()?.setItem(NOTIFY_KEY, JSON.stringify(notification)); } catch { /* Optional notice only. */ }
    }
  }

  async _readCurrent() {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(CURRENT_KEY);
      let raw;
      request.onsuccess = () => { raw = request.result; };
      tx.oncomplete = () => resolve(raw);
      tx.onerror = tx.onabort = () => reject(persistenceError(tx.error ?? request.error));
    });
  }

  async init() {
    try {
      const raw = await this._readCurrent();
      this._raw = raw;
      if (raw !== undefined) return this._accept(normalized(raw));
      this._legacyRaw = this._local()?.getItem(LEGACY_KEY) ?? null;
      let candidate;
      if (this._legacyRaw !== null) candidate = parseImport(this._legacyRaw);
      else candidate = createEnvelope();
      const db = await this._open();
      const saved = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const get = store.get(CURRENT_KEY);
        let result;
        let failure;
        get.onsuccess = () => {
          try {
            if (get.result !== undefined) {
              this._raw = get.result;
              result = normalized(get.result);
            }
            else {
              if (this._legacyRaw !== null) store.put({ raw: this._legacyRaw, preservedAt: new Date().toISOString() }, 'legacy-raw');
              result = normalized(candidate);
              store.put(result, CURRENT_KEY);
            }
          } catch (cause) { failure = cause; tx.abort(); }
        };
        tx.oncomplete = () => resolve(result);
        tx.onerror = tx.onabort = () => reject(persistenceError(failure ?? tx.error ?? get.error));
      });
      this._raw = saved;
      return this._accept(saved);
    } catch (cause) {
      this._recoverable = this._raw !== undefined || this._legacyRaw !== null;
      throw persistenceError(cause);
    }
  }

  _accept(envelope) {
    this.lastGood = copy(envelope);
    this.pending = null;
    this._recoverable = false;
    return copy(envelope);
  }

  async reload() {
    try {
      const raw = await this._readCurrent();
      this._raw = raw;
      if (raw === undefined) throw new StorageError('نسخهٔ ذخیره‌شده پیدا نشد. دادهٔ فعلی را خروجی بگیرید.', 'MISSING');
      return this._accept(normalized(raw));
    } catch (cause) { throw persistenceError(cause); }
  }

  async save(envelope, expectedRevision) {
    const candidate = normalized(envelope);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || candidate.revision !== expectedRevision) {
      throw new StorageError('نسخهٔ مبنای تغییر معتبر نیست.', 'INVALID_DATA');
    }
    this.pending = copy(candidate);
    try {
      const db = await this._open();
      const saved = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const get = store.get(CURRENT_KEY);
        let result;
        let failure;
        get.onsuccess = () => {
          try {
            if (get.result === undefined) throw new StorageError('نسخهٔ مبنای دفتر پیدا نشد؛ ابتدا دفتر را دوباره بخوانید.', 'MISSING');
            const current = normalized(get.result);
            if (current.revision !== expectedRevision) throw new ConflictError(current);
            result = { ...candidate, revision: expectedRevision + 1 };
            validateEnvelope(result);
            store.put(result, CURRENT_KEY);
          } catch (cause) { failure = cause; tx.abort(); }
        };
        tx.oncomplete = () => resolve(result);
        tx.onerror = tx.onabort = () => reject(persistenceError(failure ?? tx.error ?? get.error));
      });
      this._raw = saved;
      this._accept(saved);
      this._announce(saved);
      return copy(saved);
    } catch (cause) { throw persistenceError(cause); }
  }

  /** Called only after UI confirmation of replacing a corrupt, failed load. */
  async recover(envelope) {
    const candidate = normalized(envelope);
    if (!this._recoverable) throw new StorageError('این دفتر به بازیابیِ دادهٔ خراب نیاز ندارد.', 'INVALID_DATA');
    this.pending = copy(candidate);
    const observed = this._raw;
    const originalLegacy = this._legacyRaw;
    try {
      const db = await this._open();
      const saved = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const get = store.get(CURRENT_KEY);
        let result;
        let failure;
        get.onsuccess = () => {
          try {
            if (get.result !== undefined) {
              let latest;
              try { latest = normalized(get.result); } catch { /* Corrupt record needs recovery. */ }
              if (latest) throw new ConflictError(latest);
              if (JSON.stringify(get.result) !== JSON.stringify(observed)) {
                throw new StorageError('دادهٔ ذخیره‌شده از زمان خطا تغییر کرده است؛ دوباره آن را بخوانید.', 'CONFLICT');
              }
            } else if (observed !== undefined) {
              throw new StorageError('دادهٔ ذخیره‌شده از زمان خطا تغییر کرده است؛ دوباره آن را بخوانید.', 'CONFLICT');
            }
            const recovery = { preservedAt: new Date().toISOString() };
            if (get.result !== undefined) recovery.raw = get.result;
            if (originalLegacy !== null) recovery.legacyRaw = originalLegacy;
            store.put(recovery, `recovery:${uid()}`);
            result = { ...candidate, revision: 0 };
            store.put(result, CURRENT_KEY);
          } catch (cause) { failure = cause; tx.abort(); }
        };
        tx.oncomplete = () => resolve(result);
        tx.onerror = tx.onabort = () => reject(persistenceError(failure ?? tx.error ?? get.error));
      });
      this._raw = saved;
      this._accept(saved);
      this._announce(saved);
      return copy(saved);
    } catch (cause) { throw persistenceError(cause); }
  }

  readRaw() {
    if (this._raw !== undefined) {
      try { return typeof this._raw === 'string' ? this._raw : JSON.stringify(this._raw, null, 2); }
      catch { return null; }
    }
    return this._legacyRaw;
  }

  close() {
    this._closed = true;
    this._db?.close();
    this._db = null;
    this._channel?.close();
    globalThis.removeEventListener?.('storage', this._storageListener);
    globalThis.removeEventListener?.('focus', this._focusListener);
  }
}
