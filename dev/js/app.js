/**
 * 家計診断 — 画面の切り替え・入力・保存・バックアップ
 *
 * 画面は ①はじめに ②ホーム ③収入 ④支出（④-2 スクショから読み取る）⑤仕分けの確認 ⑥見える化 ⑦レポート（SPEC 1章の番号）。
 * 画面の切り替えは URL の # で行い、スマホの「戻る」でも前の画面に戻れるようにする。
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const VIEWS = ['intro', 'home', 'income', 'expense', 'scan', 'review', 'charts', 'report'];
const SCAN_RESUME_KEY = 'kk-scan-resume'; // LINEログインから戻ったら読み取りの続きを出す印（sessionStorage）
const SCAN_RESUME_MS = 10 * 60 * 1000;
const BACKUP_REMIND_DAYS = 30;

const state = {
  month: currentMonth(),
  data: null, // 選んでいる月のデータ
  settings: {}, // { agreedAt, lastBackupAt, fixedMap, merchantMap }
  review: null, // ⑤で確認中の明細（端末には保存しない。画面を閉じると消える）
  scan: null, // 読み取り中の情報 { idToken, remaining }（端末には保存しない）
  scanResume: false, // LINEログインから戻ってきた直後か
};

let saveTimer = null;

/* ---------- 起動 ---------- */

document.addEventListener('DOMContentLoaded', async () => {
  const ok = await Store.open();
  if (!ok) showToast('この環境では端末に保存できません。画面を閉じると入力が消えます。', 8000);
  state.settings = await Store.getSettings();
  await loadMonth(state.month);
  bindEvents();
  resumeScanAfterLogin();
  route();
  // LINEの中で開いたとき・LINEログインから戻ったときだけ LIFF を準備する（js/line.js）
  if (LineAuth.shouldInitOnLoad()) LineAuth.init();
});

window.addEventListener('hashchange', route);

/** URL の # に合わせて画面を出す。同意前は「はじめに」以外を開かない */
async function route() {
  let view = location.hash.replace('#', '') || 'home';
  if (!VIEWS.includes(view)) view = 'home';
  if (!state.settings.agreedAt) view = 'intro';
  if (view === 'review' && !state.review) {
    // 確認中の明細がなければ⑤は開かない（再読み込みで消えたときなど）。アドレスも支出に直す
    view = 'expense';
    history.replaceState(null, '', '#expense');
  }
  await flushSave();
  VIEWS.forEach((v) => ($('#view-' + v).hidden = v !== view));
  window.scrollTo(0, 0);
  const render = { intro: renderIntro, home: renderHome, income: renderIncome, expense: renderExpense, scan: renderScan, review: renderReview, charts: renderCharts, report: renderReport }[view];
  await render();
}

function go(view) {
  if (location.hash === '#' + view) route();
  else location.hash = view;
}

/* ---------- 月の読み込みと保存 ---------- */

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function loadMonth(month) {
  state.month = month;
  const saved = await Store.getMonth(month);
  state.data = saved || emptyMonth(month);
}

/** 入力のたびに少し待ってから保存する（打っている途中で何度も書き込まないように） */
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}

async function flushSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  state.data.updatedAt = new Date().toISOString();
  await Store.setMonth(state.data);
}

async function changeMonth(n) {
  await flushSave();
  await loadMonth(shiftMonth(state.month, n));
  route();
}

function hasAnyInput(data) {
  const s = summarizeMonth(data, state.settings.fixedMap);
  return s.hasIncome || s.hasExpense;
}

/* ---------- イベント ---------- */

