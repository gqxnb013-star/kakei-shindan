/**
 * 家計診断 — 集計（固定ロジック）
 *
 * 数字の計算はすべてこのファイルで行う。AIには計算させない（SPEC 冒頭の前提）。
 * 金額はすべて「円」の整数で持つ。
 */

/** 収入の項目（SPEC 2章） */
const INCOME_ITEMS = [
  { key: 'salary', label: '給与（本人・手取り）' },
  { key: 'spouse', label: '給与（配偶者・手取り）' },
  { key: 'bonus', label: '賞与', note: 'その月に出た分' },
  { key: 'side', label: '副収入' },
  { key: 'benefit', label: '児童手当などの給付' },
  { key: 'other', label: 'その他' },
];

/**
 * 支出のカテゴリ（SPEC 2章）
 * fixed は固定費/変動費の既定値。本人が画面で変えられる
 * daifp は D-AI-FP の5区分への対応。将来 D-AI-FP の入力欄に流し込むときに使う（画面には出さない）
 */
const EXPENSE_CATEGORIES = [
  { key: 'housing', label: '住居', note: '家賃・ローン・管理費', fixed: true, daifp: '住居費' },
  { key: 'utility', label: '水道光熱', fixed: true, daifp: '生活費' },
  { key: 'telecom', label: '通信', note: 'スマホ・ネット', fixed: true, daifp: 'その他' },
  { key: 'insurance', label: '保険料', fixed: true, daifp: '保険料' },
  { key: 'education', label: '教育', note: '学費・塾・習い事・保育料', fixed: true, daifp: '教育費' },
  { key: 'car', label: '車・交通', fixed: false, daifp: 'その他' },
  { key: 'food', label: '食費', fixed: false, daifp: '生活費' },
  { key: 'convenience', label: 'コンビニ', fixed: false, daifp: '生活費' },
  { key: 'daily', label: '日用品', fixed: false, daifp: '生活費' },
  { key: 'medical', label: '医療', fixed: false, daifp: 'その他' },
  { key: 'leisure', label: '娯楽・交際', fixed: false, daifp: 'その他' },
  { key: 'clothing', label: '被服・美容', fixed: false, daifp: 'その他' },
  { key: 'online', label: 'ネットショップ', note: 'Amazon・楽天市場など', fixed: false, daifp: 'その他' },
  { key: 'subscription', label: 'サブスク', fixed: true, daifp: 'その他' },
  { key: 'misc', label: 'その他', fixed: false, daifp: 'その他' },
  // 投資・積立は「使ったお金」ではないため、支出の合計・割合には入れず別枠で数える（2026-10-03 本人と合意）
  { key: 'invest', label: '投資・積立', note: '積立投資・iDeCo・積立預金など（支出の合計には入れません）', fixed: true, daifp: null, saving: true },
];

const DAIFP_GROUPS = ['住居費', '生活費', '保険料', '教育費', 'その他'];

/** 1か月ぶんの空のデータ */
function emptyMonth(month) {
  const income = {};
  INCOME_ITEMS.forEach((i) => (income[i.key] = 0));
  const expense = {};
  EXPENSE_CATEGORIES.forEach((c) => (expense[c.key] = { amount: 0, items: [] }));
  return { month, income, expense, updatedAt: null };
}

/** 保存済みの月に、あとから増えた分類の欄を足す（古いデータでも同じ形で扱えるように） */
function fillMonth(data) {
  if (!data) return data;
  data.expense = data.expense || {};
  EXPENSE_CATEGORIES.forEach((c) => {
    if (!data.expense[c.key]) data.expense[c.key] = { amount: 0, items: [] };
  });
  return data;
}

