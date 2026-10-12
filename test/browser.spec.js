import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const DB_NAME = 'monopoly-mortgage-ledger-v2';
const LEGACY_KEY = 'monopoly-mortgage-v1';
const monetaryVector = [100, 110, 121, 133, 146, 161, 177, 195, 214];

if (process.env.VERCEL_PREVIEW_TEST === '1') {
  process.loadEnvFile('.env.local');
  const previewToken = process.env.VERCEL_OIDC_TOKEN;
  if (!previewToken) throw new Error('Preview authentication requires the existing local Vercel development OIDC token.');
  const allowedOrigin = new URL(process.env.PLAYWRIGHT_BASE_URL).origin;
  test.beforeEach(async ({ context }) => {
    // This credential may only reach the explicitly selected Preview origin.
    await context.route((url) => url.origin === allowedOrigin, async (route) => {
      await route.continue({ headers: {
        ...route.request().headers(),
        'x-vercel-trusted-oidc-idp-token': previewToken,
      } });
    });
  });
}

const seat = (page, owner = 'p1') => page.locator(`#seats [data-player="${owner}"]`);
const card = (page, id) => page.locator(`article[data-card="${id}"]`);
const action = (page, id, name) => page.locator(`[data-action="${name}"][data-id="${id}"]`);

async function open(page) {
  await page.goto('/');
  await expect(page.locator('#who option')).toHaveCount(8);
  await expect(page.locator('#add button')).toBeEnabled();
}

async function ledger(page) {
  return page.evaluate(async (name) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = database.transaction('ledger').objectStore('ledger').get('current');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally { database.close(); }
  }, DB_NAME);
}

async function persisted(page, predicate) {
  await expect.poll(async () => predicate(await ledger(page))).toBe(true);
}

async function addCard(page, owner, name, price = '200') {
  const before = (await ledger(page)).game.cards.map((item) => item.id);
  await page.locator('#who').selectOption(owner);
  await page.locator('#cname').fill(name);
  await page.locator('#cprice').fill(String(price));
  await page.locator('#add button').click();
  await persisted(page, (data) => data.game.cards.some((item) => !before.includes(item.id)));
  const added = (await ledger(page)).game.cards.find((item) => !before.includes(item.id));
  await expect(card(page, added.id)).toBeVisible();
  return added.id;
}

async function debt(page, id, amount) {
  await expect(card(page, id)).toHaveAttribute('data-debt', String(amount));
}

async function lap(page, owner = 'p1') {
  // Distinct physical laps deliberately exceed the accidental-double-touch window.
  await page.waitForTimeout(430);
  const revision = (await ledger(page)).revision;
  await page.locator(`[data-lap="${owner}"]`).click();
  await persisted(page, (data) => data.revision > revision);
}

async function undo(page) {
  const revision = (await ledger(page)).revision;
  await page.locator('#undo').click();
  await persisted(page, (data) => data.revision > revision);
}

async function rename(page, owner, name) {
  await page.locator(`[data-name="${owner}"]`).fill(name);
  await page.locator('#cname').focus();
  await persisted(page, (data) => data.game.players.find((item) => item.id === owner).name === name);
}

async function confirm(page) {
  await expect(page.locator('#confirm-dialog')).toBeVisible();
  await page.locator('#confirm-action').click();
  await expect(page.locator('#confirm-dialog')).not.toBeVisible();
}

async function exportFile(page) {
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#export').click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/\.json$/);
  return JSON.parse(await readFile(await download.path(), 'utf8'));
}

async function importFile(page, value, accepted = true) {
  await page.locator('#import-file').setInputFiles({
    name: 'synthetic-monopoly-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
  });
  if (accepted) await confirm(page);
}

function legacy(cards, compound = true) {
  return { players: ['رامین', 'مینا', '', '', '', '', '', ''], cards, seq: 0, compound };
}

async function seedLegacy(page, value) {
  await page.addInitScript(({ key, fixture }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(fixture));
  }, { key: LEGACY_KEY, fixture: value });
}

