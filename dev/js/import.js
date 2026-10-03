/**
 * 家計診断 — スクショの取り込み（第3段 4番）
 *
 * 画像をブラウザの中で長辺1568pxの JPEG に縮小し、LINEの id_token と一緒に GAS へ送る。
 * GAS が本人確認・月の上限確認をして Claude で読み取り、日付・店名・金額の行を返す（gas/Code.gs）。
 * 画像も結果もサーバーには残らない。金額の計算はAIにさせず、⑤で本人が確認する。
 */
const ScanImport = (() => {
  // GAS「家計診断（D-AI-FP）」の公開URL（公開IDを変えないよう、更新は既存の公開に上書きする）
  const GAS_URL = 'https://script.google.com/macros/s/AKfycbyihDd1vNwkKw0RkBKI_NQ4KsPKYg9brAOwUFyPEbfSsN9VCYImR-p3lAnGNfRCZrWQrQ/exec';
  const MAX_PER_REQUEST = 5;
  const MAX_EDGE = 1568; // 公式の推奨。これより大きくても読み取りは良くならず、料金だけ上がる
  const JPEG_QUALITY = 0.85;

  // GAS が返す失敗の種類 → 画面に出す文
  const MESSAGES = {
    token: 'LINEの本人確認の期限が切れました。もう一度お試しください。',
    images: '画像を読み込めませんでした。別の画像でお試しください。',
    limit: '今月の読み取り枚数の上限に達しました。来月またお使いください。',
    nokey: '読み取りの準備中です。しばらくお待ちください。',
    busy: '読み取りが混み合っています。少し時間をおいてお試しください（今回の分は枚数に数えていません）。',
    billing: '読み取りを一時停止しています。担当のFPにお知らせください。',
    refusal: 'この画像は読み取れませんでした。明細の部分だけのスクショでお試しください。',
    toolong: '明細が多すぎて読み取りきれませんでした。枚数を減らしてお試しください。',
  };

  async function post(payload) {
    let json;
    try {
      // text/plain で送ると、GAS への送信で事前確認（CORS のプリフライト）が発生しない
      const res = await fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
      });
      json = await res.json();
    } catch (e) {
      throw new Error('通信できませんでした。電波の状態を確かめて、もう一度お試しください。');
    }
    if (!json.ok) {
      const err = new Error(MESSAGES[json.error] || '読み取りできませんでした。もう一度お試しください（今回の分は枚数に数えていません）。');
      err.code = json.error;
      err.remaining = json.remaining;
      throw err;
    }
    return json;
  }

  /** 今月の残り枚数 */
  async function quota(idToken) {
    return (await post({ action: 'quota', idToken })).remaining;
  }

  /** 画像1枚を長辺 MAX_EDGE 以下の JPEG にして、base64（先頭の data:… を除いた部分）を返す */
  function toJpegBase64(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; // 透明な部分（PNG）は白にする
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', JPEG_QUALITY).split(',')[1]);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('画像を開けませんでした。スクショの画像（JPEG・PNG）を選んでください。'));
      };
      img.src = url;
    });
  }

  /**
   * 読み取る。戻り値は { rows: [{date, name, amount}], income: 入金の件数, remaining: 今月の残り枚数 }
   * @param {string} idToken LINE の id_token
   * @param {File[]} files 選んだ画像（5枚まで）
   */
  async function read(idToken, files) {
    if (!files.length || files.length > MAX_PER_REQUEST) throw new Error(`画像は1回${MAX_PER_REQUEST}枚まで選べます。`);
    const images = [];
    for (const f of files) images.push(await toJpegBase64(f));
    const today = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const json = await post({
      action: 'scan',
      idToken,
      images,
      today: `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`,
    });
    return { rows: json.rows || [], income: json.income || 0, remaining: json.remaining };
  }

  return { MAX_PER_REQUEST, quota, read };
})();