function bindEvents() {
  document.addEventListener('click', (e) => {
    const goEl = e.target.closest('[data-go]');
    if (goEl) {
      e.preventDefault();
      go(goEl.dataset.go);
      return;
    }
    const shiftEl = e.target.closest('[data-shift]');
    if (shiftEl) changeMonth(Number(shiftEl.dataset.shift));
  });

  $('#month-prev').addEventListener('click', () => changeMonth(-1));
  $('#month-next').addEventListener('click', () => changeMonth(1));

  $('#agree-check').addEventListener('change', (e) => ($('#btn-start').disabled = !e.target.checked));
  $('#btn-start').addEventListener('click', async () => {
    state.settings.agreedAt = new Date().toISOString();
    await Store.setSettings(state.settings);
    go('home');
  });

  $('#income-fields').addEventListener('input', onIncomeInput);
  $('#btn-copy-income').addEventListener('click', copyIncomeFromPrev);

  $('#expense-list').addEventListener('input', onExpenseInput);
  $('#expense-list').addEventListener('click', onExpenseClick);
  $('#btn-copy-fixed').addEventListener('click', copyFixedFromPrev);

  $('#review-body').addEventListener('input', onReviewInput);
  $('#review-body').addEventListener('change', onReviewInput);
  $('#review-learn').addEventListener('change', updateReviewStatus);
  $('#btn-review-commit').addEventListener('click', commitReview);
  $('#btn-review-cancel').addEventListener('click', cancelReview);
  if (['localhost', '127.0.0.1'].includes(location.hostname)) {
    $('#btn-dev-review').hidden = false;
    $('#btn-dev-review').addEventListener('click', () => openReview(devSampleRows()));
  }

  $('#btn-scan').addEventListener('click', () => {
    // LINEの中では読み取らない（データがブラウザごとに別のため、家計簿は Safari・Chrome で使う。SPEC 6-5）
    if (LineAuth.isLineBrowser()) {
      if (confirm('スクショの読み取りは Safari・Chrome で使えます。開き直しますか？\n（入力した内容はブラウザごとに別々に保存されます）')) LineAuth.openExternal(externalUrl());
      return;
    }
    go('scan');
  });
  $('#scan-agree').addEventListener('change', (e) => ($('#btn-scan-consent').disabled = !e.target.checked));
  $('#btn-scan-consent').addEventListener('click', scanSignIn);
  $('#scan-files').addEventListener('change', updateScanPicked);
  $('#btn-scan-run').addEventListener('click', runScan);

  $('#btn-export').addEventListener('click', exportBackup);
  $('#import-file').addEventListener('change', importBackup);

  $('#btn-print').addEventListener('click', () => {
    // LINEの中のブラウザでは印刷（PDF保存）が選べないため、外部ブラウザで開き直してもらう
    if (LineAuth.isLineBrowser()) LineAuth.openExternal(externalUrl());
    else window.print();
  });

  if (LineAuth.isLineBrowser()) {
    $('#line-notice').hidden = false;
    $('#btn-open-external').addEventListener('click', (e) => {
      e.preventDefault();
      LineAuth.openExternal(externalUrl()); // 押した時点の画面（# の部分）を引き継ぐ
    });
    $('#btn-print').textContent = 'Safari・Chromeで開いてPDF保存';
    $('#print-help').textContent = 'LINEの中ではPDF保存ができません。Safari・Chromeで開くと保存できますが、入力した内容はブラウザごとに別々のため、開いた先では入力し直しが必要です（ホームのバックアップで移すこともできます）。';
  }

  // 印刷の直前に推移のグラフを描き直す（紙の幅に合わせる）
  window.addEventListener('beforeprint', () => {
    const c = $('#report-trend');
    if (c && c._trend) drawTrendChart(c, c._trend, c._average);
  });
}

/* ---------- ①はじめに ---------- */

function renderIntro() {
  const agreed = Boolean(state.settings.agreedAt);
  $('#agree-check').checked = agreed;
  $('#btn-start').disabled = !agreed;
  $('#btn-start').textContent = agreed ? 'ホームへ' : 'はじめる';
}

/* ---------- ②ホーム ---------- */

async function renderHome() {
  $('#month-label').textContent = monthLabel(state.month);
  const s = summarizeMonth(state.data, state.settings.fixedMap);
  $('#home-summary').innerHTML = summaryTiles(s);

  // バックアップの案内：入力があって、書き出しから日数がたっている（または一度もない）とき
  const months = await Store.allMonths();
  const hasData = months.some(hasAnyInput);
  const last = state.settings.lastBackupAt ? new Date(state.settings.lastBackupAt) : null;
  const days = last ? Math.floor((Date.now() - last.getTime()) / 86400000) : null;
  $('#backup-last').textContent = last ? `最後に書き出した日：${last.toLocaleDateString('ja-JP')}` : 'まだ書き出していません。';
  $('#backup-alert').innerHTML =
    hasData && (days === null || days >= BACKUP_REMIND_DAYS)
      ? `<p class="note note-alert">${days === null ? 'まだバックアップがありません。' : `最後のバックアップから${days}日たっています。`}機種変更やブラウザのデータ削除に備えて、ファイルに書き出しておきましょう。</p>`
      : '';
}

/** 収入・支出・残るお金の3つの数字 */
function summaryTiles(s) {
  if (!s.hasIncome && !s.hasExpense) {
    return '<p class="empty">この月はまだ入力がありません。「収入を入れる」から始めましょう。</p>';
  }
  const balance = s.hasIncome
    ? `<p class="tile-value ${s.balance < 0 ? 'warn' : 'ok'}">${yen(s.balance)}</p><p class="tile-note">${s.balance < 0 ? '赤字' : '黒字'}</p>`
    : '<p class="tile-value">—</p><p class="tile-note">収入が未入力</p>';
  return `
    <div class="tile"><p class="tile-label">収入</p><p class="tile-value">${yen(s.incomeTotal)}</p></div>
    <div class="tile"><p class="tile-label">支出</p><p class="tile-value">${yen(s.expenseTotal)}</p></div>
    <div class="tile tile-main"><p class="tile-label">残るお金</p>${balance}</div>`;
}

/* ---------- ③収入 ---------- */

function renderIncome() {
  $('#income-month').textContent = monthLabel(state.month);
  $('#income-fields').innerHTML = INCOME_ITEMS.map(
    (i) => `
    <div class="field">
      <label for="in-${i.key}">${i.label}${i.note ? `<small>${i.note}</small>` : ''}</label>
      <div class="input-unit">
        <input type="number" inputmode="numeric" min="0" step="1" id="in-${i.key}" data-key="${i.key}" value="${state.data.income[i.key] || ''}" placeholder="0">
        <span class="unit">円</span>
      </div>
    </div>`
  ).join('');
  updateIncomeTotal();
}

