/**
 * 家計診断 — 画面の切り替え・入力・保存・バックアップ
 *
 * 画面は ①はじめに ②ホーム ③収入 ④支出 ⑥見える化 ⑦レポート（SPEC 1章の番号）。
 * 画面の切り替えは URL の # で行い、スマホの「戻る」でも前の画面に戻れるようにする。
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const VIEWS = ['intro', 'home', 'income', 'expense', 'charts', 'report'];
const BACKUP_REMIND_DAYS = 30;

const state = {
  month: currentMonth(),
  data: null, // 選んでいる月のデータ
  settings: {}, // { agreedAt, lastBackupAt, fixedMap }
};

let saveTimer = null;

/* ---------- 起動 ---------- */

document.addEventListener('DOMContentLoaded', async () => {
  const ok = await Store.open();
  if (!ok) showToast('この環境では端末に保存できません。画面を閉じると入力が消えます。', 8000);
  state.settings = await Store.getSettings();
  await loadMonth(state.month);
  bindEvents();
  route();
});

window.addEventListener('hashchange', route);

/** URL の # に合わせて画面を出す。同意前は「はじめに」以外を開かない */
async function route() {
  let view = location.hash.replace('#', '') || 'home';
  if (!VIEWS.includes(view)) view = 'home';
  if (!state.settings.agreedAt) view = 'intro';
  await flushSave();
  VIEWS.forEach((v) => ($('#view-' + v).hidden = v !== view));
  window.scrollTo(0, 0);
  const render = { intro: renderIntro, home: renderHome, income: renderIncome, expense: renderExpense, charts: renderCharts, report: renderReport }[view];
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

  $('#btn-export').addEventListener('click', exportBackup);
  $('#import-file').addEventListener('change', importBackup);

  $('#btn-print').addEventListener('click', () => {
    // LINEの中のブラウザでは印刷（PDF保存）が選べないため、外部ブラウザで開き直してもらう
    if (isLineBrowser()) location.href = externalUrl();
    else window.print();
  });

  if (isLineBrowser()) {
    $('#line-notice').hidden = false;
    $('#btn-open-external').addEventListener('click', (e) => {
      e.preventDefault();
      location.href = externalUrl(); // 押した時点の画面（# の部分）を引き継ぐ
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
    await Store.setSettings(state.settings);
    await loadMonth(state.month);
    showToast(`${parsed.months.length}か月分を読み込みました。`);
    route();
  } catch (err) {
    showToast(err.message || '読み込みに失敗しました。', 6000);
  }
}

/* ---------- LINEの中のブラウザ ---------- */

/** LINEアプリの中のブラウザで開かれているか（LINEは利用者の端末情報に「Line/」を含める） */
function isLineBrowser() {
  return /\bLine\//i.test(navigator.userAgent);
}

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
