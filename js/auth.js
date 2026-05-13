/* ============================================================
 * ultra-z-admin / 認証・セッション層
 *  - マスタPINログイン処理（第4段階はモック実装）
 *  - localStorage セッション管理（有効期限 8 時間）
 *  - ログアウト
 *
 *  グローバルに `AdminAuth` を公開する。
 * ============================================================ */
(function (global) {
  'use strict';

  var App = global.AdminApp;
  if (!App) {
    throw new Error('AdminAuth は AdminApp（js/app.js）より後に読み込んでください');
  }

  // ---- セッション操作 ----------------------------------------
  function readSession() {
    var raw = localStorage.getItem(App.SESSION_KEY);
    if (!raw) return null;
    var s = App.safeJsonParse(raw);
    if (!s || typeof s.expireAt !== 'number') return null;
    if (App.nowMs() >= s.expireAt) {
      // 期限切れは破棄
      localStorage.removeItem(App.SESSION_KEY);
      return null;
    }
    return s;
  }

  function writeSession(session) {
    localStorage.setItem(App.SESSION_KEY, JSON.stringify(session));
  }

  function clearSession() {
    localStorage.removeItem(App.SESSION_KEY);
  }

  function isAuthenticated() {
    return !!readSession();
  }

  function getSessionExpireText() {
    var s = readSession();
    return s ? App.formatDateTime(s.expireAt) : '—';
  }

  // ---- ログイン処理 -------------------------------------------
  // 第4段階：モック認証
  //   - 「4桁の数字」かどうかだけバリデーション
  //   - 形式が合えば何でも通る
  //   - GAS実装後は callMasterGas('login', { pin }) に差し替え
  //
  // ★差し替えポイント（マスタGAS デプロイ後）★
  //   App.callMasterGas('login', { pin: pin })
  //     .then(function (res) {
  //       if (res && res.ok) { writeSession({ ... }); return true; }
  //       throw new Error(res && res.error ? res.error : '認証失敗');
  //     });
  function login(pin) {
    return new Promise(function (resolve, reject) {
      if (!/^\d{4}$/.test(String(pin || ''))) {
        reject(new Error('PINは4桁の数字で入力してください'));
        return;
      }
      // --- ここから先は GAS 実装後に差し替え ---
      var session = {
        userId: 'mock-admin',
        userName: '管理者（モック）',
        loginAt: App.nowMs(),
        expireAt: App.nowMs() + App.SESSION_TTL_MS,
        mock: true
      };
      writeSession(session);
      resolve(session);
      // --- 差し替え区間ここまで ---
    });
  }

  function logout() {
    clearSession();
    location.href = 'index.html';
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
      var alertBox = document.getElementById('login-alert');
      if (!form || !input || !submit || !alertBox) return;

      function showError(msg) {
        alertBox.textContent = msg;
        alertBox.hidden = false;
      }
      function clearError() {
        alertBox.textContent = '';
        alertBox.hidden = true;
      }

      // 入力中は数字以外を弾く
      input.addEventListener('input', function () {
        var v = input.value.replace(/\D+/g, '').slice(0, 4);
        if (v !== input.value) input.value = v;
        clearError();
      });

      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        clearError();
        submit.disabled = true;
        submit.textContent = '認証中…';
        login(input.value).then(function () {
          location.href = 'dashboard.html';
        }).catch(function (err) {
          showError(err && err.message ? err.message : '認証に失敗しました');
          submit.disabled = false;
          submit.textContent = 'ログイン';
        });
      });

      // 初期フォーカス
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
      if (nameEl) nameEl.textContent = s.userName || '管理者';
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