function onIncomeInput(e) {
  const key = e.target.dataset.key;
  if (!key) return;
  state.data.income[key] = toYen(e.target.value);
  updateIncomeTotal();
  scheduleSave();
}

function updateIncomeTotal() {
  $('#income-total').textContent = yen(summarizeMonth(state.data, state.settings.fixedMap).incomeTotal);
}

async function copyIncomeFromPrev() {
  const prevMonth = shiftMonth(state.month, -1);
  const prev = await Store.getMonth(prevMonth);
  if (!prev || !summarizeMonth(prev).hasIncome) {
    showToast(`${monthLabel(prevMonth)}の収入が入っていません。`);
    return;
  }
  if (summarizeMonth(state.data).hasIncome && !confirm('入力済みの収入を、先月の内容で置き換えます。よろしいですか？')) return;
  INCOME_ITEMS.forEach((i) => (state.data.income[i.key] = toYen(prev.income[i.key])));
  scheduleSave();
  renderIncome();
  showToast(`${monthLabel(prevMonth)}の収入を入れました。`);
}

/* ---------- ④支出 ---------- */

function renderExpense() {
  $('#expense-month').textContent = monthLabel(state.month);
  $('#expense-list').innerHTML = EXPENSE_CATEGORIES.map((c) => {
    const entry = state.data.expense[c.key];
    const fixed = isFixed(c.key, state.settings.fixedMap);
    const count = entry.items.length;
    return `
    <div class="cat" data-cat="${c.key}">
      <div class="cat-head">
        <div class="cat-name">
          <span class="cat-label">${c.label}</span>
          <button type="button" class="tag tag-btn ${fixed ? 'tag-fixed' : 'tag-var'}" data-act="toggle-fixed" aria-label="固定費と変動費を切り替える">${fixed ? '固定' : '変動'}</button>
          ${c.note ? `<small>${c.note}</small>` : ''}
        </div>
        <div class="input-unit">
          <input type="number" inputmode="numeric" min="0" step="1" data-field="amount" value="${entry.amount || ''}" placeholder="月額" aria-label="${c.label}の月額（明細以外の分）">
          <span class="unit">円</span>
        </div>
      </div>
      <details class="cat-items" ${count ? 'open' : ''}>
        <summary>1件ずつ入れる<span class="item-count">${count ? `（${count}件）` : ''}</span><span class="cat-total">合計 <b>${yen(categoryTotal(entry))}</b></span></summary>
        <div class="items">${entry.items.map((it) => itemRow(it)).join('')}</div>
        <button type="button" class="btn btn-ghost btn-sm" data-act="add-item">＋ 明細を足す</button>
      </details>
    </div>`;
  }).join('');
  updateExpenseTotal();
}

function itemRow(it) {
  const [y, m] = state.month.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return `
    <div class="item" data-id="${esc(it.id)}">
      <input type="date" data-field="date" value="${esc(it.date)}" min="${state.month}-01" max="${state.month}-${String(lastDay).padStart(2, '0')}" aria-label="日付">
      <input type="text" data-field="memo" value="${esc(it.memo)}" maxlength="60" placeholder="内容（例：スーパー）" aria-label="内容">
      <div class="input-unit">
        <input type="number" inputmode="numeric" min="0" step="1" data-field="amount" value="${it.amount || ''}" placeholder="0" aria-label="金額">
        <span class="unit">円</span>
      </div>
      <button type="button" class="item-del" data-act="del-item" aria-label="この明細を消す">×</button>
    </div>`;
}

function onExpenseInput(e) {
  const catEl = e.target.closest('[data-cat]');
  const field = e.target.dataset.field;
  if (!catEl || !field) return;
  const entry = state.data.expense[catEl.dataset.cat];
  const itemEl = e.target.closest('.item');
  if (itemEl) {
    const it = entry.items.find((x) => x.id === itemEl.dataset.id);
    if (!it) return;
    if (field === 'amount') it.amount = toYen(e.target.value);
    else if (field === 'memo') it.memo = e.target.value.slice(0, 60);
    else if (field === 'date') it.date = e.target.value;
  } else if (field === 'amount') {
    entry.amount = toYen(e.target.value);
  }
  updateCatTotal(catEl);
  updateExpenseTotal();
  scheduleSave();
}

async function onExpenseClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const catEl = btn.closest('[data-cat]');
  const key = catEl.dataset.cat;
  const entry = state.data.expense[key];

  if (btn.dataset.act === 'add-item') {
    const it = { id: newId(), date: defaultDate(), memo: '', amount: 0 };
    entry.items.push(it);
    $('.items', catEl).insertAdjacentHTML('beforeend', itemRow(it));
    $('.items .item:last-child input[data-field="memo"]', catEl).focus();
  } else if (btn.dataset.act === 'del-item') {
    const id = btn.closest('.item').dataset.id;
    entry.items = entry.items.filter((x) => x.id !== id);
    btn.closest('.item').remove();
  } else if (btn.dataset.act === 'toggle-fixed') {
    // 固定/変動は月ごとではなく、全部の月に共通の設定として持つ
    const map = (state.settings.fixedMap = state.settings.fixedMap || {});
    map[key] = !isFixed(key, map);
    await Store.setSettings(state.settings);
    btn.textContent = map[key] ? '固定' : '変動';
    btn.classList.toggle('tag-fixed', map[key]);
    btn.classList.toggle('tag-var', !map[key]);
    return;
  }
  updateCatTotal(catEl);
  updateExpenseTotal();
  scheduleSave();
}

