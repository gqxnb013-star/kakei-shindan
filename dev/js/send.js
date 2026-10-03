/**
 * 家計診断 — FPに送る（第3段 6番）
 *
 * 選んだ1か月分の集計（収入の合計・カテゴリ別の合計・固定費・投資・積立）と、本人が入れたお名前を
 * LINEの id_token と一緒に GAS へ送る。GAS が本人確認をして、合計を計算し直してからシートに1行足す（gas/Code.gs）。
 * 明細1件ずつの中身は送らない（SPEC 5章）。
 * 送信の仕組みはヒアリングサイトと同じ：送信IDを付け、届いたか分からないときは同じIDのまま送り直す（二重にならない）
 */
const FpSend = (() => {
  // GAS が返す失敗の種類 → 画面に出す文
  const MESSAGES = {
    token: 'LINEの本人確認の期限が切れました。もう一度「送る」を押してください。',
    name: 'お名前を40文字以内で入れてください。',
    sendlimit: '今日はこれ以上送れません（1日10回まで）。明日またお試しください。',
    nosheet: '送信先の準備中です。しばらくお待ちください。',
  };

  /** 送る中身を作る（数字は calc.js の summarizeMonth の結果から取る） */
  function buildPayload(summary, month, name) {
    const categories = {};
    summary.categories.forEach((c) => (categories[c.key] = c.total));
    return {
      month,
      name,
      summary: {
        incomeTotal: summary.incomeTotal,
        investTotal: summary.investTotal,
        fixedTotal: summary.fixedTotal,
        categories,
      },
    };
  }

  /**
   * 通信の失敗や、GAS の応答の代わりに Google のエラーページが返った場合は、
   * 同じ送信IDのまま最大3回まで送り直す。GAS が {ok:false} を返したときは送り直さない
   */
  async function postWithRetry(body) {
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try {
        // text/plain で送ると、GAS への送信で事前確認（CORS のプリフライト）が発生しない
        const res = await fetch(ScanImport.GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body });
        return JSON.parse(await res.text());
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    throw lastErr;
  }

  /**
   * 送る。戻り値は { no: 受付番号 }
   * @param {string} idToken LINE の id_token
   * @param {string} sid 送信ID（1回の送信に1つ。送り直しでは同じ値を使う）
   */
  async function send(idToken, sid, payload) {
    let json;
    try {
      json = await postWithRetry(JSON.stringify({ action: 'send', idToken, sid, ...payload }));
    } catch (e) {
      throw new Error('送信の完了を確認できませんでした。電波の状態を確かめて、もう一度「送る」を押してください（何度押しても二重に届くことはありません）。');
    }
    if (!json.ok) {
      const err = new Error(MESSAGES[json.error] || '送れませんでした。もう一度お試しください。続く場合はLINEでお知らせください。');
      err.code = json.error;
      err.detail = json.detail;
      throw err;
    }
    return { no: json.no };
  }

  function newSendId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }

  return { buildPayload, send, newSendId };
})();
