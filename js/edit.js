/* ============================================================
 * ultra-z-admin / 第6段階 ユーザー編集画面
 *   - URL ?clientId=... から clientId 取得
 *   - getClient → ヘッダー描画
 *   - getUserStaffList → スタッフテーブル描画
 *   - 行単位の編集／追加 → updateUserStaffList で保存
 *
 * 依存：app.js → auth.js → edit.js の順で読み込むこと。
 * ============================================================ */
(function () {
  'use strict';

  var APP_VERSION = '0.6.0';

  // セッション無ければ index.html へ
  AdminAuth.bootstrapDashboardPage();

  // ---- ユーティリティ ----------------------------------------
  function escapeHTML(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getClientIdFromUrl() {
    var qs = location.search || '';
    var match = qs.match(/[?&]clientId=([^&]+)/);
    if (!match) return '';
    try { return decodeURIComponent(match[1]); }
    catch (_e) { return match[1]; }
  }

  // SHA-256 ハッシュ化（Web Crypto API・16進文字列で返却）
  async function sha256Hex(text) {
    var enc = new TextEncoder();
    var data = enc.encode(text);
    var buf = await crypto.subtle.digest('SHA-256', data);
    var bytes = new Uint8Array(buf);
    var hex = '';
    for (var i = 0; i < bytes.length; i++) {
      hex += ('00' + bytes[i].toString(16)).slice(-2);
    }
    return hex;
  }

  function nullableNumber(value) {
    if (value === '' || value === null || value === undefined) return null;
    var n = Number(value);
    return isNaN(n) ? null : n;
  }

  function employmentTypeLabel(value) {
    switch (value) {
      case 'employed_full': return '常勤雇用（社員）';
      case 'employed_temp': return '臨時アルバイト';
      case 'contractor':    return '委託・外注';
      default:              return value || '-';
    }
  }

  function withholdingLabel(value) {
    switch (value) {
      case 'off':      return 'なし';
      case 'hostess':  return 'ホステス';
      case 'standard': return '標準';
      default:         return value || '-';
    }
  }

  // ---- 状態 -------------------------------------------------
  var state = {
    clientId: '',
    client: null,
    staffList: [],
    saving: false
  };

  // ---- 初期化 -----------------------------------------------
  async function initEditPage() {
    state.clientId = getClientIdFromUrl();
    var errBox = document.getElementById('edit-bootstrap-error');
    if (!state.clientId) {
      errBox.textContent = 'URL に clientId パラメータがありません。ユーザー一覧から「編集」ボタンで遷移してください。';
      errBox.hidden = false;
      return;
    }

    // クライアント詳細
    var clientRes = await AdminApp.fetchClientWithRetry(state.clientId);
    if (AdminApp.handleAuthError(clientRes)) return;
    if (!clientRes.ok) {
      var code = clientRes.code || clientRes.error || 'unknown';
      errBox.innerHTML =
        '<p>クライアント情報の取得に失敗しました。</p>' +
        '<p class="muted">code: ' + escapeHTML(code) +
        (clientRes.message ? ' / ' + escapeHTML(clientRes.message) : '') + '</p>';
      errBox.hidden = false;
      return;
    }
    state.client = clientRes.client;
    renderHeader(state.client);

    // スタッフリスト
    await loadStaffList();
  }

  function renderHeader(client) {
    document.getElementById('edit-store-name').textContent = client.storeName || '(店舗名未設定)';
    document.getElementById('edit-client-id').textContent = '（' + client.clientId + '）';
    document.title = 'ユーザー編集：' + (client.storeName || client.clientId) + ' - ウルトラZAIMUくんレオ 運営ポータル';
  }

  async function loadStaffList() {
    var elLoading   = document.getElementById('staff-loading');
    var elError     = document.getElementById('staff-error');
    var elTableWrap = document.getElementById('staff-table-wrap');
    var elActions   = document.getElementById('staff-actions');

    elError.hidden = true;
    elTableWrap.hidden = true;
    elActions.hidden = true;
    elLoading.hidden = false;

    var res = await AdminApp.fetchUserStaffListWithRetry(state.clientId);

    elLoading.hidden = true;

    if (AdminApp.handleAuthError(res)) return;

    if (!res.ok) {
      showStaffError(res);
      return;
    }

    state.staffList = Array.isArray(res.staffList) ? res.staffList : [];
    renderStaffTable(state.staffList);
    elTableWrap.hidden = false;
    elActions.hidden = false;
  }

  function showStaffError(res) {
    var el = document.getElementById('staff-error');
    var code = res.code || res.error || 'unknown';
    var detail = res.message || res._message || '';
    el.innerHTML =
      '<p>スタッフ一覧の取得に失敗しました。</p>' +
      '<p class="muted">code: ' + escapeHTML(code) +
      (detail ? ' / ' + escapeHTML(detail) : '') +
      (res._retryAttempted ? '<br>（自動再試行も失敗しました）' : '') +
      '</p>' +
      '<button type="button" class="btn-secondary" id="staff-error-retry">もう一度試す</button>';
    el.hidden = false;
    var retryBtn = document.getElementById('staff-error-retry');
    if (retryBtn) retryBtn.addEventListener('click', loadStaffList);
  }

  function renderStaffTable(staffList) {
    var tbody = document.getElementById('staff-tbody');
    if (!staffList.length) {
      tbody.innerHTML =
        '<tr><td colspan="6" class="staff-empty">スタッフが登録されていません。「＋ スタッフを追加」から登録してください。</td></tr>';
      return;
    }
    var rows = staffList.map(function (s) {
      var wage = (s.hourlyWage != null) ? ('¥' + Number(s.hourlyWage).toLocaleString('ja-JP')) : '-';
      return [
        '<tr data-staff-id="' + escapeHTML(s.id) + '">',
          '<td class="staff-cell-id">' + escapeHTML(s.id) + '</td>',
          '<td class="staff-cell-name">' + escapeHTML(s.name) + '</td>',
          '<td class="staff-cell-emp">' + escapeHTML(employmentTypeLabel(s.employmentType)) + '</td>',
          '<td class="staff-cell-wage">' + escapeHTML(wage) + '</td>',
          '<td class="staff-cell-with">' + escapeHTML(withholdingLabel(s.withholdingMode)) + '</td>',
          '<td class="staff-cell-act"><button type="button" class="btn-secondary staff-edit-btn" data-staff-id="' +
            escapeHTML(s.id) + '">編集</button></td>',
        '</tr>'
      ].join('');
    });
    tbody.innerHTML = rows.join('');

    // 行ごとの編集ボタン
    var btns = tbody.querySelectorAll('.staff-edit-btn');
    btns.forEach(function (b) {
      b.addEventListener('click', function () {
        openStaffEditModal(b.getAttribute('data-staff-id'));
      });
    });
  }

  // ---- スタッフ id 自動採番 ----------------------------------
  function nextStaffId(staffList) {
    var maxNum = 0;
    staffList.forEach(function (s) {
      var m = String(s.id || '').match(/^s(\d+)$/);
      if (m) {
        var n = parseInt(m[1], 10);
        if (!isNaN(n) && n > maxNum) maxNum = n;
      }
    });
    var nextNum = maxNum + 1;
    if (nextNum > 999) return null; // 上限
    return 's' + ('000' + nextNum).slice(-3);
  }

  // ---- スタッフ編集モーダル ----------------------------------
  var modalMode = 'edit'; // 'edit' or 'add'
  var editingStaffSnapshot = null; // 編集前スナップショット（id / passwordHash / passwordUpdatedAt 維持用）

  function openStaffAddModal() {
    var newId = nextStaffId(state.staffList);
    if (!newId) {
      alert('スタッフ ID の上限（s999）に達しました。');
      return;
    }
    modalMode = 'add';
    editingStaffSnapshot = null;
    fillStaffForm({
      id: newId,
      name: '',
      employmentType: 'employed_full',
      passwordHash: '',
      passwordUpdatedAt: '',
      hourlyWage: null,
      dailyWage: null,
      monthlyWage: null,
      commissionRate: null,
      withholdingMode: 'off',
      costCategory: '20',
      managerMemo: ''
    });
    document.getElementById('staff-modal-title').textContent = 'スタッフ追加';
    showStaffModal();
  }

  function openStaffEditModal(staffId) {
    var staff = state.staffList.find(function (s) { return s.id === staffId; });
    if (!staff) {
      alert('対象スタッフが見つかりませんでした。再読み込みしてください。');
      return;
    }
    modalMode = 'edit';
    editingStaffSnapshot = staff;
    fillStaffForm(staff);
    document.getElementById('staff-modal-title').textContent = 'スタッフ編集';
    showStaffModal();
  }

  function fillStaffForm(staff) {
    document.getElementById('sf-id').value = staff.id || '';
    document.getElementById('sf-name').value = staff.name || '';
    document.getElementById('sf-employmentType').value = staff.employmentType || 'employed_full';
    document.getElementById('sf-passwordRaw').value = ''; // 常に空欄スタート
    document.getElementById('sf-hourlyWage').value = staff.hourlyWage == null ? '' : staff.hourlyWage;
    document.getElementById('sf-dailyWage').value = staff.dailyWage == null ? '' : staff.dailyWage;
    document.getElementById('sf-monthlyWage').value = staff.monthlyWage == null ? '' : staff.monthlyWage;
    document.getElementById('sf-commissionRate').value = staff.commissionRate == null ? '' : staff.commissionRate;
    document.getElementById('sf-withholdingMode').value = staff.withholdingMode || 'off';
    document.getElementById('sf-costCategory').value = staff.costCategory || '20';
    document.getElementById('sf-managerMemo').value = staff.managerMemo || '';

    clearStaffFormError();
  }

  function showStaffModal() {
    document.getElementById('staff-edit-modal').hidden = false;
    setTimeout(function () {
      var nameEl = document.getElementById('sf-name');
      if (nameEl) nameEl.focus();
    }, 30);
  }

  function hideStaffModal() {
    document.getElementById('staff-edit-modal').hidden = true;
  }

  function showStaffFormError(msg) {
    var el = document.getElementById('staff-form-error');
    el.textContent = msg;
    el.hidden = false;
  }
  function clearStaffFormError() {
    var el = document.getElementById('staff-form-error');
    el.textContent = '';
    el.hidden = true;
  }

  async function buildStaffPayloadFromForm() {
    var id = document.getElementById('sf-id').value;
    var name = document.getElementById('sf-name').value.trim();
    var employmentType = document.getElementById('sf-employmentType').value;
    var passwordRaw = document.getElementById('sf-passwordRaw').value;
    var withholdingMode = document.getElementById('sf-withholdingMode').value;
    var costCategory = document.getElementById('sf-costCategory').value;
    var managerMemo = document.getElementById('sf-managerMemo').value;

    if (!name) {
      throw new Error('名前は必須です。');
    }

    var staff = {
      id: id,
      name: name,
      employmentType: employmentType,
      hourlyWage: nullableNumber(document.getElementById('sf-hourlyWage').value),
      dailyWage: nullableNumber(document.getElementById('sf-dailyWage').value),
      monthlyWage: nullableNumber(document.getElementById('sf-monthlyWage').value),
      commissionRate: nullableNumber(document.getElementById('sf-commissionRate').value),
      withholdingMode: withholdingMode,
      costCategory: costCategory,
      managerMemo: managerMemo
    };

    // パスワード処理：
    //   - passwordRaw が空欄 かつ 編集モード → 既存ハッシュ/更新日時を維持
    //   - passwordRaw 入力あり → 新規ハッシュ＋現在時刻
    //   - 新規追加で passwordRaw が空欄 → ハッシュ空欄（後で本人が初期PIN登録する想定）
    if (passwordRaw) {
      staff.passwordHash = await sha256Hex(passwordRaw);
      staff.passwordUpdatedAt = new Date().toISOString();
    } else if (modalMode === 'edit' && editingStaffSnapshot) {
      if (editingStaffSnapshot.passwordHash !== undefined) {
        staff.passwordHash = editingStaffSnapshot.passwordHash;
      }
      if (editingStaffSnapshot.passwordUpdatedAt !== undefined) {
        staff.passwordUpdatedAt = editingStaffSnapshot.passwordUpdatedAt;
      }
    } else {
      staff.passwordHash = '';
      staff.passwordUpdatedAt = '';
    }

    return staff;
  }

  async function saveStaffEdit() {
    if (state.saving) return;
    clearStaffFormError();

    var staff;
    try {
      staff = await buildStaffPayloadFromForm();
    } catch (err) {
      showStaffFormError(err.message || '入力内容に問題があります。');
      return;
    }

    state.saving = true;
    var saveBtn = document.getElementById('staff-modal-save');
    var cancelBtn = document.getElementById('staff-modal-cancel');
    var origText = saveBtn.textContent;
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    saveBtn.textContent = '保存中…';

    try {
      // updateUserStaffList は staffList を配列で受ける。
      // ここでは編集対象1名のみ送る（ユーザーGAS側でマージされる前提・SSOTはユーザーGAS）。
      var res = await AdminApp.updateUserStaffList(state.clientId, [staff]);

      if (AdminApp.handleAuthError(res)) return;

      if (!res.ok) {
        var code = res.code || res.error || 'unknown';
        var detail = res.message || res._message || '';
        showStaffFormError('保存に失敗しました（' + code + (detail ? ' / ' + detail : '') + '）');
        return;
      }

      // 成功：応答に含まれる最新 staffList を反映
      state.staffList = Array.isArray(res.staffList) ? res.staffList : state.staffList;
      renderStaffTable(state.staffList);
      hideStaffModal();
    } finally {
      state.saving = false;
      saveBtn.disabled = false;
      cancelBtn.disabled = false;
      saveBtn.textContent = origText;
    }
  }

  // ---- タブ切替（運用情報以外は disabled なので最小実装） -----
  function switchTab(tabName) {
    var tabs = document.querySelectorAll('.edit-tab');
    tabs.forEach(function (t) {
      var name = t.getAttribute('data-tab');
      t.classList.toggle('active', name === tabName);
    });
    var panels = document.querySelectorAll('.tab-panel');
    panels.forEach(function (p) {
      var name = (p.id || '').replace(/^tab-/, '');
      var match = (name === tabName);
      p.classList.toggle('active', match);
      p.hidden = !match;
    });
  }

  // ---- 確認モーダル（汎用ヘルパー・第6段階では未使用） --------
  // 第8段階以降の破壊的操作向け。呼び方：
  //   showConfirmModal({ title, body, okLabel, onConfirm })
  function showConfirmModal(opts) {
    opts = opts || {};
    var el = document.getElementById('confirm-modal');
    document.getElementById('confirm-modal-title').textContent = opts.title || '確認';
    document.getElementById('confirm-modal-body').textContent = opts.body || '';
    var okBtn = document.getElementById('confirm-modal-ok');
    var cancelBtn = document.getElementById('confirm-modal-cancel');
    if (opts.okLabel) okBtn.textContent = opts.okLabel;
    function cleanup() {
      el.hidden = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
    }
    function onOk() {
      cleanup();
      if (typeof opts.onConfirm === 'function') opts.onConfirm();
    }
    function onCancel() { cleanup(); }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    el.hidden = false;
  }
  // 未使用警告を出さないために global に露出（将来 PIN再発行等で使う想定）
  window.__editShowConfirmModal__ = showConfirmModal;

  // ---- イベントバインド --------------------------------------
  function bindEvents() {
    // 戻る
    document.getElementById('back-button').addEventListener('click', function () {
      location.href = 'dashboard.html';
    });
    // ログアウト
    var logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', function () { AdminAuth.logout(); });

    // タブ
    var tabs = document.querySelectorAll('.edit-tab');
    tabs.forEach(function (t) {
      t.addEventListener('click', function () {
        if (t.disabled) return;
        switchTab(t.getAttribute('data-tab'));
      });
    });

    // スタッフ追加・再読込
    document.getElementById('staff-add-btn').addEventListener('click', openStaffAddModal);
    document.getElementById('staff-reload-btn').addEventListener('click', loadStaffList);

    // モーダル：キャンセル・保存
    document.getElementById('staff-modal-cancel').addEventListener('click', function () {
      if (state.saving) return;
      hideStaffModal();
    });
    document.getElementById('staff-modal-save').addEventListener('click', saveStaffEdit);

    // Esc でモーダル閉じる（保存中以外）
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !state.saving) {
        var modal = document.getElementById('staff-edit-modal');
        if (modal && !modal.hidden) hideStaffModal();
      }
    });
  }

  // ---- エントリ ----------------------------------------------
  function onReady(cb) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', cb);
    } else {
      cb();
    }
  }
  onReady(function () {
    bindEvents();
    initEditPage();
  });
})();