/** 明細の日付の初期値：今月なら今日、それ以外の月は1日 */
function defaultDate() {
  const now = new Date();
  if (state.month === currentMonth()) return `${state.month}-${String(now.getDate()).padStart(2, '0')}`;
  return `${state.month}-01`;
}

function updateCatTotal(catEl) {
  const entry = state.data.expense[catEl.dataset.cat];
  $('.cat-total b', catEl).textContent = yen(categoryTotal(entry));
  $('.item-count', catEl).textContent = entry.items.length ? `（${entry.items.length}件）` : '';
}

function updateExpenseTotal() {
  $('#expense-total').textContent = yen(summarizeMonth(state.data, state.settings.fixedMap).expenseTotal);
}

/** 先月の固定費を、今月まだ何も入っていないカテゴリにだけ月額として写す（入力済みは上書きしない） */
async function copyFixedFromPrev() {
  const prevMonth = shiftMonth(state.month, -1);
  const prev = await Store.getMonth(prevMonth);
  if (!prev) {
    showToast(`${monthLabel(prevMonth)}の支出が入っていません。`);
    return;
  }
  let copied = 0;
  EXPENSE_CATEGORIES.forEach((c) => {
    if (!isFixed(c.key, state.settings.fixedMap)) return;
    const prevTotal = categoryTotal(prev.expense[c.key]);
    if (prevTotal > 0 && categoryTotal(state.data.expense[c.key]) === 0) {
      state.data.expense[c.key].amount = prevTotal;
      copied += 1;
    }
  });
  if (copied === 0) {
    showToast('写せる固定費がありませんでした（入力済みのカテゴリは上書きしません）。');
    return;
  }
  scheduleSave();
  renderExpense();
  showToast(`固定費を${copied}カテゴリ写しました。金額が変わったものは直してください。`);
}

/* ---------- ④-2 スクショから読み取る ---------- */

/** 同意（毎回）→ 画像を選ぶ → 読み取り中 の3つの段のうち、1つだけ出す */
function showScanStep(step) {
  $('#scan-consent').hidden = step !== 'consent';
  $('#scan-pick').hidden = step !== 'pick';
  $('#scan-busy').hidden = step !== 'busy';
  $('#btn-scan-back').hidden = step === 'busy';
}

function showScanError(msg) {
  $('#scan-error').textContent = msg || '';
  $('#scan-error').hidden = !msg;
}

async function renderScan() {
  showScanError('');
  if (state.scanResume) {
    // LINEログインから戻ってきた直後。同意は済んでいるので、画像を選ぶところから
    state.scanResume = false;
    await scanSignIn();
    return;
  }
  // 同意は読み取りのたびに出す（2026-10-03 決定）
  state.scan = null;
  $('#scan-agree').checked = false;
  $('#btn-scan-consent').disabled = true;
  showScanStep('consent');
}

/** LINEで本人確認する。未ログインなら LINEログインへ移り、戻ってきたら resumeScanAfterLogin が続きを出す */
async function scanSignIn() {
  showScanError('');
  const btn = $('#btn-scan-consent');
  btn.disabled = true;
  try {
    try {
      sessionStorage.setItem(SCAN_RESUME_KEY, String(Date.now()));
    } catch (e) {}
    const r = await LineAuth.signIn();
    if (!r) return; // LINEログインの画面へ移った
    try {
      sessionStorage.removeItem(SCAN_RESUME_KEY);
    } catch (e) {}
    state.scan = { idToken: r.idToken, remaining: null };
    $('#scan-files').value = '';
    updateScanPicked();
    showScanStep('pick');
    $('#scan-quota').textContent = '今月の残り枚数を確認しています…';
    state.scan.remaining = await ScanImport.quota(r.idToken);
    $('#scan-quota').textContent = state.scan.remaining > 0 ? `今月はあと${state.scan.remaining}枚読み取れます。` : '今月の読み取り枚数の上限（30枚）に達しました。来月またお使いください。';
    updateScanPicked();
  } catch (err) {
    try {
      sessionStorage.removeItem(SCAN_RESUME_KEY);
    } catch (e) {}
    state.scan = null;
    showScanStep('consent');
    $('#scan-agree').checked = true;
    btn.disabled = false;
    showScanError((err.message || '本人確認ができませんでした。もう一度お試しください。') + scanDebugText(err));
  }
}

/** 試験用の写し（/dev/）・プレビューのときだけ、原因の切り分けのための情報を添える（IDやトークンは出さない） */
function scanDebugText(err) {
  if (!(location.pathname.includes('/dev/') || ['localhost', '127.0.0.1'].includes(location.hostname))) return '';
  return `［試験用 v2：${err.code || '-'}／${err.detail || '-'}／期限 ${LineAuth.idTokenExpText() || '-'}］`;
}

