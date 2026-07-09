/* ============================================================
 * ultra-z-admin / ダッシュボード（ユーザー一覧）スクリプト
 *
 * 第7段階 6-H：dashboard アプリURL列・展開▼ボタン
 *   - clients-table に「アプリURL」列を追加（マスタ枠列と操作列の間）
 *   - 「展開▼」ボタンで以下を行下にインライン展開：
 *       オーナーアプリ（スマホ・iPad）：https://app.ultra7.pw/{clientId}/
 *       オーナーアプリ（PC版）：https://app.ultra7.pw/{clientId}/pc/
 *       スタッフ子アカウント（タイムカード数分・TC=0 アストラでは非表示）：
 *         https://app.ultra7.pw/{clientId}/staff-clockin.html?staff=sNNN
 *   - 各URLにコピーボタン
 *   - 代理ログインURL（一時URL）は本テーブル外・別操作で発行（QR表示は将来拡張）
 *   - 04_運営ポータル.md §2-2 / 06_環境.md §2-1 に整合
 *
 * 6-E：販管費任意枠5件固定化＋マスタ枠表示 S/P 2軸化
 *   - clients-table「マスタ枠」セルは S/P 2軸表示
 *   - C列 costOptionalQuota は税務署様式準拠で5固定・テーブル表示から省略
 *
 * 第5-C で確立した6シナリオ（空状態／再読み込み／アストラ／レオ／
 *   セッション失効遷移／認証エラー遷移）の挙動を完全維持。
 *
 * 依存：app.js → auth.js → dashboard.js の順で読み込むこと（HTML側で保証）。
 * ============================================================ */
