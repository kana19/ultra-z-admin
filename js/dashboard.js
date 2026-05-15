/* ============================================================
 * ultra-z-admin / ダッシュボード（ユーザー一覧）スクリプト
 * 第6段階：dashboard.html のインライン<script>から抽出
 *   - 第5-C で確立した6シナリオ（空状態／再読み込み／アストラ／レオ／
 *     セッション失効遷移／認証エラー遷移）の挙動を完全維持
 *   - 認証エラー判定を AdminApp.handleAuthError 経由に集約
 *     （新action の code 形式・旧 listClients の error/detail.error 形式の両対応）
 *   - clients-table に「操作」列を追加し、各行に edit.html への遷移リンクを配置
 *
 * 依存：app.js → auth.js → dashboard.js の順で読み込むこと（HTML側で保証）。
 * ============================================================ */
(function () {
  'use strict';

  // セッション無ければ index.html へ（dashboard.html のガード）
  AdminAuth.bootstrapDashboardPage();

  // ---- DEBUG表示・ヘッダー初期化（旧インラインの冒頭処理） --------
  function initEnvInfo() {
    var ssidEl = document.getElementById('env-ssid');
    var gasEl = document.getElementById('env-gas');
    var verEl = document.getElementById('env-frontend-version');
    var expEl = document.getElementById('env-expire');
    if (ssidEl) ssidEl.textContent = AdminApp.MASTER_SSID || '—';
    if (gasEl) gasEl.textContent = AdminApp.MASTER_GAS_URL || '未設定';
    if (verEl) verEl.textContent = AdminApp.APP_VERSION || '—';
    if (expEl) expEl.textContent = AdminAuth.getSessionExpireText();
  }

  // ---- GAS Version 取得（doGet 経由） ---------------------------
  function initGasVersionFetch() {
    var el = document.getElementById('env-gas-version');
    if (!el) return;
    AdminApp.pingMasterGasGet().then(function (data) {
      if (data && data.version) {
        el.textContent = 'v' + data.version;
        el.classList.remove('debug-error');
      } else {
        el.textContent = '応答異常';
        el.classList.add('debug-error');
      }
    }).catch(function () {
      el.textContent = '取得失敗';
      el.classList.add('debug-error');
    });
  }

  // ---- ログアウト -----------------------------------------------
  function initLogoutButton() {
    var btn = document.getElementById('logout-btn');
    if (!btn) return;
    btn.addEventListener('click', function () { AdminAuth.logout(); });
  }

  // ---- 接続テスト（DEBUG用：本番運用時に削除検討） ---------------
  function initConnectionTest() {
    var resultEl = document.getElementById('ping-result');
    var getBtn = document.getElementById('ping-get-btn');
    var postBtn = document.getElementById('ping-post-btn');
    if (!resultEl || !getBtn || !postBtn) return;

    function showResult(label, payload, isError) {
      resultEl.hidden = false;
      resultEl.classList.toggle('conn-test__result--error', !!isError);
      var body;
      if (typeof payload === 'string') {
        body = payload;
      } else {
        try { body = JSON.stringify(payload, null, 2); }
        catch (_e) { body = String(payload); }
      }
      resultEl.textContent = '[' + label + ' ' + AdminApp.formatDateTime(AdminApp.nowMs()) + ']\n' + body;
    }

    function runPing(label, fn) {
      showResult(label, '実行中…', false);
      fn().then(function (res) {
        if (res && res.ok === false) {
          showResult(label + ' / GAS応答エラー', res, true);
        } else {
          showResult(label + ' / 成功', res, false);
        }
      }).catch(function (err) {
        var msg = (err && err.message) ? err.message : String(err);
        if (err && err.name === 'TypeError') {
          msg = 'マスタGASに到達できません（ネットワークまたはCORS）：' + msg;
        }
        showResult(label + ' / 失敗', msg, true);
      });
    }

    getBtn.addEventListener('click', function () { runPing('GET', AdminApp.pingMasterGasGet); });
    postBtn.addEventListener('click', function () { runPing('POST', AdminApp.pingMasterGasPost); });
  }

  // ============================================================
  // ユーザー一覧（clients）の読込・描画
  // ============================================================

  // network_error のみ自動1回リトライ
  async function fetchClientsListWithRetry() {
    var first = await AdminApp.fetchClientsList();
    if (first.ok === true) return first;
    var isNetworkErr = (first.code === 'network_error' || first.error === 'network_error');
    if (!isNetworkErr) return first;

    console.warn('[clients] first attempt failed (network_error), retrying in 1s...');
    await new Promise(function (r) { setTimeout(r, 1000); });

    var second = await AdminApp.fetchClientsList();
    if (second.ok === true) return second;
    return Object.assign({}, second, { _retryAttempted: true });
  }

  function escapeHTML(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function statusLabel(status) {
    switch (status) {
      case 'active':     return '稼働中';
      case 'suspended':  return '停止中';
      case 'terminated': return '終了';
      default:           return status || '-';
    }
  }

  function formatFee(fee) {
    if (fee == null || fee === '') return '-';
    var num = Number(fee);
    if (isNaN(num)) return String(fee);
    return '¥' + num.toLocaleString('ja-JP');
  }

  function renderClientsTable(clients) {
    var tbody = document.getElementById('clients-tbody');
    var rows = clients.map(function (c) {
      var grade = c.grade || 'unknown';
      var status = c.contractStatus || '';
      var safeId = escapeHTML(c.clientId);
      return [
        '<tr>',
          '<td class="td-clientId">' + safeId + '</td>',
          '<td>' + escapeHTML(c.storeName) + '</td>',
          '<td class="td-grade td-grade--' + escapeHTML(grade) + '">' + escapeHTML(grade) + '</td>',
          '<td class="td-num">' + (c.timecardCount != null && c.timecardCount !== '' ? escapeHTML(c.timecardCount) : '-') + '</td>',
          '<td class="td-status td-status--' + escapeHTML(status) + '">' + escapeHTML(statusLabel(status)) + '</td>',
          '<td class="td-fee">' + escapeHTML(formatFee(c.monthlyFee)) + '</td>',
          '<td>' + escapeHTML(c.contractStart) + '</td>',
          '<td class="td-action"><a href="edit.html?clientId=' + encodeURIComponent(c.clientId) + '" class="btn-edit">編集</a></td>',
        '</tr>'
      ].join('');
    });
    tbody.innerHTML = rows.join('');
  }

  function showClientsError(res) {
    var el = document.getElementById('clients-error');
    var msg = 'ユーザー一覧の取得に失敗しました。';
    var errKey = res.code || res.error;
    if (errKey === 'network_error') {
      msg = 'マスタGASに到達できません。ネットワーク接続を確認してください。';
    } else if (errKey) {
      msg = 'エラー: ' + errKey;
    }
    if (res._retryAttempted) {
      msg += '（自動再試行も失敗しました）';
    }
    el.innerHTML =
      '<p>' + escapeHTML(msg) + '</p>' +
      '<button type="button" class="btn-secondary" id="clients-retry-btn">もう一度試す</button>';
    el.hidden = false;
    document.getElementById('clients-retry-btn').addEventListener('click', loadClients);
  }

  async function loadClients() {
    var elLoading   = document.getElementById('clients-loading');
    var elError     = document.getElementById('clients-error');
    var elEmpty     = document.getElementById('clients-empty');
    var elTableWrap = document.getElementById('clients-table-wrap');
    var elCount     = document.getElementById('clients-count');

    elError.hidden = true;
    elEmpty.hidden = true;
    elTableWrap.hidden = true;
    elCount.hidden = true;
    elLoading.hidden = false;

    // セッションから pin が取れなければ強制ログアウト（callMasterGas が自動付与する前提だが
    // セッションそのものが無ければ pin も無いため事前ガード）
    var session = AdminAuth.getSession();
    if (!session || !session.pin) {
      AdminAuth.clearSession();
      location.replace('index.html');
      return;
    }

    var res = await fetchClientsListWithRetry();

    elLoading.hidden = true;

    // 認証エラー系は handleAuthError に委譲（旧形式 error/detail.error も内部で処理）
    if (AdminApp.handleAuthError(res)) return;

    if (!res.ok) {
      showClientsError(res);
      return;
    }

    if (!res.clients || res.clients.length === 0) {
      elEmpty.hidden = false;
      return;
    }

    renderClientsTable(res.clients);
    elTableWrap.hidden = false;
    elCount.textContent = res.clients.length + '件';
    elCount.hidden = false;
  }

  function initClientsList() {
    var refreshBtn = document.getElementById('clients-refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', loadClients);

    // 初回読込（bootstrapDashboardPage で済んでいるが念のため再確認）
    (async function () {
      if (!AdminAuth.isSessionValid()) {
        location.replace('index.html');
        return;
      }
      await loadClients();
    })();
  }

  // ---- エントリポイント ----------------------------------------
  // dashboard.html では body 末尾で script を読み込むため、DOM は parse 済。
  // ただし dashboard.html 内に DOMContentLoaded 待ちのコードが残っている可能性に備え、
  // readyState 判定で両ケースに対応する。
  function onReady(cb) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', cb);
    } else {
      cb();
    }
  }
  onReady(function () {
    initEnvInfo();
    initGasVersionFetch();
    initLogoutButton();
    initConnectionTest();
    initClientsList();
  });
})();