/** 起動時：LINEログインから戻ってきたなら、読み取りの画面（画像を選ぶ段）を出す */
function resumeScanAfterLogin() {
  try {
    const at = Number(sessionStorage.getItem(SCAN_RESUME_KEY) || 0);
    if (!at) return;
    sessionStorage.removeItem(SCAN_RESUME_KEY);
    if (Date.now() - at > SCAN_RESUME_MS) return;
    state.scanResume = true;
    history.replaceState(null, '', location.pathname + location.search + '#scan');
  } catch (e) {}
}

function updateScanPicked() {
  const files = [...$('#scan-files').files];
  const remaining = state.scan && typeof state.scan.remaining === 'number' ? state.scan.remaining : 0;
  let msg = files.length ? `${files.length}枚を選びました。` : '';
  let ok = files.length > 0;
  if (files.length > ScanImport.MAX_PER_REQUEST) {
    msg = `${files.length}枚選ばれています。1回${ScanImport.MAX_PER_REQUEST}枚までです。選び直してください。`;
    ok = false;
  } else if (files.length > remaining) {
    msg = `${files.length}枚選ばれていますが、今月はあと${remaining}枚までです。`;
    ok = false;
  }
  $('#scan-picked').textContent = msg;
  $('#btn-scan-run').disabled = !ok;
}

async function runScan() {
  const files = [...$('#scan-files').files];
  if (!state.scan || !files.length) return;
  showScanError('');
  showScanStep('busy');
  try {
    const r = await ScanImport.read(state.scan.idToken, files);
    state.scan.remaining = r.remaining;
    if (!r.rows.length) {
      showScanStep('pick');
      $('#scan-files').value = '';
      updateScanPicked();
      $('#scan-quota').textContent = `今月はあと${r.remaining}枚読み取れます。`;
      showScanError(r.income ? `支出の明細が見つかりませんでした（入金${r.income}件は除きました）。` : '明細が見つかりませんでした。明細の一覧が写ったスクショでお試しください。');
      return;
    }
    await openReview(r.rows);
    showToast(`${r.rows.length}件を読み取りました。` + (r.income ? `入金${r.income}件は除きました（収入は「収入を入れる」で月額を入れてください）。` : '') + `今月はあと${r.remaining}枚読み取れます。`, 7000);
  } catch (err) {
    if (err.code === 'token') {
      // ログインの期限切れ。同意からやり直す
      state.scan = null;
      showScanStep('consent');
      $('#scan-agree').checked = true;
      $('#btn-scan-consent').disabled = false;
    } else {
      showScanStep('pick');
      if (typeof err.remaining === 'number') {
        state.scan.remaining = err.remaining;
        $('#scan-quota').textContent = `今月はあと${err.remaining}枚読み取れます。`;
        updateScanPicked();
      }
    }
    const msg = err.code === 'limit' && err.remaining > 0 ? `今月はあと${err.remaining}枚までです。枚数を減らして選び直してください。` : err.message;
    showScanError((msg || '読み取りできませんでした。もう一度お試しください。') + scanDebugText(err));
  }
}

/* ---------- ⑤仕分けの確認 ---------- */

/**
 * 読み取った明細を⑤の確認画面に出す（スクショ読み取りの結果をここに渡す）
 * 店名辞書・本人が覚えさせた分で仕分け、この端末にある明細や今回の中で同じものがあれば「二重の可能性」に回す
 * @param {Array<{date: string, name: string, amount: number}>} rawRows 支出の明細
 */
async function openReview(rawRows) {
  await flushSave();
  const learned = state.settings.merchantMap || {};

  // 明細の月ごとに、この端末にある明細の鍵を集める
  const existing = new Set();
  const months = [...new Set(rawRows.map((r) => String(r.date || '').slice(0, 7)).filter((m) => /^\d{4}-\d{2}$/.test(m)))];
  for (const m of months) {
    const data = m === state.month ? state.data : await Store.getMonth(m);
    if (!data) continue;
    EXPENSE_CATEGORIES.forEach((c) => data.expense[c.key].items.forEach((it) => existing.add(duplicateKey(it.date, it.amount, it.memo))));
  }

  // 今回の中の二重：同じ画像の中で同じ明細が並ぶのは別々の利用（例：同じ日に同じ金額のETC2回）なので二重にしない。
  // 前の画像にあった件数までを「重なって写った分」とみなす。画像の番号がない行は1行ずつ別の画像として扱う
  const prevMax = new Map(); // 鍵 → それより前の画像での最大件数
  const curCount = new Map(); // 鍵 → 今の画像での件数
  let curImage = null;
  const flushImage = () => {
    curCount.forEach((n, k) => prevMax.set(k, Math.max(prevMax.get(k) || 0, n)));
    curCount.clear();
  };
  const rows = rawRows.map((r, i) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : '';
    const name = String(r.name || '').slice(0, 60);
    const amount = toYen(r.amount);
    const key = duplicateKey(date, amount, name);
    const image = Number(r.image) >= 1 ? Number(r.image) : `row${i}`;
    if (image !== curImage) {
      flushImage();
      curImage = image;
    }
    const occ = (curCount.get(key) || 0) + 1;
    curCount.set(key, occ);
    const dup = existing.has(key) ? 'stored' : occ <= (prevMax.get(key) || 0) ? 'batch' : null;
    const { cat, by } = classifyMerchant(name, learned);
    // 二重の可能性があるものは、未分類でも「取り込むか」の判断を先にしてもらう
    const group = dup ? 'dup' : cat ? 'auto' : 'unclassified';
    return { rid: newId(), date, name, amount, cat, by, dup, group, take: !dup, chosen: false };
  });

  state.review = { rows };
  go('review');
}

