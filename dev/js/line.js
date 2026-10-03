/**
 * 家計診断 — LINE（LIFF）まわり
 *
 * 役目は2つだけ（2026-10-03 決定）：
 *  1. LINEのメニュー（LIFF）から開かれたとき、Safari・Chrome へ案内する入口
 *  2. スクショ読み取り・FPに送るときだけ、LINEログインで本人を確かめる
 * 手入力・見える化・PDF はログインなしで使えるままにする。
 * LIFF の SDK は、LINEの中で開いたときとログインから戻ってきたときだけ読み込む
 * （Safari・Chrome でふつうに使う人には、LINEの部品を読み込ませない）。
 */
const LineAuth = (() => {
  const LIFF_ID = '2011842662-0lIvMV7g';
  const SDK_URL = 'https://static.line-scdn.net/liff/edge/2/sdk.js';

  let ready = null;

  /** LINEアプリの中のブラウザか（LINEは利用者の端末情報に「Line/」を含める） */
  function isLineBrowser() {
    return /\bLine\//i.test(navigator.userAgent);
  }

  /** LINEログインから戻ってきた直後か（LINEが URL に付ける印で見分ける） */
  function isLoginCallback() {
    const q = new URLSearchParams(location.search);
    return q.has('liffClientId') || q.has('liff.state') || (q.has('code') && q.has('state'));
  }

  /** 起動時に LIFF を準備するか。上の2つのときだけ */
  function shouldInitOnLoad() {
    return isLineBrowser() || isLoginCallback();
  }

  function loadSdk() {
    if (window.liff) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SDK_URL;
      s.onload = resolve;
      s.onerror = () => reject(new Error('sdk'));
      document.head.appendChild(s);
    });
  }

  /** LIFF を準備する。何度呼んでも1回だけ。失敗しても家計簿は使えるので false を返すだけ */
  function init() {
    if (!ready) {
      ready = loadSdk()
        .then(() => liff.init({ liffId: LIFF_ID }))
        .then(() => true)
        .catch(() => false);
    }
    return ready;
  }

  /** LIFF の画面（LINEの中）で開かれているか。準備できていなければ false */
  function isInClient() {
    return !!(window.liff && liff.isInClient && liff.isInClient());
  }

  /**
   * 外部ブラウザで開き直す。LIFF の中では liff.openWindow を使い、
   * それ以外の LINE の中のブラウザでは openExternalBrowser=1 付きの URL へ移る
   */
  async function openExternal(url) {
    if ((await init()) && isInClient()) {
      liff.openWindow({ url, external: true });
    } else {
      location.href = url;
    }
  }

  /**
   * 本人確認（スクショ読み取り・FPに送るの前に呼ぶ）。
   * ログイン済みなら { idToken, friend } を返す。未ログインなら LINEログインの画面へ移り、
   * 戻ってきたときに今の画面に戻る（このときは null を返す。呼んだ側は何もしない）。
   * friend は公式LINE「DAIFP 宮崎大輔」の友だちなら true（分からなければ null）。
   * id_token の確かめは GAS が読み取り・FP送信のたびに行う
   */
  async function signIn() {
    if (!(await init())) throw new Error('LINEにつながりませんでした。通信の状態を確かめて、もう一度お試しください。');
    if (!liff.isLoggedIn()) {
      liff.login({ redirectUri: location.href });
      return null;
    }
    const idToken = liff.getIDToken();
    if (!idToken) throw new Error('LINEの本人確認ができませんでした。もう一度お試しください。');
    let friend = null;
    try {
      friend = (await liff.getFriendship()).friendFlag;
    } catch (e) {
      friend = null;
    }
    return { idToken, friend };
  }

  return { isLineBrowser, shouldInitOnLoad, init, isInClient, openExternal, signIn };
})();
