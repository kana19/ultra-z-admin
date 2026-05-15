/* ============================================================
 * ultra-z-admin / 共通アプリ層
 *  - マスタGAS接続定数
 *  - callMasterGas(action, payload) ラッパー
 *  - 共通ユーティリティ
 *
 *  ES Modules は使わない（GitHub Pages 静的配信を優先）。
 *  グローバルに `AdminApp` を公開する。
 * ============================================================ */
(function (global) {
  'use strict';

  // ---- 定数 ----------------------------------------------------
  // マスタGAS（ultra-z-master v0.2）の Webアプリ URL。
  // 不変原則：このURLは固定。GAS更新時は「既存デプロイの新バージョン化」で対応する。
  var MASTER_GAS_URL = 'https://script.google.com/macros/s/AKfycbyZTQH6E_JIgHqigCbbfQHScJoxBFVKdJOX80WM6SNRlmLCmOjLxsKKkRRff0_gLrQ/exec';

  // マスタスプレッドシートID（k@tgx.jp 所有・第2段階で構築済み）
  var MASTER_SSID = '1g6-6u9YOrgKHZrJByW9mAfuvTlSVWchx_VV8-O9MJ5Q';

  var APP_VERSION = '0.6.0'; // 第6段階：ユーザー編集（運用情報タブ・スタッフ編集）
  var SESSION_KEY = 'ultra-z-admin.session';
  var SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8時間

  // ---- ユーティリティ ----------------------------------------
  function nowMs() {
    return Date.now();
  }

  function safeJsonParse(str) {
    try { return JSON.parse(str); } catch (_e) { return null; }
  }

  function formatDateTime(ms) {
    if (!ms) return '—';
    var d = new Date(ms);
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  // ---- マスタGAS呼び出しラッパー -----------------------------
  // 第5-B変更：ネスト構造 {action, payload, ts} → フラット構造 {action, ...extra, ts}
  // 理由：マスタGAS v0.3 doPost は params.pin / params.accountType を直接参照するため、
  //       payload にネストすると params.pin = undefined になり認証が必ず失敗する。
  //
  // 第6段階変更：呼出側が pin を毎回明示する負担を減らすため、extra に pin が無い場合は
  //              sessionStorage から自動付与する（CRUD 系 action 向け）。verifyAdminPin
  //              （ログイン時）は extra に pin を明示で渡すので影響なし。
  //
  // 使い方：
  //   AdminApp.callMasterGas('verifyAdminPin', { pin: '1234', accountType: 'target_admin' })
  //     .then(function (res) { ... });
  //   // または CRUD 系（pin 自動付与）：
  //   AdminApp.callMasterGas('getClient', { clientId: 'uz-xxxx' })
  //
  // 送信される body：
  //   {"action":"verifyAdminPin","ts":"2026-05-14T...","pin":"1234","accountType":"target_admin"}
  //
  // CORSメモ：Content-Type は意図的に未指定。指定するとプリフライト(OPTIONS)が発火し、
  //          GAS Webアプリ側に OPTIONS ハンドラがないため失敗する。
  async function callMasterGas(action, extra) {
    if (!MASTER_GAS_URL) {
      throw new Error('MASTER_GAS_URL is not configured');
    }
    extra = extra || {};

    // セッションから pin / accountType を自動付与（extra に明示があれば extra 優先）
    var sessionDefaults = {};
    if (extra.pin === undefined) {
      var auth = global.AdminAuth;
      var sess = (auth && auth.getSession) ? auth.getSession() : null;
      if (sess && sess.pin) {
        sessionDefaults.pin = sess.pin;
        sessionDefaults.accountType = sess.accountType || 'target_admin';
      }
    }

    var body = Object.assign(
      { action: action, ts: new Date().toISOString() },
      sessionDefaults,
      extra
    );
    var res = await fetch(MASTER_GAS_URL, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      throw new Error('HTTP ' + res.status + ' ' + res.statusText);
    }
    return await res.json();
  }

  // ---- 認証エラー共通ハンドラ（第6段階） ---------------------
  // セッション失効・PIN不一致・アカウントロック等を検出し、強制的に index.html へ遷移。
  //
  // 対応するエラー応答形式（両方）：
  //   新形式（v0.4.0 新action）: { ok:false, code: 'pin_mismatch' | 'account_locked' |
  //                                'initial_setup_required' | 'auth_failed', ... }
  //   旧形式（listClients 等）  : { ok:false, error: 'pin mismatch' | 'account locked' |
  //                                'initial setup required' | 'auth failed', ... }
  //                              ＋入れ子 res.detail.error も同様
  //
  // 戻り値：認証エラーで遷移処理を発火した場合 true、そうでなければ false
  //         呼出側は `if (AdminApp.handleAuthError(res)) return;` の慣用句で使う
  function handleAuthError(res) {
    if (!res || res.ok) return false;

    var newCodes = ['pin_mismatch', 'account_locked', 'initial_setup_required', 'auth_failed'];
    var oldErrors = ['pin mismatch', 'account locked', 'initial setup required', 'auth failed'];

    var hit = false;
    if (res.code && newCodes.indexOf(res.code) >= 0) hit = true;
    if (!hit && res.error && oldErrors.indexOf(res.error) >= 0) hit = true;
    if (!hit && res.detail && res.detail.error && oldErrors.indexOf(res.detail.error) >= 0) hit = true;

    if (hit) {
      try { sessionStorage.removeItem(SESSION_KEY); } catch (_e) { /* ignore */ }
      location.replace('index.html');
      return true;
    }
    return false;
  }

  // ---- 疎通確認関数（DEBUG用：本番運用時に削除検討） ----------
  // GAS Web Apps の CORS 挙動メモ：
  //   - fetch 時に Content-Type: application/json を付けるとプリフライト（OPTIONS）が走り、
  //     GAS 側に OPTIONS ハンドラがないため失敗する。
  //   - そのため POST 時も Content-Type ヘッダーは明示的に付けない
  //     （または text/plain にしてプリフライトを回避する）。
  //   - doPost 側は e.postData.contents から生文字列を取得し JSON.parse する。

  /**
   * マスタGAS との疎通確認（GET）。doGet の応答を取得する。
   * @returns {Promise<Object>} GASからのJSON応答
   */
  function pingMasterGasGet() {
    return fetch(MASTER_GAS_URL, { method: 'GET' })
      .then(function (res) {
        if (!res.ok) { throw new Error('GAS HTTP ' + res.status); }
        return res.text();
      })
      .then(function (txt) {
        var parsed = safeJsonParse(txt);
        if (parsed === null) {
          throw new Error('応答がJSONではありません：' + txt.slice(0, 200));
        }
        return parsed;
      });
  }

  /**
   * マスタGAS との疎通確認（POST）。doPost の action=ping を叩く。
   * @returns {Promise<Object>} GASからのJSON応答
   */
  function pingMasterGasPost() {
    // 注意：Content-Type ヘッダーは付けない（GAS Web アプリの CORS プリフライト回避のため）
    return fetch(MASTER_GAS_URL, {
      method: 'POST',
      body: JSON.stringify({ action: 'ping', echo: 'hello' })
    })
      .then(function (res) {
        if (!res.ok) { throw new Error('GAS HTTP ' + res.status); }
        return res.text();
      })
      .then(function (txt) {
        var parsed = safeJsonParse(txt);
        if (parsed === null) {
          throw new Error('応答がJSONではありません：' + txt.slice(0, 200));
        }
        return parsed;
      });
  }

  // ---- listClients ラッパー（第5-C・第6段階で pin 任意化） ---
  /**
   * マスタGAS から target_admin 認証下で clients 一覧を取得する。
   * 第6段階以降は pin 引数を省略可（callMasterGas がセッションから自動付与）。
   *
   * @param {string=} pin - 明示する場合のみ渡す（通常はセッションから自動付与される）
   * @returns {Promise<Object>}
   *   成功:        { ok: true, clients: [...] }
   *   応答失敗:    { ok: false, error, ... }
   *   通信エラー:  { ok: false, error: 'network_error', _message, _raw }
   */
  async function fetchClientsList(pin) {
    try {
      var extra = { accountType: 'target_admin' };
      if (pin !== undefined && pin !== null) extra.pin = pin;
      return await callMasterGas('listClients', extra);
    } catch (err) {
      return {
        ok: false,
        error: 'network_error',
        _message: 'マスタGASに到達できません',
        _raw: err
      };
    }
  }

  // ---- 新action ラッパー（v0.4.0・第6段階） ------------------
  // 通信エラー共通整形
  function _wrapNetworkError_(err) {
    return {
      ok: false,
      code: 'network_error',
      error: 'network_error',
      _message: 'マスタGASに到達できません',
      _raw: err
    };
  }

  // network_error の場合のみ 1秒後に1回だけリトライする汎用ヘルパー
  async function _withRetry_(fn) {
    var first = await fn();
    if (first && first.ok === true) return first;
    // network_error 判定：新形式 code または旧形式 error
    var isNetworkErr = (first && (first.code === 'network_error' || first.error === 'network_error'));
    if (!isNetworkErr) return first;

    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[callMasterGas] first attempt failed (network_error), retrying in 1s...');
    }
    await new Promise(function (r) { setTimeout(r, 1000); });
    var second = await fn();
    if (second && second.ok === true) return second;
    return Object.assign({}, second, { _retryAttempted: true });
  }

  /**
   * 単一クライアントの詳細を取得する。
   * @param {string} clientId
   */
  async function fetchClient(clientId) {
    try {
      return await callMasterGas('getClient', { clientId: clientId });
    } catch (err) {
      return _wrapNetworkError_(err);
    }
  }
  async function fetchClientWithRetry(clientId) {
    return _withRetry_(function () { return fetchClient(clientId); });
  }

  /**
   * 指定クライアントのスタッフリストを取得する（マスタGAS→ユーザーGAS プロキシ）。
   * @param {string} clientId
   */
  async function fetchUserStaffList(clientId) {
    try {
      return await callMasterGas('getUserStaffList', { clientId: clientId });
    } catch (err) {
      return _wrapNetworkError_(err);
    }
  }
  async function fetchUserStaffListWithRetry(clientId) {
    return _withRetry_(function () { return fetchUserStaffList(clientId); });
  }

  /**
   * 指定クライアントのスタッフリストを更新する（マスタGAS→ユーザーGAS プロキシ）。
   * 破壊的操作のためリトライは行わない（重複書込リスク回避）。
   *
   * @param {string} clientId
   * @param {Array}  staffList
   */
  async function updateUserStaffList(clientId, staffList) {
    try {
      return await callMasterGas('updateUserStaffList', {
        clientId: clientId,
        staffList: staffList
      });
    } catch (err) {
      return _wrapNetworkError_(err);
    }
  }

  // ---- 公開 --------------------------------------------------
  global.AdminApp = {
    MASTER_GAS_URL: MASTER_GAS_URL,
    MASTER_SSID: MASTER_SSID,
    APP_VERSION: APP_VERSION,
    SESSION_KEY: SESSION_KEY,
    SESSION_TTL_MS: SESSION_TTL_MS,
    nowMs: nowMs,
    safeJsonParse: safeJsonParse,
    formatDateTime: formatDateTime,
    callMasterGas: callMasterGas,
    handleAuthError: handleAuthError,
    pingMasterGasGet: pingMasterGasGet,
    pingMasterGasPost: pingMasterGasPost,
    fetchClientsList: fetchClientsList,
    fetchClient: fetchClient,
    fetchClientWithRetry: fetchClientWithRetry,
    fetchUserStaffList: fetchUserStaffList,
    fetchUserStaffListWithRetry: fetchUserStaffListWithRetry,
    updateUserStaffList: updateUserStaffList
  };
})(window);