function renderReview() {
  const rows = state.review.rows;
  const groups = {
    unclassified: rows.filter((r) => r.group === 'unclassified'),
    dup: rows.filter((r) => r.group === 'dup'),
    auto: rows.filter((r) => r.group === 'auto'),
  };
  let html = '';
  if (groups.unclassified.length) {
    html += `<div class="rv-group rv-alert">
      <h3 class="rv-head">⚠ 分類を選んでください<span class="rv-count">（${groups.unclassified.length}件）</span></h3>
      ${groups.unclassified.map(reviewRow).join('')}
    </div>`;
  }
  if (groups.dup.length) {
    html += `<div class="rv-group rv-alert">
      <h3 class="rv-head">⚠ 二重の可能性<span class="rv-count">（${groups.dup.length}件）</span></h3>
      <p class="rv-help">同じ日付・店名・金額の明細があります。別の買い物なら「取り込む」にチェックしてください。</p>
      ${groups.dup.map(reviewRow).join('')}
    </div>`;
  }
  if (groups.auto.length) {
    html += `<details class="rv-group rv-auto">
      <summary class="rv-head">✓ 自動で仕分け済み<span class="rv-count">（${groups.auto.length}件）</span><span class="rv-open">開いて確認・変更</span></summary>
      ${groups.auto.map(reviewRow).join('')}
    </details>`;
  }
  $('#review-body').innerHTML = html;
  updateReviewStatus();
}

function reviewRow(r) {
  const options = EXPENSE_CATEGORIES.map((c) => `<option value="${c.key}" ${r.cat === c.key ? 'selected' : ''}>${c.label}</option>`).join('');
  const dupNote = r.dup === 'stored' ? 'この端末に同じ明細があります' : r.dup === 'batch' ? '今回の中に同じ明細がもう1件あります' : '';
  const byNote = r.by === 'learned' ? '前回選んだ分類' : r.by === 'dict' ? '店名から自動' : '';
  return `
    <div class="rv-row ${r.take ? '' : 'is-skip'}" data-rid="${esc(r.rid)}">
      <input type="date" data-field="date" value="${esc(r.date)}" aria-label="日付">
      <input type="text" data-field="name" value="${esc(r.name)}" maxlength="60" aria-label="店名">
      <div class="input-unit">
        <input type="number" inputmode="numeric" min="0" step="1" data-field="amount" value="${r.amount || ''}" aria-label="金額">
        <span class="unit">円</span>
      </div>
      <select data-field="cat" aria-label="分類" class="${r.cat ? '' : 'is-empty'}">
        <option value="" ${r.cat ? '' : 'selected'}>分類を選ぶ</option>${options}
      </select>
      <div class="rv-meta">
        ${r.dup ? `<label class="rv-take"><input type="checkbox" data-field="take" ${r.take ? 'checked' : ''}>取り込む</label><span class="rv-note">${dupNote}</span>` : ''}
        ${byNote ? `<span class="rv-note">${byNote}</span>` : ''}
      </div>
    </div>`;
}

function onReviewInput(e) {
  const rowEl = e.target.closest('[data-rid]');
  const field = e.target.dataset.field;
  if (!rowEl || !field) return;
  const r = state.review.rows.find((x) => x.rid === rowEl.dataset.rid);
  if (!r) return;
  if (field === 'date') r.date = e.target.value;
  else if (field === 'name') r.name = e.target.value.slice(0, 60);
  else if (field === 'amount') r.amount = toYen(e.target.value);
  else if (field === 'cat') {
    r.cat = e.target.value || null;
    r.chosen = true; // 本人が選んだ・変えた分類は、次回から自動にする対象
    e.target.classList.toggle('is-empty', !r.cat);
  } else if (field === 'take') {
    r.take = e.target.checked;
    rowEl.classList.toggle('is-skip', !r.take);
  }
  updateReviewStatus();
}

/** 取り込む明細の中に足りないものがあれば、その内容を返す（なければ空） */
function reviewProblems() {
  const taken = state.review.rows.filter((r) => r.take);
  const out = [];
  const noCat = taken.filter((r) => !r.cat).length;
  const noDate = taken.filter((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.date)).length;
  const noAmount = taken.filter((r) => r.amount <= 0).length;
  if (noCat) out.push(`分類が選ばれていない明細が${noCat}件あります`);
  if (noDate) out.push(`日付が入っていない明細が${noDate}件あります`);
  if (noAmount) out.push(`金額が入っていない明細が${noAmount}件あります`);
  return out;
}