test('exact compound vector and only the owner’s active cards accrue interest', async ({ page }) => {
  await open(page);
  const first = await addCard(page, 'p1', 'خیابان اول', '۲۰۰');
  const second = await addCard(page, 'p1', 'خیابان دوم', '٢٠٠');
  const other = await addCard(page, 'p2', 'خیابان بازیکن دوم', '200');
  await debt(page, first, monetaryVector[0]);
  for (let index = 1; index < monetaryVector.length; index += 1) {
    await lap(page);
    await debt(page, first, monetaryVector[index]);
    await debt(page, second, monetaryVector[index]);
    await debt(page, other, 100);
  }
  await expect(card(page, first)).toHaveAttribute('data-status', 'grace');
  await expect(card(page, second)).toHaveAttribute('data-status', 'grace');
  await expect(page.locator('[data-lap="p1"]')).toBeDisabled();
  await page.reload();
  await debt(page, first, 214);
  await expect(card(page, second)).toHaveAttribute('data-status', 'grace');
});

test('a newly mortgaged card starts at zero laps and settlement remains fixed', async ({ page }) => {
  await open(page);
  const first = await addCard(page, 'p1', 'کارت قدیمی');
  await lap(page);
  await lap(page);
  const fresh = await addCard(page, 'p1', 'کارت تازه');
  await debt(page, fresh, 100);
  await action(page, first, 'settle').click();
  await expect(card(page, first)).toHaveAttribute('data-status', 'settled');
  await expect(card(page, first)).toHaveAttribute('data-paid', '121');
  await lap(page);
  await debt(page, fresh, 110);
  await page.reload();
  await expect(card(page, first)).toHaveAttribute('data-paid', '121');
  const data = await ledger(page);
  expect(data.game.cards.find((item) => item.id === first).settlement.ownerId).toBe('p1');
});

test('transfer keeps card identity and debt, then applies the destination’s lap', async ({ page }) => {
  await open(page);
  const moving = await addCard(page, 'p1', 'کارت انتقالی');
  const remaining = await addCard(page, 'p1', 'کارت باقی‌مانده');
  await lap(page);
  await lap(page);
  await page.locator(`[data-transfer="${moving}"]`).selectOption('p2');
  await expect(seat(page, 'p2').locator(`[data-card="${moving}"]`)).toBeVisible();
  await debt(page, moving, 121);
  await lap(page, 'p1');
  await debt(page, moving, 121);
  await debt(page, remaining, 133);
  await lap(page, 'p2');
  await debt(page, moving, 133);
  expect((await ledger(page)).game.cards.filter((item) => item.id === moving)).toHaveLength(1);
});

test('odd prices and rounded auction quarters follow the fixed contract', async ({ page }) => {
  await open(page);
  const odd = await addCard(page, 'p1', 'قیمت فرد', '201');
  const quarterUp = await addCard(page, 'p1', 'نیمه رو به بالا', '150');
  const quarterDown = await addCard(page, 'p1', 'ربع ۲۰۲', '202');
  await debt(page, odd, 101);
  await lap(page);
  await debt(page, odd, 111);
  for (let index = 1; index < 8; index += 1) await lap(page);
  await debt(page, odd, 215);
  for (const [id, start] of [[odd, 50], [quarterUp, 38], [quarterDown, 51]]) {
    await action(page, id, 'auction').click();
    await expect(card(page, id)).toHaveAttribute('data-status', 'auction');
    await expect(card(page, id)).toContainText(new RegExp(String(start).replace(/[0-9]/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[digit])));
  }
  await action(page, odd, 'closeAuction').click();
  await expect(card(page, odd)).toHaveAttribute('data-status', 'auction_closed');
  await undo(page);
  await expect(card(page, odd)).toHaveAttribute('data-status', 'auction');
  await debt(page, odd, 215);
  await action(page, odd, 'closeAuction').click();
  await page.reload();
  expect((await ledger(page)).game.cards.find((item) => item.id === odd).status).toBe('auction_closed');
});

