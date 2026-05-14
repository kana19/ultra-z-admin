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

  var APP_VERSION = '0.5.5'; // 第5-C段階：ユーザー一覧表示
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
  // 使い方：
  //   AdminApp.callMasterGas('verifyAdminPin', { pin: '1234', accountType: 'target_admin' })
  //     .then(function (res) { ... });
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
    var body = Object.assign(
      { action: action, ts: new Date().toISOString() },
      extra || {}
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

  // ---- listClients ラッパー（第5-C） -------------------------
  /**
   * マスタGAS から target_admin 認証下で clients 一覧を取得する。
   *
   * @param {string} pin - sessionStorage 内のpinをそのまま渡す
   * @returns {Promise<Object>}
   *   成功:        { ok: true, clients: [...] }
   *   応答失敗:    { ok: false, error, ... }
   *   通信エラー:  { ok: false, error: 'network_error', _message, _raw }
   */
  async function fetchClientsList(pin) {
    try {
      return await callMasterGas('listClients', {
        pin: pin,
        accountType: 'target_admin'
      });
    } catch (err) {
      return {
        ok: false,
        error: 'network_error',
        _message: 'マスタGASに到達できません',
        _raw: err
      };
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
    pingMasterGasGet: pingMasterGasGet,
    pingMasterGasPost: pingMasterGasPost,
    fetchClientsList: fetchClientsList
  };
})(window);