function updateReviewStatus() {
  const taken = state.review.rows.filter((r) => r.take);
  const problems = reviewProblems();
  const btn = $('#btn-review-commit');
  btn.disabled = problems.length > 0 || taken.length === 0;
  $('#review-status').textContent = problems.length
    ? problems.join('。') + '。'
    : taken.length
      ? `${taken.length}件・${yen(taken.reduce((s, r) => s + r.amount, 0))}を取り込みます。`
      : '取り込む明細がありません。';
}

async function commitReview() {
  if (reviewProblems().length) return;
  await flushSave();
  const taken = state.review.rows.filter((r) => r.take);

  // 明細の日付の月ごとに入れる
  const byMonth = new Map();
  taken.forEach((r) => {
    const m = r.date.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(r);
  });
  const now = new Date().toISOString();
  for (const [m, list] of byMonth) {
    const data = m === state.month ? state.data : (await Store.getMonth(m)) || emptyMonth(m);
    list.forEach((r) => data.expense[r.cat].items.push({ id: newId(), date: r.date, memo: r.name, amount: r.amount }));
    data.updatedAt = now;
    await Store.setMonth(data);
  }

  // 本人が選んだ・変えた分類を覚える（そろえた店名で覚え、次回は完全一致で当てる）
  let learnedCount = 0;
  if ($('#review-learn').checked) {
    const map = (state.settings.merchantMap = state.settings.merchantMap || {});
    taken.filter((r) => r.chosen && normalizeName(r.name)).forEach((r) => {
      map[normalizeName(r.name)] = r.cat;
      learnedCount += 1;
    });
    if (learnedCount) await Store.setSettings(state.settings);
  }

  const others = [...byMonth.keys()].filter((m) => m !== state.month).sort();
  state.review = null;
  go('expense');
  showToast(
    `${taken.length}件を取り込みました。` +
      (others.length ? `（${others.map(monthLabel).join('・')}の分はその月に入れました）` : '') +
      (learnedCount ? `${learnedCount}件の店名を次回から自動で仕分けます。` : ''),
    6000
  );
}

function cancelReview() {
  if (!confirm('読み取った明細は保存されません。取り込まずに戻りますか？')) return;
  state.review = null;
  go('expense');
}

/** 開発用：⑤の確認に使う架空の明細（選んでいる月と前の月）。実在の家計の数字は使わない */
function devSampleRows() {
  const m = state.month;
  const p = shiftMonth(m, -1);
  return [
    { date: `${m}-03`, name: 'ｾﾌﾞﾝ-ｲﾚﾌﾞﾝ 渋谷店', amount: 580 },
    { date: `${m}-04`, name: 'NTTドコモ ご利用料金', amount: 7480 },
    { date: `${m}-05`, name: 'コープ共済', amount: 2000 },
    { date: `${m}-06`, name: 'スギ薬局 新宿店', amount: 1320 },
    { date: `${m}-07`, name: 'AMAZON.CO.JP', amount: 3980 },
    { date: `${m}-08`, name: 'ﾃｽﾄｼｮｳﾃﾝ', amount: 1500 },
    { date: `${m}-09`, name: 'ネットフリックス', amount: 1590 },
    { date: `${m}-10`, name: 'ENEOS SS', amount: 5200 },
    { date: `${m}-10`, name: 'ENEOS SS', amount: 5200 },
    { date: `${p}-29`, name: 'ユニクロ', amount: 2990 },
  ];
}

/* ---------- ⑥見える化 ---------- */

async function renderCharts() {
  $$('[data-month-label]').forEach((el) => (el.textContent = monthLabel(state.month)));
  const { summary, trend, average, comments } = await analyze();
  const body = $('#charts-body');

  if (!summary.hasIncome && !summary.hasExpense) {
    body.innerHTML = '<div class="card"><p class="empty">この月はまだ入力がありません。</p></div>';
    return;
  }

  body.innerHTML = `
    <div class="card summary-card"><div class="summary-grid">${summaryTiles(summary)}</div></div>
    <div class="card">
      <h2>コメント</h2>
      <ul class="comments">${comments.map((c) => `<li>${c}</li>`).join('')}</ul>
      <p class="footnote">入力された金額から決まった基準で表示しています。特定の商品をすすめるものではありません。</p>
    </div>
    <div class="card">
      <h2>カテゴリ別の支出</h2>
      <div class="bars">${renderCategoryBars(summary)}</div>
    </div>
    <div class="card">
      <h2>固定費と変動費</h2>
      ${renderFixedVariable(summary)}
      <p class="footnote">固定/変動の区分は支出の画面で切り替えられます。</p>
    </div>
    ${trendCard(trend, average, 'charts-trend')}`;
  drawTrendIn('#charts-trend', trend, average);
}

/** 選んでいる月の集計・推移・コメントをまとめて出す */
async function analyze() {
  await flushSave();
  const fixedMap = state.settings.fixedMap;
  const all = await Store.allMonths();
  // 保存前の今月分が一覧にない場合に備えて、手元の内容で差し替える
  const merged = all.filter((m) => m.month !== state.month).concat([state.data]);
  const summary = summarizeMonth(state.data, fixedMap);
  const trend = buildTrend(merged, state.month, fixedMap);
  const average = trendAverage(trend);
  return { summary, trend, average, comments: buildComments(summary, average) };
}

