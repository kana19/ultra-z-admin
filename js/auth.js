/* ============================================================
 * ultra-z-admin / 認証・セッション層
 *  - マスタGAS（v0.3）への target_admin PIN認証呼び出し
 *  - sessionStorage セッション管理（有効期限 8 時間）
 *  - ログアウト
 *  - ログイン画面 3段階フィードバックバナー（info/warning/danger）
 *
 *  第5-B変更点：
 *   - モック認証撤去 → callMasterGas('verifyAdminPin', ...) 経由でGAS本呼出
 *   - セッション保存先 localStorage → sessionStorage（タブ閉鎖で消える）
 *   - セッション構造刷新（pin/accountType/scope 含む・1リクエストPIN方式対応）
 *   - PIN桁数バリデーション 4桁固定 → 4-8桁対応
 *
 *  グローバルに `AdminAuth` を公開する。
 * ============================================================ */
(function (global) {
  'use strict';

  var App = global.AdminApp;
  if (!App) {
    throw new Error('AdminAuth は AdminApp（js/app.js）より後に読み込んでください');
  }

  // ---- セッション操作（sessionStorage） ----------------------
  function readSession() {
    var raw = sessionStorage.getItem(App.SESSION_KEY);
    if (!raw) return null;
    var s = App.safeJsonParse(raw);
    if (!s || !s.expiresAt) return null;
    var expMs = new Date(s.expiresAt).getTime();
    if (!isFinite(expMs) || App.nowMs() >= expMs) {
      sessionStorage.removeItem(App.SESSION_KEY);
      return null;
    }
    return s;
  }

  function writeSession(session) {
    sessionStorage.setItem(App.SESSION_KEY, JSON.stringify(session));
  }

  function clearSession() {
    sessionStorage.removeItem(App.SESSION_KEY);
  }

  function isAuthenticated() {
    return !!readSession();
  }

  function getSessionExpireText() {
    var s = readSession();
    if (!s) return '—';
    return App.formatDateTime(new Date(s.expiresAt).getTime());
  }

  // ---- マスタGAS認証 ----------------------------------------
  /**
   * マスタGASに対してtarget_adminのPIN認証を実行する。
   *
   * @param {string} pin - 4-8桁の数字PIN
   * @returns {Promise<Object>} 認証結果
   *   成功:        { ok: true, accountType, scope }
   *   応答失敗:    { ok: false, error, failCount?, locked? }
   *   通信エラー:  { ok: false, error: 'network_error', _message, _raw }
   */
  async function verifyAdminPin(pin) {
    try {
      var result = await App.callMasterGas('verifyAdminPin', {
        pin: pin,
        accountType: 'target_admin'
      });
      return result;
    } catch (err) {
      return {
        ok: false,
        error: 'network_error',
        _message: 'マスタGASに到達できません（ネットワークまたはCORS）',
        _raw: err
      };
    }
  }

  // ---- ログイン処理 ------------------------------------------
  /**
   * PIN形式バリデーション → GAS認証 → セッション保存。
   * 戻り値は GAS応答そのもの（呼出側でバナー表示に分岐）。
   *
   * @param {string} pin
   * @returns {Promise<Object>} GAS応答（ok:true で session 保存済み）
   */
  function login(pin) {
    pin = String(pin || '');
    if (!/^[0-9]{4,8}$/.test(pin)) {
      return Promise.resolve({ ok: false, error: 'pin format invalid' });
    }
    return verifyAdminPin(pin).then(function (res) {
      if (res && res.ok) {
        var nowMs = App.nowMs();
        // セッション内の pin は listClients 等のCRUD呼出時に毎回送信する用途
        // （マスタGAS v0.3の1リクエストPIN認証方式に対応）。
        // sessionStorageに平文保存することで以下を担保：
        //   - タブを閉じれば消える（PC離席時の漏洩リスク低減）
        //   - XSS被害時はセッション期限まで（8時間）に限定
        //   - パートナー認証段階（段階3）でトークン方式に移行検討。
        var session = {
          authenticated: true,
          accountType: res.accountType || 'target_admin',
          scope: res.scope || 'all',
          pin: pin,
          loginAt: new Date(nowMs).toISOString(),
          expiresAt: new Date(nowMs + App.SESSION_TTL_MS).toISOString()
        };
        writeSession(session);
      }
      return res;
    });
  }

  function logout() {
    clearSession();
    location.href = 'index.html';
  }

  // ---- バナーメッセージ判定 ----------------------------------
  // 仕様（5-B確定）：
  //   失敗回数(failCount) 残り回数 = 5 - failCount
  //   - 残り4回           : info     （グレー）
  //   - 残り3回           : warning  （黄色）
  //   - 残り2回・1回      : danger   （赤・先頭 ⚠ プレフィックス）
  //   - 残り0回(ロック発動): danger
  function _resolveFeedback(res) {
    var fc = Number((res && res.failCount) || 0);
    var error = (res && res.error) || '';

    if (error === 'pin format invalid' || error.indexOf('format invalid') >= 0) {
      return { level: 'info', message: 'PINは4〜8桁の数字で入力してください' };
    }
    if (error === 'pin mismatch' && (res && res.locked === true)) {
      return {
        level: 'danger',
        message: 'アカウントがロックされました。管理者にロック解除を依頼してください'
      };
    }
    if (error === 'account locked' || (res && res.locked === true)) {
      return {
        level: 'danger',
        message: 'アカウントがロックされています。管理者にロック解除を依頼してください'
      };
    }
    if (error === 'pin mismatch') {
      var remain = Math.max(0, 5 - fc);
      var level = (remain >= 4) ? 'info' : (remain === 3 ? 'warning' : 'danger');
      var prefix = (remain <= 2) ? '⚠ ' : '';
      return {
        level: level,
        message: prefix + 'PINが違います。残り' + remain + '回でロックされます'
      };
    }
    if (error === 'initial setup required') {
      return {
        level: 'warning',
        message: 'マスタPINが未登録です。Apps Scriptで初回設定を実行してください'
      };
    }
    if (error === 'network_error') {
      return {
        level: 'danger',
        message: 'マスタGASに到達できません。ネットワーク接続を確認してください'
      };
    }
    return {
      level: 'danger',
      message: '認証に失敗しました（' + (error || 'unknown') + '）'
    };
  }

  // ---- 画面ブートストラップ ----------------------------------
  // index.html 用：既にセッション有効ならダッシュボードへリダイレクト、
  // そうでなければログインフォームに submit ハンドラを取り付ける。
  function bootstrapLoginPage() {
    if (isAuthenticated()) {
      location.href = 'dashboard.html';
      return;
    }
    document.addEventListener('DOMContentLoaded', function () {
      var form = document.getElementById('login-form');
      var input = document.getElementById('login-pin');
      var submit = document.getElementById('login-submit');
      var feedbackEl = document.getElementById('login-feedback');
      if (!form || !input || !submit || !feedbackEl) return;

      function showFeedback(message, level) {
        feedbackEl.textContent = message;
        feedbackEl.className = 'login-feedback login-feedback--' + level;
        feedbackEl.hidden = false;
      }
      function clearFeedback() {
        feedbackEl.textContent = '';
        feedbackEl.className = 'login-feedback';
        feedbackEl.hidden = true;
      }

      // 入力中は数字以外を弾く（最大8桁）
      input.addEventListener('input', function () {
        var v = input.value.replace(/\D+/g, '').slice(0, 8);
        if (v !== input.value) input.value = v;
        clearFeedback();
      });

      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        clearFeedback();
        submit.disabled = true;
        submit.textContent = '認証中…';

        login(input.value).then(function (res) {
          if (res && res.ok) {
            location.href = 'dashboard.html';
            return;
          }
          var fb = _resolveFeedback(res);
          showFeedback(fb.message, fb.level);
          submit.disabled = false;
          submit.textContent = 'ログイン';
        }).catch(function (err) {
          // login() 自体は基本 reject しない設計だが念のため
          showFeedback(
            '予期しないエラー：' + (err && err.message ? err.message : String(err)),
            'danger'
          );
          submit.disabled = false;
          submit.textContent = 'ログイン';
        });
      });

      input.focus();
    });
  }

  // dashboard.html 用：セッションが無ければログイン画面へ戻す。
  function bootstrapDashboardPage() {
    var s = readSession();
    if (!s) {
      location.href = 'index.html';
      return;
    }
    document.addEventListener('DOMContentLoaded', function () {
      var nameEl = document.getElementById('header-user');
      if (nameEl) nameEl.textContent = '管理者';
    });
  }

  // ---- 公開 --------------------------------------------------
  global.AdminAuth = {
    login: login,
    logout: logout,
    isAuthenticated: isAuthenticated,
    readSession: readSession,
    getSessionExpireText: getSessionExpireText,
    bootstrapLoginPage: bootstrapLoginPage,
    bootstrapDashboardPage: bootstrapDashboardPage
  };
})(window);