test('last chance freezes independently and follows a transferred card', async ({ page }) => {
  await seedLegacy(page, legacy([
    { id: 'grace-a', p: 0, name: 'فرصت اول', price: 200, laps: 8, auction: false },
    { id: 'grace-b', p: 0, name: 'فرصت دوم', price: 200, laps: 8, auction: false },
    { id: 'active-a', p: 0, name: 'کارت فعال', price: 200, laps: 2, auction: false },
    { id: 'active-b', p: 1, name: 'کارت فعال دوم', price: 200, laps: 2, auction: false },
  ]));
  await open(page);
  await expect(page.locator('[data-lap="p1"]')).toBeDisabled();
  await action(page, 'grace-a', 'settle').click();
  await expect(card(page, 'grace-b')).toHaveAttribute('data-status', 'grace');
  await expect(page.locator('[data-lap="p1"]')).toBeDisabled();
  await page.locator('[data-transfer="grace-b"]').selectOption('p2');
  await expect(page.locator('[data-lap="p1"]')).toBeEnabled();
  await expect(page.locator('[data-lap="p2"]')).toBeDisabled();
  await debt(page, 'grace-b', 214);
  await lap(page, 'p1');
  await debt(page, 'active-a', 133);
  await debt(page, 'active-b', 121);
  await action(page, 'grace-b', 'auction').click();
  await lap(page, 'p2');
  await debt(page, 'grace-b', 214);
  await debt(page, 'active-b', 133);
});

test('a tiny rounded amount still enters grace using the exact comparison', async ({ page }) => {
  await open(page);
  const tiny = await addCard(page, 'p1', 'ارزش یک', '1');
  for (let index = 0; index < 8; index += 1) await lap(page);
  await debt(page, tiny, 1);
  await expect(card(page, tiny)).toHaveAttribute('data-status', 'grace');
  await expect(card(page, tiny)).toContainText(/دقیق|گرد/);
});

test('name typing retains focus and caret while all owner selectors synchronize', async ({ page }) => {
  await open(page);
  const id = await addCard(page, 'p2', 'برای کنترل انتقال');
  const input = page.locator('[data-name="p1"]');
  await input.focus();
  await input.pressSequentially('رامین بازی', { delay: 55 });
  await expect(input).toBeFocused();
  expect(await input.evaluate((element) => element.selectionStart)).toBe('رامین بازی'.length);
  await expect(page.locator('#who option[value="p1"]')).toContainText('رامین بازی');
  await expect(page.locator(`[data-transfer="${id}"] option[value="p1"]`)).toContainText('رامین بازی');
  await page.locator('#cname').focus();
  await persisted(page, (data) => data.game.players[0].name === 'رامین بازی');
  await page.reload();
  await expect(input).toHaveValue('رامین بازی');
  await rename(page, 'p2', 'رامین بازی');
  expect(await page.locator('#who option[value="p1"]').textContent()).not.toBe(await page.locator('#who option[value="p2"]').textContent());
  await undo(page);
  await expect(page.locator('[data-name="p2"]')).toHaveValue('');
  await undo(page);
  await expect(page.locator('[data-name="p1"]')).toHaveValue('');
});

test('undo reverses settlement, transfer, laps, creation and a coalesced name edit', async ({ page }) => {
  await open(page);
  await rename(page, 'p1', 'نام آزمایشی');
  const id = await addCard(page, 'p1', 'ترتیب برگردان');
  await lap(page);
  await lap(page);
  await page.locator(`[data-transfer="${id}"]`).selectOption('p2');
  await expect(seat(page, 'p2').locator(`[data-card="${id}"]`)).toBeVisible();
  await action(page, id, 'settle').click();
  await expect(card(page, id)).toHaveAttribute('data-paid', '121');
  await page.reload();
  await expect(page.locator('#undo')).toBeEnabled();
  await undo(page);
  await expect(card(page, id)).toHaveAttribute('data-status', 'active');
  await undo(page);
  await expect(seat(page, 'p1').locator(`[data-card="${id}"]`)).toBeVisible();
  await undo(page);
  await debt(page, id, 110);
  await undo(page);
  await debt(page, id, 100);
  await undo(page);
  await expect(card(page, id)).toHaveCount(0);
  await undo(page);
  await expect(page.locator('[data-name="p1"]')).toHaveValue('');
});

