/**
 * 家計診断 — グラフ描画
 *
 * d-ai-fp/js/chart.js と同じく外部ライブラリを使わない。
 * 横棒はHTML、月ごとの推移は Canvas に直接描く。
 */

const CHART_COLORS = {
  axis: '#d6ccc2',
  grid: '#f0e6dc',
  text: '#5b6472',
  income: '#f5a623',
  expense: '#c25e12',
  average: '#5b6472',
};

/** カテゴリ別の横棒（いちばん大きいカテゴリを棒の全幅にする） */
function renderCategoryBars(summary) {
  const rows = summary.categories.filter((c) => c.total > 0).sort((a, b) => b.total - a.total);
  if (rows.length === 0) return '<p class="empty">支出がまだ入っていません。</p>';
  const max = rows[0].total;
  return rows
    .map(
      (c) => `
      <div class="bar-row">
        <div class="bar-label">${c.label}<span class="tag ${c.fixed ? 'tag-fixed' : 'tag-var'}">${c.fixed ? '固定' : '変動'}</span></div>
        <div class="bar-track"><div class="bar-fill ${c.fixed ? '' : 'is-var'}" style="width:${(c.total / max) * 100}%"></div></div>
        <div class="bar-value">${yen(c.total)}<small>${Math.round(c.ratio * 100)}%</small></div>
      </div>`
    )
    .join('');
}

/** 固定費と変動費の比率（1本の帯で見せる） */
function renderFixedVariable(summary) {
  if (!summary.hasExpense) return '';
  const f = Math.round(summary.fixedRatio * 100);
  return `
    <div class="split-bar" role="img" aria-label="固定費${f}%・変動費${100 - f}%">
      <div class="split-fixed" style="width:${f}%"></div>
      <div class="split-var" style="width:${100 - f}%"></div>
    </div>
    <div class="split-legend">
      <span><i class="dot dot-fixed"></i>固定費 ${yen(summary.fixedTotal)}（${f}%）</span>
      <span><i class="dot dot-var"></i>変動費 ${yen(summary.variableTotal)}（${100 - f}%）</span>
    </div>`;
}

/**
 * 月ごとの推移（収入と支出を並べた棒グラフ）
 * @param {HTMLCanvasElement} canvas 描画先
 * @param {Array} trend buildTrend() の戻り値
 * @param {object|null} average trendAverage() の戻り値。あれば支出の平均を点線で引く
 */
function drawTrendChart(canvas, trend, average) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;

  // 画面の解像度に合わせて実ピクセル数を上げ、線がぼやけないようにする
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  const pad = { top: 16, right: 12, bottom: 30, left: 52 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  // 縦軸は「万円」で表示する
  const maxValue = Math.max(...trend.map((t) => Math.max(t.incomeTotal, t.expenseTotal)), 1) / 10000;
  const step = pickNiceStep(maxValue / 4);
  const top = Math.ceil(maxValue / step) * step || step;
  const y = (man) => pad.top + ((top - man) / top) * plotH;

  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let v = 0; v <= top + 1e-9; v += step) {
    const py = y(v);
    ctx.strokeStyle = v === 0 ? CHART_COLORS.axis : CHART_COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, py);
    ctx.lineTo(width - pad.right, py);
    ctx.stroke();
    ctx.fillStyle = CHART_COLORS.text;
    ctx.fillText(Math.round(v).toLocaleString('ja-JP') + '万', pad.left - 6, py);
  }

  // 1か月ぶんの枠の中に、収入と支出の2本を並べる
  const slot = plotW / Math.max(trend.length, 1);
  const barW = Math.min(slot * 0.32, 26);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  trend.forEach((t, i) => {
    const cx = pad.left + slot * i + slot / 2;
    const bars = [
      { v: t.incomeTotal / 10000, color: CHART_COLORS.income, x: cx - barW - 1 },
      { v: t.expenseTotal / 10000, color: CHART_COLORS.expense, x: cx + 1 },
    ];
    bars.forEach((b) => {
      ctx.fillStyle = b.color;
      ctx.fillRect(b.x, y(b.v), barW, y(0) - y(b.v));
    });
    ctx.fillStyle = CHART_COLORS.text;
    ctx.fillText(Number(t.month.split('-')[1]) + '月', cx, height - pad.bottom + 8);
  });

  // 支出の平均（点線）
  if (average) {
    const py = y(average.expense / 10000);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = CHART_COLORS.average;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(pad.left, py);
    ctx.lineTo(width - pad.right, py);
    ctx.stroke();
    ctx.restore();
  }
}

/** 目盛りの間隔を、1・2・5の切りの良い数字にそろえる */
function pickNiceStep(rough) {
  if (rough <= 0) return 1;
  const digits = Math.pow(10, Math.floor(Math.log10(rough)));
  const normalized = rough / digits;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return Math.max(step * digits, 1);
}