(function () {
  'use strict';

  // セッション無ければ index.html へ
  AdminAuth.bootstrapDashboardPage();

  // ユーザー側公開URL ベース（app.ultra7.pw＝GitHub Pages カスタムドメイン・2026-07-09〜。旧 kana19.github.io は自動リダイレクト。→ 04_運営ポータル.md §1-0）
  var USER_PWA_BASE = 'https://app.ultra7.pw/';

  // ---- DEBUG表示・ヘッダー初期化 --------
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

  // ---- 接続テスト（DEBUG用） ---------------------------
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
      case 'terminated': return '解約済';
      default:           return status || '-';
    }
  }

  function formatFee(fee) {
    if (fee == null || fee === '') return '-';
    var num = Number(fee);
    if (isNaN(num)) return String(fee);
    return '¥' + num.toLocaleString('ja-JP');
  }

  // 6-H：staffId padding（s001〜sNNN）
  function padStaffId(n) {
    return 's' + String(n).padStart(3, '0');
  }

  // 6-H：URL展開行を生成（インライン展開・行下に挿入）
  function buildUrlListRowHtml(clientId, timecardCount) {
    var safeClientId = escapeHTML(clientId);
    var safeClientIdEnc = encodeURIComponent(clientId);
    var ownerUrl = USER_PWA_BASE + safeClientIdEnc + '/';
    var pcUrl = USER_PWA_BASE + safeClientIdEnc + '/pc/';
    var tc = parseInt(timecardCount, 10) || 0;

    var staffRows = '';
    if (tc > 0) {
      var staffItems = [];
      for (var i = 1; i <= tc; i++) {
        var staffId = padStaffId(i);
        var staffUrl = USER_PWA_BASE + safeClientIdEnc + '/staff-clockin.html?staff=' + staffId;
        staffItems.push(
          '<div class="url-list-item">' +
            '<span class="url-list-item__label">' + staffId + '</span>' +
            '<span class="url-list-item__url">' + escapeHTML(staffUrl) + '</span>' +
            '<button type="button" class="url-list-item__copy" data-copy-url="' + escapeHTML(staffUrl) + '">コピー</button>' +
          '</div>'
        );
      }
      staffRows =
        '<div class="url-list-group">' +
          '<h4 class="url-list-group-title">スタッフ子アカウント（' + tc + '名分）</h4>' +
          staffItems.join('') +
        '</div>';
    } else {
      staffRows =
        '<div class="url-list-group">' +
          '<h4 class="url-list-group-title">スタッフ子アカウント</h4>' +
          '<p class="url-list-staff-empty">タイムカード数 0（アストラ）のため発行なし</p>' +
        '</div>';
    }

    return [
      '<tr class="tr-url-list" data-url-list-for="' + safeClientId + '" hidden>',
        '<td colspan="14" class="url-list-cell">',
          '<div class="url-list-group">',
            '<h4 class="url-list-group-title">オーナーアプリ</h4>',
            '<div class="url-list-item">',
              '<span class="url-list-item__label">スマホ・iPad</span>',
              '<span class="url-list-item__url">' + escapeHTML(ownerUrl) + '</span>',
              '<button type="button" class="url-list-item__copy" data-copy-url="' + escapeHTML(ownerUrl) + '">コピー</button>',
            '</div>',
            '<div class="url-list-item">',
              '<span class="url-list-item__label">PC版</span>',
              '<span class="url-list-item__url">' + escapeHTML(pcUrl) + '</span>',
              '<button type="button" class="url-list-item__copy" data-copy-url="' + escapeHTML(pcUrl) + '">コピー</button>',
            '</div>',
          '</div>',
          staffRows,
        '</td>',
      '</tr>'
    ].join('');
  }

  function renderClientsTable(clients) {
    var tbody = document.getElementById('clients-tbody');
    var rows = clients.map(function (c) {
      var grade = c.grade || 'unknown';
      var status = c.contractStatus || '';
      var safeId = escapeHTML(c.clientId);
      // マスタ件数枠（運営内部管理・2軸 S/P 表示）
      var smq = (c.serviceMasterQuota != null && c.serviceMasterQuota !== '')
        ? Number(c.serviceMasterQuota) : 5;
      var pmq = (c.purchaseMasterQuota != null && c.purchaseMasterQuota !== '')
        ? Number(c.purchaseMasterQuota) : 3;
      var quotaExpanded = (smq > 5 || pmq > 3);
      var quotaCellClass = 'td-quota' + (quotaExpanded ? ' td-quota--expanded' : '');
      var quotaTitle = 'サービスマスタ ' + smq + ' 件 / '
                     + '仕入原価マスタ ' + pmq + ' 件'
                     + '（販管費マスタ任意枠は5件固定・税務署様式準拠）';
      var quotaCell = '<td class="' + quotaCellClass + '" title="' + escapeHTML(quotaTitle) + '">'
        + escapeHTML(smq) + '<span class="quota-sep">/</span>'
        + escapeHTML(pmq)
        + '</td>';
      // 6-H：URL展開列
      var urlCell = '<td class="td-app-url">'
        + '<button type="button" class="btn-url-expand" data-toggle-url-list="' + safeId + '" aria-expanded="false">展開▼</button>'
        + '</td>';
      // 備考メモ列（インライン編集）
      var memoCell = '<td class="td-memo">'
        + '<input type="text" class="memo-input" data-memo-client="' + safeId + '" '
        + 'value="' + escapeHTML(c.memo || '') + '" placeholder="メモ" maxlength="100">'
        + '</td>';
      // 操作列：編集のみ（納品カード再発行・停止/再開・完全削除は編集画面に集約）
      var actionCell = '<td class="td-action">'
        + '<a href="edit.html?clientId=' + encodeURIComponent(c.clientId) + '" class="btn-edit">編集</a>'
        + '</td>';
      // 登録日時（createdAt・西暦月日＋時刻の2行。空は '—'：createdAt 列導入前の旧データ）
      var createdCell;
      if (c.createdAt) {
        var ca = String(c.createdAt).split(' ');
        createdCell = '<td class="td-created"><div>' + escapeHTML(ca[0] || '')
          + '</div><div class="td-created__time">' + escapeHTML(ca[1] || '') + '</div></td>';
      } else {
        createdCell = '<td class="td-created">—</td>';
      }
      // 段2 証明QR / 段3 シフト（master clients の複製フラグ・未設定は '—'）
      var qrCell = '<td class="td-feat' + (c.qrProofEnabled ? '' : ' td-feat--off') + '">'
        + (c.qrProofEnabled ? '📍' : '—') + '</td>';
      var shiftCell = '<td class="td-feat' + (c.shiftScheduleEnabled ? '' : ' td-feat--off') + '">'
        + (c.shiftScheduleEnabled ? '🗓' : '—') + '</td>';
      var trClass = status === 'suspended' ? ' class="tr-client--suspended"'
                  : (status === 'terminated' ? ' class="tr-client--terminated"' : '');
      var clientRow = [
        '<tr' + trClass + '>',
          '<td class="td-clientId">' + safeId + '</td>',
          '<td>' + escapeHTML(c.storeName) + '</td>',
          '<td class="td-grade td-grade--' + escapeHTML(grade) + '">' + escapeHTML(grade) + '</td>',
          '<td class="td-num">' + (c.timecardCount != null && c.timecardCount !== '' ? escapeHTML(c.timecardCount) : '-') + '</td>',
          qrCell,
          shiftCell,
          '<td class="td-status td-status--' + escapeHTML(status) + '">' + escapeHTML(statusLabel(status)) + '</td>',
          '<td class="td-fee">' + escapeHTML(formatFee(c.monthlyFee)) + '</td>',
          '<td>' + escapeHTML(c.contractStart) + '</td>',
          createdCell,
          quotaCell,
          urlCell,
          memoCell,
          actionCell,
        '</tr>'
      ].join('');
      var urlListRow = buildUrlListRowHtml(c.clientId, c.timecardCount);
      return clientRow + urlListRow;
    });
    tbody.innerHTML = rows.join('');
    bindUrlListEvents();
    bindMemoEvents();
  }

  // ============================================================
  // 全体サマリー帯＋契約期限60日通知（→ 04_運営ポータル.md §1/§134）
  // ============================================================
  function _daysUntil(dateStr) {
    if (!dateStr) return null;
    var d = new Date(String(dateStr) + 'T00:00:00');
    if (isNaN(d.getTime())) return null;
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((d.getTime() - today.getTime()) / 86400000);
  }

  function renderSummary() {
    var summaryEl = document.getElementById('dash-summary');
    var active = allClients.filter(function (c) { return (c.contractStatus || 'active') === 'active'; });
    // 期限60日以内（稼働中・期限日が今日以降60日以内）
    var nearList = active.filter(function (c) {
      var dleft = _daysUntil(c.contractEnd);
      return dleft != null && dleft >= 0 && dleft <= 60;
    }).sort(function (a, b) { return _daysUntil(a.contractEnd) - _daysUntil(b.contractEnd); });
    var revenue = active.reduce(function (sum, c) {
      var f = Number(c.monthlyFee);
      return sum + (isNaN(f) ? 0 : f);
    }, 0);

    var setText = function (id, txt) { var el = document.getElementById(id); if (el) el.innerHTML = txt; };
    setText('sum-active', active.length + '<span class="summary-card__unit">店</span>');
    setText('sum-deadline', nearList.length + '<span class="summary-card__unit">店</span>');
    setText('sum-revenue', '¥' + revenue.toLocaleString('ja-JP'));
    if (summaryEl) summaryEl.hidden = false;

    // 期限60日通知リスト
    var noticeEl = document.getElementById('deadline-notice');
    var listEl = document.getElementById('deadline-list');
    if (noticeEl && listEl) {
      if (nearList.length === 0) {
        noticeEl.hidden = true;
        listEl.innerHTML = '';
      } else {
        listEl.innerHTML = nearList.map(function (c) {
          var dleft = _daysUntil(c.contractEnd);
          return '<div class="deadline-notice__item">'
            + '<span class="deadline-notice__store">' + escapeHTML(c.storeName || c.clientId) + '</span>'
            + '<span class="deadline-notice__days">あと' + dleft + '日</span>'
            + '<span class="deadline-notice__date">' + escapeHTML(c.contractEnd || '') + '</span>'
            + '</div>';
        }).join('');
        noticeEl.hidden = false;
      }
    }
  }

  // 6-H：URL展開ボタン・コピーボタンのイベント委譲
  function bindUrlListEvents() {
    var tbody = document.getElementById('clients-tbody');
    if (!tbody) return;

    // 展開▼ボタン
    tbody.addEventListener('click', function (e) {
      var target = e.target;
      // 展開ボタン
      var expandClientId = target.getAttribute && target.getAttribute('data-toggle-url-list');
      if (expandClientId) {
        var listRow = tbody.querySelector('[data-url-list-for="' + expandClientId + '"]');
        if (listRow) {
          var isOpen = !listRow.hidden;
          listRow.hidden = isOpen;
          target.setAttribute('aria-expanded', String(!isOpen));
          target.textContent = isOpen ? '展開▼' : '閉じる▲';
        }
        return;
      }
      // コピーボタン
      var copyUrl = target.getAttribute && target.getAttribute('data-copy-url');
      if (copyUrl) {
        copyToClipboard(copyUrl, target);
        return;
      }
    });
  }

  // 6-H：クリップボードコピー（Clipboard API・フォールバック付き）
  function copyToClipboard(text, btnEl) {
    var done = function () {
      if (btnEl) {
        btnEl.classList.add('url-list-item__copy--copied');
        var orig = btnEl.textContent;
        btnEl.textContent = '✓';
        setTimeout(function () {
          btnEl.classList.remove('url-list-item__copy--copied');
          btnEl.textContent = orig;
        }, 1500);
      }
      showCopyToast();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () {
        fallbackCopy(text, done);
      });
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, onDone) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      if (onDone) onDone();
    } catch (e) {
      console.warn('clipboard copy failed', e);
    }
  }

  var copyToastTimer = null;
  function showCopyToast() {
    var t = document.getElementById('copy-toast');
    if (!t) return;
    t.hidden = false;
    if (copyToastTimer) clearTimeout(copyToastTimer);
    copyToastTimer = setTimeout(function () { t.hidden = true; }, 1800);
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

  // 全件キャッシュ（フィルタ/検索/ソートはフロント側で適用）
  var allClients = [];

  function getViewState() {
    var searchEl = document.getElementById('clients-search');
    var sortEl = document.getElementById('clients-sort');
    var filterEl = document.getElementById('clients-filter');
    return {
      search: (searchEl && searchEl.value ? searchEl.value.trim().toLowerCase() : ''),
      sort: (sortEl ? sortEl.value : 'registered-desc'),
      filter: (filterEl ? filterEl.value : 'active')
    };
  }

  function applyViewAndRender() {
    var v = getViewState();
    var list = allClients.slice();

    // フィルタ（契約状態）。'all' は terminated を除く active+suspended、'terminated' のみ解約済
    list = list.filter(function (c) {
      var st = c.contractStatus || 'active';
      if (v.filter === 'active') return st === 'active';
      if (v.filter === 'suspended') return st === 'suspended';
      if (v.filter === 'terminated') return st === 'terminated';
      if (v.filter === 'all') return st !== 'terminated';
      return true;
    });

    // 検索（店舗名・clientId 部分一致）
    if (v.search) {
      list = list.filter(function (c) {
        var name = String(c.storeName || '').toLowerCase();
        var id = String(c.clientId || '').toLowerCase();
        return name.indexOf(v.search) >= 0 || id.indexOf(v.search) >= 0;
      });
    }

    // ソート
    if (v.sort === 'registered-desc') {
      // 登録（新しい順）＝原順インデックス降順（既定）
      list.sort(function (a, b) { return (b._idx || 0) - (a._idx || 0); });
    } else if (v.sort === 'registered-asc') {
      list.sort(function (a, b) { return (a._idx || 0) - (b._idx || 0); });
    } else if (v.sort === 'contractStart-desc') {
      list.sort(function (a, b) { return String(b.contractStart || '').localeCompare(String(a.contractStart || '')); });
    } else if (v.sort === 'contractStart-asc') {
      list.sort(function (a, b) { return String(a.contractStart || '').localeCompare(String(b.contractStart || '')); });
    } else if (v.sort === 'storeName') {
      list.sort(function (a, b) { return String(a.storeName || '').localeCompare(String(b.storeName || ''), 'ja'); });
    }

    var elEmpty = document.getElementById('clients-empty');
    var elTableWrap = document.getElementById('clients-table-wrap');
    var elResult = document.getElementById('clients-result-count');

    if (list.length === 0) {
      elTableWrap.hidden = true;
      elEmpty.hidden = false;
    } else {
      renderClientsTable(list);
      elTableWrap.hidden = false;
      elEmpty.hidden = true;
    }
    if (elResult) {
      elResult.textContent = '表示 ' + list.length + ' / 全 ' + allClients.length + ' 件';
    }
  }

  // 備考メモのインライン編集（blur で保存）
  function bindMemoEvents() {
    var tbody = document.getElementById('clients-tbody');
    if (!tbody) return;
    tbody.querySelectorAll('[data-memo-client]').forEach(function (input) {
      input.addEventListener('blur', function () {
        var clientId = input.getAttribute('data-memo-client');
        var original = (function () {
          var c = allClients.filter(function (x) { return x.clientId === clientId; })[0];
          return c ? (c.memo || '') : '';
        })();
        var next = input.value.trim();
        if (next === original) return; // 変更なし
        saveMemo(clientId, next, input);
      });
    });
  }

  async function saveMemo(clientId, memo, inputEl) {
    inputEl.classList.add('memo-input--saving');
    var res = await AdminApp.updateClient(clientId, { memo: memo });
    inputEl.classList.remove('memo-input--saving');
    if (AdminApp.handleAuthError(res)) return;
    if (!res || !res.ok) {
      alert('メモの保存に失敗しました：' + ((res && (res.message || res.code || res.error)) || 'unknown'));
      return;
    }
    // キャッシュ更新
    allClients.forEach(function (c) { if (c.clientId === clientId) c.memo = memo; });
    inputEl.classList.add('memo-input--saved');
    setTimeout(function () { inputEl.classList.remove('memo-input--saved'); }, 1200);
  }

  // 状態変更（停止/再開・完全削除）は編集画面に集約（dashboard 操作列は「編集」のみ）。

  async function loadClients() {
    var elLoading   = document.getElementById('clients-loading');
    var elError     = document.getElementById('clients-error');
    var elEmpty     = document.getElementById('clients-empty');
    var elTableWrap = document.getElementById('clients-table-wrap');
    var elCount     = document.getElementById('clients-count');
    var elToolbar   = document.getElementById('clients-toolbar');

    elError.hidden = true;
    elEmpty.hidden = true;
    elTableWrap.hidden = true;
    elCount.hidden = true;
    if (elToolbar) elToolbar.hidden = true;
    elLoading.hidden = false;

    var session = AdminAuth.getSession();
    if (!session || !session.pin) {
      AdminAuth.clearSession();
      location.replace('index.html');
      return;
    }

    var res = await fetchClientsListWithRetry();

    elLoading.hidden = true;

    if (AdminApp.handleAuthError(res)) return;

    if (!res.ok) {
      showClientsError(res);
      return;
    }

    allClients = (res.clients || []).slice();
    // 登録順の正本＝listClients 返却順（シート追記順）。原順インデックスを保持し
    // 「登録（新しい順/古い順）」ソートで参照する（createdAt 欠落の旧データにも頑健）。
    allClients.forEach(function (c, i) { c._idx = i; });

    if (allClients.length === 0) {
      renderSummary();
      elEmpty.hidden = false;
      return;
    }

    if (elToolbar) elToolbar.hidden = false;
    elCount.textContent = allClients.length + '件';
    elCount.hidden = false;
    renderSummary();
    applyViewAndRender();
  }

  function initClientsList() {
    var refreshBtn = document.getElementById('clients-refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', loadClients);

    var registerBtn = document.getElementById('btn-register-new');
    if (registerBtn) {
      registerBtn.addEventListener('click', function () {
        location.href = 'register.html';
      });
    }

    // 表示設定ツールバー（検索・並び順・フィルタ）→ 再描画
    var searchEl = document.getElementById('clients-search');
    var sortEl = document.getElementById('clients-sort');
    var filterEl = document.getElementById('clients-filter');
    if (searchEl) searchEl.addEventListener('input', applyViewAndRender);
    if (sortEl) sortEl.addEventListener('change', applyViewAndRender);
    if (filterEl) filterEl.addEventListener('change', applyViewAndRender);

    (async function () {
      if (!AdminAuth.isSessionValid()) {
        location.replace('index.html');
        return;
      }
      await loadClients();
    })();
  }

  // ---- エントリポイント ----------------------------------------
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