test('accidental double click accrues once and a fresh click after undo is accepted', async ({ page }) => {
  await open(page);
  const id = await addCard(page, 'p1', 'دوبار لمس');
  await page.locator('[data-lap="p1"]').dblclick({ delay: 30 });
  await debt(page, id, 110);
  expect((await ledger(page)).game.cards[0].laps).toBe(1);
  await undo(page);
  await debt(page, id, 100);
  await page.locator('[data-lap="p1"]').click();
  await debt(page, id, 110);
});

test('export downloads a complete backup, new game archives, import restores and retains names', async ({ page }) => {
  await open(page);
  await rename(page, 'p1', 'رامین');
  const id = await addCard(page, 'p1', 'نسخهٔ پشتیبان', '۲٬۰۰۰');
  await lap(page);
  const backup = await exportFile(page);
  expect(backup.schemaVersion).toBe(2);
  expect(backup.exportId).toBeTruthy();
  expect(backup.exportedAt).toBeTruthy();
  expect(backup.game.cards.find((item) => item.id === id).laps).toBe(1);
  const oldGame = backup.game.id;
  await page.locator('#reset').click();
  await confirm(page);
  await persisted(page, (data) => data.game.id !== oldGame && data.game.cards.length === 0);
  await expect(page.locator('[data-name="p1"]')).toHaveValue('رامین');
  const reset = await ledger(page);
  expect(reset.archives.some((item) => item.id === oldGame)).toBe(true);
  const archivedIndex = reset.archives.findIndex((item) => item.id === oldGame);
  await expect(page.locator(`[data-export-game="${archivedIndex}"]`)).toHaveCount(1);
  await importFile(page, backup);
  await debt(page, id, 1100);
  await page.reload();
  await debt(page, id, 1100);
  expect((await ledger(page)).archives.some((item) => item.id === reset.game.id)).toBe(true);
});

test('new-game cancellation and archived-game restoration preserve both games', async ({ page }) => {
  await open(page);
  const id = await addCard(page, 'p1', 'بازی بایگانی');
  const original = (await ledger(page)).game.id;
  await page.locator('#reset').click();
  await page.locator('#cancel-action').click();
  await debt(page, id, 100);
  expect((await ledger(page)).game.id).toBe(original);
  await page.locator('#reset').click();
  await confirm(page);
  await persisted(page, (data) => data.game.id !== original);
  const newer = (await ledger(page)).game.id;
  await page.locator('#archives').evaluate((element) => { if (element.tagName === 'DETAILS') element.open = true; });
  const archiveIndex = (await ledger(page)).archives.findIndex((item) => item.id === original);
  await page.locator(`[data-restore-game="${archiveIndex}"]`).click();
  await confirm(page);
  await debt(page, id, 100);
  expect((await ledger(page)).archives.some((item) => item.id === newer)).toBe(true);
});

test('legacy migration preserves all statuses and runs only once', async ({ page }) => {
  const fixture = legacy([
    { id: 'legacy-active', p: 0, name: 'فعال', price: 200, laps: 2, auction: false },
    { id: 'legacy-grace', p: 1, name: 'آخرین شانس', price: 200, laps: 18, auction: false },
    { id: 'legacy-settled', p: 2, name: 'تسویه', price: 200, laps: 2, auction: true, paid: 121 },
    { id: 'legacy-auction', p: 3, name: 'مزایده', price: 150, laps: 8, auction: true },
  ]);
  await seedLegacy(page, fixture);
  await open(page);
  await debt(page, 'legacy-active', 121);
  await debt(page, 'legacy-grace', 214);
  await expect(card(page, 'legacy-grace')).toHaveAttribute('data-status', 'grace');
  await expect(card(page, 'legacy-settled')).toHaveAttribute('data-status', 'settled');
  await expect(card(page, 'legacy-settled')).toHaveAttribute('data-paid', '121');
  await expect(card(page, 'legacy-auction')).toHaveAttribute('data-status', 'auction');
  const migrated = await ledger(page);
  expect(migrated.game.cards.find((item) => item.id === 'legacy-grace').legacy.rawLaps).toBe(18);
  expect(migrated.game.cards.find((item) => item.id === 'legacy-settled').settlement.at).toBeNull();
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), LEGACY_KEY)).toEqual(fixture);
  await page.reload();
  expect((await ledger(page)).game.cards).toHaveLength(4);
  await page.evaluate((key) => { localStorage.setItem(key, JSON.stringify({ players: Array(8).fill('古'), cards: [], seq: 0, compound: true })); }, LEGACY_KEY);
  await page.reload();
  expect((await ledger(page)).game.id).toBe(migrated.game.id);
  expect((await ledger(page)).game.cards).toHaveLength(4);
});

