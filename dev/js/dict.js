/**
 * 家計診断 — 店名辞書による自動仕分け（SPEC 2章「自動仕分け」）
 *
 * 仕分けはこの辞書と本人が覚えさせた店名だけで行う。AIには仕分けさせない。
 * 当て方：表記ゆれ（全角/半角・ひらがな/カタカナ・大文字/小文字・記号）をそろえてから部分一致。
 * 複数の言葉が当たったときは長い言葉を優先する（例：「スギ薬局」は「薬局」より優先）。
 * ただし保険を表す言葉（生命・共済・損保・海上）と「電気」は長さに関係なく最優先
 * （例：「コープ共済」は「コープ」＝食費ではなく保険料、「ENEOS Power（電気）」は車ではなく水道光熱費）。
 * 初期の中身は 2026-10-02 に本人と合意（decisions.md）。
 */

/** 分類ごとの言葉。キーは calc.js の EXPENSE_CATEGORIES の key */
const MERCHANT_WORDS = {
  food: [
    // コンビニ・スーパー（コンビニは食費で合意）
    'セブンイレブン', 'セブン-イレブン', 'セブンーイレブン', 'ファミリーマート', 'ファミマ', 'ローソン', 'ミニストップ', 'デイリーヤマザキ',
    'イオン', 'イトーヨーカドー', 'ヨーカドー', '西友', 'ライフ', 'マルエツ', 'ヤオコー', 'オーケー', '業務スーパー',
    'コープ', '生協', 'マックスバリュ', 'まいばすけっと', '成城石井', 'コストコ',
    // 外食・カフェ・宅配（食費で合意）
    'マクドナルド', 'すき家', '吉野家', '松屋', 'ガスト', 'サイゼリヤ', 'スターバックス', 'ウーバーイーツ', 'UBER EATS', '出前館',
  ],
  daily: [
    'マツモトキヨシ', 'ウエルシア', 'ツルハ', 'スギ薬局', 'ココカラファイン', 'サンドラッグ', 'コスモス薬品',
    'ダイソー', 'セリア', 'キャンドゥ', 'ニトリ', 'カインズ', 'コーナン', '無印良品',
  ],
  telecom: [
    'ドコモ', 'DOCOMO', 'KDDI', 'ソフトバンク', 'SOFTBANK', 'ワイモバイル', 'YMOBILE', 'UQモバイル', '楽天モバイル',
    'AHAMO', 'POVO', 'LINEMO', 'NTT東日本', 'NTT西日本', 'フレッツ', 'ビッグローブ', 'BIGLOBE', 'SO-NET', 'ソネット', 'J:COM',
  ],
  utility: ['電気', '電力', '水道', '東京ガス', '大阪ガス', '東邦ガス', '西部ガス'],
  insurance: ['生命', '損保', '共済', '海上', 'アフラック', 'メットライフ', '損保ジャパン', 'あいおいニッセイ', 'ライフネット生命'],
  car: [
    'ENEOS', 'エネオス', '出光', 'イデミツ', 'コスモ石油', 'コスモセキユ', '石油', 'ガスステーション', 'シェル', 'JR', 'SUICA', 'スイカ', 'PASMO', 'パスモ', 'ICOCA', 'ETC', 'NEXCO',
    'タイムズ', 'リパーク', 'タクシー',
  ],
  medical: ['病院', '医院', 'クリニック', '歯科', '調剤', '薬局'],
  leisure: ['TOHOシネマズ', 'イオンシネマ', 'カラオケ', '楽天トラベル', 'じゃらん', 'NINTENDO', '任天堂', 'PLAYSTATION'],
  clothing: ['ユニクロ', 'UNIQLO', 'しまむら', 'ZARA', 'H&M', '美容室', 'ヘアサロン'],
  subscription: [
    'NETFLIX', 'ネットフリックス', 'AMAZONプライム', 'AMAZON PRIME', 'プライム会費', 'SPOTIFY', 'APPLE.COM/BILL',
    'YOUTUBE PREMIUM', 'DISNEY+', 'ディズニープラス', 'U-NEXT', 'HULU', 'DAZN', 'ABEMA',
  ],
  education: ['公文', 'KUMON', 'くもん', '学研', 'ベネッセ', '進研ゼミ', '保育料'],
  housing: ['家賃', '管理費', '住宅ローン'],
};
// あえて入れないもの（毎回本人が選ぶ）：Amazon（プライム以外）・楽天市場・PayPay・メルカリ・ドン・キホーテ・ヨドバシ
// 2文字の英字（GU など）は他の店名に紛れて誤って当たりやすいため入れない

/**
 * 店名の表記ゆれをそろえる
 * 全角英数→半角・半角カナ→全角（NFKC）、大文字にそろえる、ひらがな→カタカナ、空白と記号を取る
 */
function normalizeName(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/[\s・\-‐－―−_.,，．'’"“”&＆/／:：()（）[\]「」【】+＋*＊!！?？#＃]/g, '');
}

/** 店名にこれが入っていれば、他の言葉より優先する（保険料・水道光熱費） */
const STRONG_WORDS = ['生命', '共済', '損保', '海上', '電気'].map(normalizeName);

/** 辞書を「そろえた言葉 → 分類」の一覧にして、優先する言葉 → 長い言葉の順に並べておく */
const MERCHANT_DICT = Object.entries(MERCHANT_WORDS)
  .flatMap(([cat, words]) => words.map((w) => ({ word: normalizeName(w), cat })))
  .filter((d) => d.word)
  .map((d) => ({ ...d, strong: STRONG_WORDS.includes(d.word) }))
  .sort((a, b) => b.strong - a.strong || b.word.length - a.word.length);

/**
 * 店名から分類を決める
 * 1. 本人が覚えさせた店名（そろえた店名が完全に一致したとき）
 * 2. 店名辞書（部分一致・長い言葉を優先）
 * @param {string} name 店名
 * @param {object} learned 本人が覚えさせた分 { そろえた店名: 分類key }
 * @returns {{cat: string|null, by: 'learned'|'dict'|null}}
 */
function classifyMerchant(name, learned) {
  const n = normalizeName(name);
  if (!n) return { cat: null, by: null };
  if (learned && learned[n] && EXPENSE_CATEGORIES.some((c) => c.key === learned[n])) {
    return { cat: learned[n], by: 'learned' };
  }
  const hit = MERCHANT_DICT.find((d) => n.includes(d.word));
  return hit ? { cat: hit.cat, by: 'dict' } : { cat: null, by: null };
}

/** 二重取り込みの判定に使う鍵（日付・金額・そろえた店名がすべて一致したら同じ明細とみなす） */
function duplicateKey(date, amount, name) {
  return `${date}|${toYen(amount)}|${normalizeName(name)}`;
}