function trendCard(trend, average, canvasId) {
  if (trend.length < 2) {
    return '<div class="card"><h2>月ごとの推移</h2><p class="empty">2か月以上入力すると、推移のグラフが出ます。</p></div>';
  }
  return `
    <div class="card trend-card">
      <h2>月ごとの推移</h2>
      <div class="chart-box"><canvas id="${canvasId}" role="img" aria-label="月ごとの収入と支出の棒グラフ"></canvas></div>
      <div class="split-legend">
        <span><i class="dot dot-income"></i>収入</span>
        <span><i class="dot dot-fixed"></i>支出</span>
        ${average ? `<span><i class="dash"></i>支出の平均（${average.months}か月）${yen(average.expense)}</span>` : ''}
      </div>
    </div>`;
}

function drawTrendIn(sel, trend, average) {
  const c = $(sel);
  if (!c) return;
  c._trend = trend;
  c._average = average;
  drawTrendChart(c, trend, average);
}

/* ---------- ⑦レポート ---------- */

async function renderReport() {
  const { summary, trend, average, comments } = await analyze();
  const body = $('#report-body');
  if (!summary.hasIncome && !summary.hasExpense) {
    body.innerHTML = `<div class="card"><p class="empty">${monthLabel(state.month)}はまだ入力がありません。ホームで月を選び直すか、収入・支出を入れてください。</p></div>`;
    $('#btn-print').disabled = true;
    return;
  }
  $('#btn-print').disabled = false;

  const rows = summary.categories
    .filter((c) => c.total > 0)
    .sort((a, b) => b.total - a.total)
    .map((c) => `<tr><td>${c.label}</td><td>${c.fixed ? '固定' : '変動'}</td><td class="num">${yen(c.total)}</td><td class="num">${Math.round(c.ratio * 100)}%</td></tr>`)
    .join('');

  body.innerHTML = `
    <div class="report">
      <div class="report-head">
        <p class="report-title">家計レポート</p>
        <p class="report-meta">対象月：${monthLabel(state.month)}　作成日：${new Date().toLocaleDateString('ja-JP')}</p>
      </div>
      <div class="card summary-card"><div class="summary-grid">${summaryTiles(summary)}</div></div>
      <div class="card">
        <h2>カテゴリ別の支出</h2>
        <div class="bars">${renderCategoryBars(summary)}</div>
        <div class="table-wrap">
          <table class="report-table">
            <thead><tr><th>カテゴリ</th><th>区分</th><th class="num">金額</th><th class="num">割合</th></tr></thead>
            <tbody>${rows}</tbody>
            <tfoot><tr><td colspan="2">支出の合計</td><td class="num">${yen(summary.expenseTotal)}</td><td class="num">100%</td></tr></tfoot>
          </table>
        </div>
      </div>
      <div class="card">
        <h2>固定費と変動費</h2>
        ${renderFixedVariable(summary)}
      </div>
      ${trendCard(trend, average, 'report-trend')}
      <div class="card">
        <h2>コメント</h2>
        <ul class="comments">${comments.map((c) => `<li>${c}</li>`).join('')}</ul>
      </div>
      <p class="footnote report-foot">このレポートはご本人が入力した金額をもとに、決まった計算方法で集計したものです。一般的な情報提供であり、特定の金融商品・保険商品の推奨や投資助言ではありません。</p>
    </div>`;
  drawTrendIn('#report-trend', trend, average);
}

/* ---------- バックアップ ---------- */

async function exportBackup() {
  await flushSave();
  const data = await buildBackup();
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  const d = new Date();
  a.href = URL.createObjectURL(blob);
  a.download = `kakei-shindan_backup_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  state.settings.lastBackupAt = d.toISOString();
  await Store.setSettings(state.settings);
  showToast('バックアップを書き出しました。ファイルの保存場所を確認してください。');
  renderHome();
}

async function importBackup(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // 同じファイルをもう一度選べるようにする
  if (!file) return;
  try {
    const parsed = parseBackup(await file.text());
    const list = parsed.months.map((m) => monthLabel(m.month)).join('・') || 'なし';
    if (!confirm(`バックアップ（${parsed.months.length}か月分：${list}）を読み込みます。\n同じ月がこの端末にある場合は、ファイルの内容で置き換わります。よろしいですか？`)) return;
    await flushSave();
    for (const m of parsed.months) await Store.setMonth(m);
    state.settings.fixedMap = { ...(state.settings.fixedMap || {}), ...parsed.fixedMap };
    state.settings.merchantMap = { ...(state.settings.merchantMap || {}), ...parsed.merchantMap };
    await Store.setSettings(state.settings);
    await loadMonth(state.month);
    showToast(`${parsed.months.length}か月分を読み込みました。`);
    route();
  } catch (err) {
    showToast(err.message || '読み込みに失敗しました。', 6000);
  }
}

/* ---------- LINEの中のブラウザ ---------- */

/** LINEで開いたときに外部ブラウザで開き直すためのURL（LINEの openExternalBrowser 指定を付ける） */
function externalUrl() {
  return `${location.origin}${location.pathname}?openExternalBrowser=1${location.hash}`;
}

/* ---------- 共通 ---------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

let toastTimer = null;
function showToast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('is-show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-show'), ms);
}