test('legacy-simple equality is active at ten laps and strict crossing is grace at eleven', async ({ page }) => {
  await seedLegacy(page, legacy([
    { id: 'simple-equality', p: 0, name: 'بهره قدیمی', price: 200, laps: 10, auction: false },
  ], false));
  await open(page);
  await debt(page, 'simple-equality', 200);
  await expect(card(page, 'simple-equality')).toHaveAttribute('data-status', 'active');
  expect((await ledger(page)).game.model).toBe('legacy-simple');
  await lap(page);
  await debt(page, 'simple-equality', 210);
  await expect(card(page, 'simple-equality')).toHaveAttribute('data-status', 'grace');
  await page.locator('#reset').click();
  await confirm(page);
  await persisted(page, (data) => data.game.model === 'compound');
});

test('invalid backups and price inputs never alter the healthy game', async ({ page }) => {
  await open(page);
  const id = await addCard(page, 'p1', 'داده سالم');
  const snapshot = structuredClone((await ledger(page)).game);
  const badImports = [
    '{broken JSON',
    { schemaVersion: 999, game: snapshot },
    legacy([{ id: 'wrong-owner', p: 9, name: 'نامعتبر', price: 200, laps: 0, auction: false }]),
    legacy([{ id: 'same', p: 0, name: 'اول', price: 200, laps: 0, auction: false }, { id: 'same', p: 1, name: 'دوم', price: 200, laps: 0, auction: false }]),
    legacy([{ id: 'huge', p: 0, name: 'بیش از سقف', price: 10_000_000_000, laps: 0, auction: false }]),
    legacy([{ id: 'laps', p: 0, name: 'دور بسیار بزرگ', price: 200, laps: 1_000_001, auction: false }]),
  ];
  for (const value of badImports) {
    await importFile(page, value, false);
    await expect(page.locator('#message')).toContainText(/نامعتبر|خطا|خراب|پشتیبانی|نسخه|شناسه|قیمت|مالک|دور|ساختار/);
    await expect(page.locator('#confirm-dialog')).not.toBeVisible();
    expect((await ledger(page)).game).toEqual(snapshot);
  }
  for (const price of ['0', '-2', '1.5', 'NaN', 'Infinity', '10,000,000,000', '1,20']) {
    await page.locator('#cname').fill('نباید ثبت شود');
    await page.locator('#cprice').fill(price);
    await page.locator('#add button').click();
    await expect(page.locator('#message')).toContainText(/قیمت|عدد|صحیح|معتبر|سقف/);
    expect((await ledger(page)).game.cards).toHaveLength(1);
  }
  await debt(page, id, 100);
});

test('user text is rendered literally and cannot execute HTML or script', async ({ page }) => {
  await open(page);
  const unsafe = '<img src=x onerror="window.injected=1">';
  await rename(page, 'p1', unsafe);
  const id = await addCard(page, 'p1', unsafe);
  await expect(card(page, id)).toContainText(unsafe);
  await expect(page.locator('#seats img')).toHaveCount(0);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  await page.reload();
  await expect(page.locator('[data-name="p1"]')).toHaveValue(unsafe);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
});

test('two tabs reject stale changes and explicitly reload the newest ledger', async ({ page, context }) => {
  await open(page);
  const second = await context.newPage();
  await open(second);
  const id = await addCard(page, 'p1', 'تب اول');
  await second.locator('#who').selectOption('p2');
  await second.locator('#cname').fill('عملیات تب قدیمی');
  await second.locator('#cprice').fill('400');
  await second.locator('#add button').click();
  await expect(second.locator('#reload-latest')).toBeVisible();
  expect((await ledger(page)).game.cards).toHaveLength(1);
  await second.locator('#reload-latest').click();
  await confirm(second);
  await debt(second, id, 100);
  const fresh = await addCard(second, 'p2', 'اختیار تازه', '400');
  expect((await ledger(second)).game.cards).toHaveLength(2);
  await page.reload();
  await debt(page, fresh, 200);
  await second.close();
});

