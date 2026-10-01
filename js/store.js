/**
 * 家計診断 — 端末内の保存（IndexedDB）とバックアップ
 *
 * 家計簿データはこの端末の中だけに置く。サーバーには送らない（SPEC 8章）。
 * IndexedDB が使えない環境では、開いている間だけメモリに持ち、画面で知らせる。
 */

const Store = (() => {
  const DB_NAME = 'kakei-shindan';
  const STORE = 'kv';
  let db = null;
  const memory = new Map(); // IndexedDB が使えないときの退避先
  let persistent = false;

  function open() {
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => {
          db = req.result;
          persistent = true;
          resolve(true);
        };
        req.onerror = () => resolve(false);
        req.onblocked = () => resolve(false);
      } catch (e) {
        resolve(false);
      }
    });
  }

  function tx(mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const s = t.objectStore(STORE);
      const r = fn(s);
      t.oncomplete = () => resolve(r && r.result);
      t.onerror = () => reject(t.error);
    });
  }

  async function get(key) {
    if (!db) return memory.get(key);
    return tx('readonly', (s) => s.get(key));
  }

  async function set(key, value) {
    if (!db) return memory.set(key, value);
    return tx('readwrite', (s) => s.put(value, key));
  }

  /** 保存されている月のデータをすべて返す（キーは "m:2026-10" の形） */
  async function allMonths() {
    if (!db) return [...memory.entries()].filter(([k]) => k.startsWith('m:')).map(([, v]) => v);
    const keys = await tx('readonly', (s) => s.getAllKeys());
    const out = [];
    for (const k of keys) if (String(k).startsWith('m:')) out.push(await get(k));
    return out;
  }

  return {
    open,
    isPersistent: () => persistent,
    getSettings: async () => (await get('settings')) || {},
    setSettings: (v) => set('settings', v),
    getMonth: (month) => get('m:' + month),
    setMonth: (data) => set('m:' + data.month, data),
    allMonths,
  };
})();

/** バックアップ用のファイルの中身を作る */
async function buildBackup() {
  const settings = await Store.getSettings();
  return {
    app: 'kakei-shindan',
    version: 1,
    exportedAt: new Date().toISOString(),
    fixedMap: settings.fixedMap || {},
    months: await Store.allMonths(),
  };
}

/**
 * 読み込んだバックアップを検査し、正しい形に整えて返す。形が違えばエラーを投げる
 * 金額は数字に直し、知らない項目は捨てる（壊れたファイルや別のファイルを読んでも画面が崩れないように）
 */
function parseBackup(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error('ファイルを読めませんでした。家計診断で書き出したファイルか確認してください。');
  }
  if (!raw || raw.app !== 'kakei-shindan' || !Array.isArray(raw.months)) {
    throw new Error('家計診断のバックアップファイルではないようです。');
  }
  const months = raw.months
    .filter((m) => m && /^\d{4}-\d{2}$/.test(m.month))
    .map((m) => {
      const clean = emptyMonth(m.month);
      INCOME_ITEMS.forEach((i) => (clean.income[i.key] = toYen(m.income && m.income[i.key])));
      EXPENSE_CATEGORIES.forEach((c) => {
        const e = (m.expense && m.expense[c.key]) || {};
        clean.expense[c.key] = {
          amount: toYen(e.amount),
          items: (Array.isArray(e.items) ? e.items : []).map((it) => ({
            id: String(it.id || newId()),
            date: /^\d{4}-\d{2}-\d{2}$/.test(it.date) ? it.date : '',
            memo: String(it.memo || '').slice(0, 60),
            amount: toYen(it.amount),
          })),
        };
      });
      clean.updatedAt = typeof m.updatedAt === 'string' ? m.updatedAt : null;
      return clean;
    });
  const fixedMap = {};
  EXPENSE_CATEGORIES.forEach((c) => {
    if (raw.fixedMap && typeof raw.fixedMap[c.key] === 'boolean') fixedMap[c.key] = raw.fixedMap[c.key];
  });
  return { months, fixedMap, exportedAt: raw.exportedAt };
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