/** 入力値を0以上の整数（円）にそろえる。数字でないものは0 */
function toYen(value) {
  const n = Math.round(Number(String(value).replace(/[,，\s円]/g, '')));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** カテゴリの合計＝月額欄（明細以外の分）＋明細の合計 */
function categoryTotal(entry) {
  if (!entry) return 0;
  const itemsSum = (entry.items || []).reduce((s, it) => s + toYen(it.amount), 0);
  return toYen(entry.amount) + itemsSum;
}

/** そのカテゴリが固定費か（本人の設定があればそれを優先） */
function isFixed(key, fixedMap) {
  if (fixedMap && typeof fixedMap[key] === 'boolean') return fixedMap[key];
  const cat = EXPENSE_CATEGORIES.find((c) => c.key === key);
  return cat ? cat.fixed : false;
}

/**
 * 1か月ぶんの集計
 * @param {object} data emptyMonth() と同じ形
 * @param {object} fixedMap 固定/変動の本人設定 { key: true/false }
 */
function summarizeMonth(data, fixedMap) {
  const d = data || emptyMonth('');
  const incomeTotal = INCOME_ITEMS.reduce((s, i) => s + toYen(d.income && d.income[i.key]), 0);

  const categories = EXPENSE_CATEGORIES.filter((c) => !c.saving).map((c) => {
    const total = categoryTotal(d.expense && d.expense[c.key]);
    return { key: c.key, label: c.label, total, fixed: isFixed(c.key, fixedMap), daifp: c.daifp };
  });
  // 投資・積立（支出とは別枠）
  const investTotal = EXPENSE_CATEGORIES.filter((c) => c.saving).reduce((s, c) => s + categoryTotal(d.expense && d.expense[c.key]), 0);
  const expenseTotal = categories.reduce((s, c) => s + c.total, 0);
  categories.forEach((c) => (c.ratio = expenseTotal > 0 ? c.total / expenseTotal : 0));

  const fixedTotal = categories.filter((c) => c.fixed).reduce((s, c) => s + c.total, 0);
  const variableTotal = expenseTotal - fixedTotal;
  const insurance = categories.find((c) => c.key === 'insurance').total;

  return {
    month: d.month,
    incomeTotal,
    expenseTotal,
    investTotal,
    // 残るお金＝収入−支出−投資・積立
    balance: incomeTotal - expenseTotal - investTotal,
    categories,
    fixedTotal,
    variableTotal,
    fixedRatio: expenseTotal > 0 ? fixedTotal / expenseTotal : 0,
    insuranceRatio: expenseTotal > 0 ? insurance / expenseTotal : 0,
    hasIncome: incomeTotal > 0,
    hasExpense: expenseTotal > 0 || investTotal > 0,
  };
}

/** D-AI-FP の5区分に集計し直す（将来の流し込み用） */
function toDaiFpGroups(summary) {
  const out = {};
  DAIFP_GROUPS.forEach((g) => (out[g] = 0));
  summary.categories.forEach((c) => (out[c.daifp] += c.total));
  return out;
}

/** 入力のある月だけを、古い順に並べた集計の一覧（指定の月まで・最大12か月） */
function buildTrend(allMonths, uptoMonth, fixedMap) {
  return allMonths
    .filter((m) => m.month <= uptoMonth)
    .sort((a, b) => (a.month < b.month ? -1 : 1))
    .map((m) => summarizeMonth(m, fixedMap))
    .filter((s) => s.hasIncome || s.hasExpense)
    .slice(-12);
}

/** 推移の平均（3か月以上たまったときだけ出す） */
function trendAverage(trend) {
  if (trend.length < 3) return null;
  const n = trend.length;
  return {
    months: n,
    income: Math.round(trend.reduce((s, t) => s + t.incomeTotal, 0) / n),
    expense: Math.round(trend.reduce((s, t) => s + t.expenseTotal, 0) / n),
  };
}

/**
 * コメント（固定の文例から選ぶ。d-ai-fp/docs/compliance.md の表現ルールに合わせる）
 * 断定・商品の推奨・あおる表現は使わない
 */
function buildComments(summary, average) {
  const out = [];
  const pct = (r) => Math.round(r * 100);

  if (!summary.hasExpense) {
    out.push('支出がまだ入っていません。分かる項目からで大丈夫ですので、入れてみましょう。');
    return out;
  }

  if (!summary.hasIncome) {
    out.push('収入が未入力のため、残るお金は計算していません。');
  } else if (summary.balance < 0) {
    out.push(`この月は支出が収入を${yen(-summary.balance)}上回っています。賞与や貯蓄から補った月かどうか、内訳とあわせて確認しておきたいところです。`);
  } else {
    out.push(`この月は収入の${pct(summary.balance / summary.incomeTotal)}%（${yen(summary.balance)}）が手元に残る計算です。`);
  }

  if (summary.investTotal > 0) {
    out.push(
      summary.hasIncome
        ? `投資・積立に${yen(summary.investTotal)}（収入の${pct(summary.investTotal / summary.incomeTotal)}%）を回しています。支出の合計には含めていません。`
        : `投資・積立に${yen(summary.investTotal)}を回しています。支出の合計には含めていません。`
    );
  }

  const top = summary.categories.slice().sort((a, b) => b.total - a.total)[0];
  if (top && top.total > 0) {
    out.push(`支出がいちばん多いのは「${top.label}」で、支出全体の${pct(top.ratio)}%です。`);
  }

  if (summary.fixedRatio > 0.6) {
    out.push(`固定費が支出の${pct(summary.fixedRatio)}%と、6割を超えています。固定費は一度見直すと効果が毎月続くため、見直す余地がないか確認しておきたいところです。`);
  } else {
    out.push(`固定費は支出の${pct(summary.fixedRatio)}%、変動費は${pct(1 - summary.fixedRatio)}%です。`);
  }

  if (summary.insuranceRatio > 0) {
    out.push(`保険料は支出の${pct(summary.insuranceRatio)}%です。保障の内容と金額が今の暮らしに合っているか、ときどき確認しておくと安心です。`);
  }

  if (average) {
    out.push(`入力のある${average.months}か月の平均は、収入${yen(average.income)}・支出${yen(average.expense)}です。`);
  }
  return out;
}

/** 金額の表示（例：123,456円） */
function yen(n) {
  return Math.round(n).toLocaleString('ja-JP') + '円';
}

/** 月の表示（例：2026-10 → 2026年10月） */
function monthLabel(month) {
  const [y, m] = month.split('-');
  return `${y}年${Number(m)}月`;
}

/** 月を n か月ずらす（例：2026-01 と -1 → 2025-12） */
function shiftMonth(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