test('explicit reload locks edits until its asynchronous read has completed', async ({ page, context }) => {
  await open(page);
  const id = await addCard(page, 'p1', 'تأخیر خواندن نسخه تازه');
  const second = await context.newPage();
  await open(second);
  await lap(second);
  await expect(page.locator('#reload-latest')).toBeVisible();
  await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', {
      ...descriptor,
      set(callback) {
        const transaction = this;
        descriptor.set.call(transaction, transaction.mode === 'readonly' && typeof callback === 'function'
          ? (event) => setTimeout(() => callback.call(transaction, event), 500)
          : callback);
      },
    });
  });
  await page.locator('#reload-latest').click();
  await expect(page.locator('[data-lap="p1"]')).toBeDisabled({ timeout: 250 });
  await expect(page.locator('[data-name="p1"]')).toBeDisabled({ timeout: 250 });
  await debt(page, id, 110);
  await expect(page.locator('[data-name="p1"]')).toBeEnabled();
  await lap(page);
  await debt(page, id, 121);
  await second.close();
});

test('closing during pending save warns and dismissal retains the committed lap', async ({ page }) => {
  await open(page);
  const id = await addCard(page, 'p1', 'ذخیره هنگام بستن صفحه');
  await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', {
      ...descriptor,
      set(callback) {
        const transaction = this;
        descriptor.set.call(transaction, transaction.mode === 'readwrite' && typeof callback === 'function'
          ? (event) => { window.releaseSaveCompletion = () => callback.call(transaction, event); }
          : callback);
      },
    });
  });
  await page.locator('[data-lap="p1"]').click();
  await page.waitForFunction(() => typeof window.releaseSaveCompletion === 'function');
  await expect(page.locator('#storage-status')).toContainText('در حال ذخیره');
  const dialogEvent = page.waitForEvent('dialog', { timeout: 5_000 });
  const navigation = page.evaluate(() => location.reload()).catch(() => null);
  const dialog = await dialogEvent;
  expect(dialog.type()).toBe('beforeunload');
  await dialog.dismiss();
  await navigation;
  await page.evaluate(() => window.releaseSaveCompletion());
  await expect(page.locator('[data-lap="p1"]')).toBeEnabled();
  await persisted(page, (data) => data.game.cards.find((item) => item.id === id).laps === 1);
  await page.reload();
  await debt(page, id, 110);
});

test('a fresh browser context gets an independent ledger at the same public URL', async ({ page, browser }) => {
  await open(page);
  await rename(page, 'p1', 'فقط دفتر اول');
  const id = await addCard(page, 'p1', 'کارت خصوصی محلی');
  const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const other = await otherContext.newPage();
    await open(other);
    await expect(other.locator('[data-name="p1"]')).toHaveValue('');
    expect((await ledger(other)).game.cards).toHaveLength(0);
    expect((await ledger(other)).game.id).not.toBe((await ledger(page)).game.id);
    await expect(card(other, id)).toHaveCount(0);
  } finally { await otherContext.close(); }
});

test('a rejected IndexedDB write preserves last saved data and retries without duplication', async ({ page }) => {
  await open(page);
  const id = await addCard(page, 'p1', 'پیش از خطای ذخیره');
  const second = await addCard(page, 'p1', 'کارت دوم همان تراکنش');
  const saved = await ledger(page);
  await page.evaluate(() => {
    window.originalLedgerPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'ledger') throw new DOMException('Synthetic acceptance quota failure', 'QuotaExceededError');
      return window.originalLedgerPut.apply(this, args);
    };
  });
  await page.locator('[data-lap="p1"]').click();
  await expect(page.locator('#storage-status')).toContainText(/ذخیره.*(نشد|نشده|خطا)|خطا|ثبت.*نشد/);
  expect(await ledger(page)).toEqual(saved);
  await expect(page.locator('#retry-save')).toBeVisible();
  const recovery = await exportFile(page);
  expect(recovery.game.cards.find((item) => item.id === id).laps).toBe(1);
  expect(recovery.game.cards.find((item) => item.id === second).laps).toBe(1);
  expect((await ledger(page)).game.cards.every((item) => item.laps === 0)).toBe(true);
  await page.evaluate(() => { IDBObjectStore.prototype.put = window.originalLedgerPut; });
  await page.locator('#retry-save').click();
  await persisted(page, (data) => data.game.cards.find((item) => item.id === id).laps === 1);
  await page.reload();
  await debt(page, id, 110);
  await debt(page, second, 110);
  expect((await ledger(page)).game.cards).toHaveLength(2);
});

test('corrupt persisted data shows recovery instead of overwriting it with an empty game', async ({ page }) => {
  await open(page);
  const saved = await ledger(page);
  const corrupt = { ...saved, game: { ...saved.game, cards: [{ id: 'bad', ownerId: 'p99', price: -1 }] } };
  await page.evaluate(async ({ name, value }) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('ledger', 'readwrite');
      transaction.objectStore('ledger').put(value, 'current');
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, { name: DB_NAME, value: corrupt });
  await page.reload();
  await expect(page.locator('#message')).toContainText(/خراب|خطا|نامعتبر|بازیابی|معتبر نیست/);
  expect(await ledger(page)).toEqual(corrupt);
  await expect(page.locator('#add button')).toBeDisabled();
});

for (const width of [360, 390, 430]) {
  test(`complete mobile flow at ${width}px has no horizontal overflow or console errors`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await open(page);
    await rename(page, 'p1', 'رامین با نام نسبتاً بلند برای میز مونوپولی');
    await rename(page, 'p2', 'سارا');
    const id = await addCard(page, 'p1', 'خیابان طولانی با عدد فارسی', '۲۰۰');
    await addCard(page, 'p1', 'خیابان دوم با عدد عربی', '٢٬٠٠٠');
    await lap(page);
    await page.locator(`[data-transfer="${id}"]`).selectOption('p2');
    await expect(seat(page, 'p2').locator(`[data-card="${id}"]`)).toBeVisible();
    await action(page, id, 'settle').click();
    await undo(page);
    await debt(page, id, 110);
    const backup = await exportFile(page);
    await importFile(page, backup);
    await page.reload();
    await debt(page, id, 110);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const overflowing = await page.locator('input, select, button').evaluateAll((elements) => elements.filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
    }).map((element) => element.id || element.outerHTML.slice(0, 100)));
    expect(overflowing).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('the loaded ledger operates offline and its service worker supports a real offline reload', async ({ page, context }) => {
  await open(page);
  const id = await addCard(page, 'p1', 'ثبت آفلاین');
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    }
    return registration.scope;
  });
  await context.setOffline(true);
  await lap(page);
  await debt(page, id, 110);
  await page.reload();
  await debt(page, id, 110);
  await action(page, id, 'settle').click();
  await expect(card(page, id)).toHaveAttribute('data-paid', '110');
  await context.setOffline(false);
});

test('a newly registered service worker preserves game data and unfinished inputs', async ({ page }) => {
  await open(page);
  const id = await addCard(page, 'p1', 'پیش از به‌روزرسانی');
  const saved = (await ledger(page)).game;
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.locator('#cname').fill('ورودی هنوز ثبت نشده');
  await page.evaluate(async () => {
    // A new script URL installs a genuinely fresh worker in the existing scope.
    const registration = await navigator.serviceWorker.register('/sw.js?acceptance-update=1', { scope: '/' });
    if (registration.installing) {
      await new Promise((resolve) => {
        const worker = registration.installing;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' || worker.state === 'activated') resolve();
        });
      });
    }
  });
  await expect(page.locator('#cname')).toHaveValue('ورودی هنوز ثبت نشده');
  expect((await ledger(page)).game).toEqual(saved);
  await page.reload();
  await debt(page, id, 100);
});
