/* ============================================================
 * ultra-z-admin / 第6段階 ユーザー編集画面
 *   - 単一スクロール9セクション構成（タブ構造なし）
 *   - 運営ポータル管轄：枠（タイムカード数・契約）＋全体設定
 *     （スタッフ個別情報・取引先・売上・コスト・出勤データは管轄外・編集UIなし）
 *
 * 名前空間：window.uzAdmin（app.js が AdminApp/AdminAuth を橋渡しして提供）
 * URL クエリ：?id=uz-XXXXXXXX を主、?clientId=uz-XXXXXXXX も後方互換で受領
 *
 * 依存：app.js → auth.js → edit.js の順に読み込み
 * ============================================================ */
(function () {
  'use strict';

  // ============ 状態管理 ============
  const state = {
    clientId: null,
    initialClient: null,        // マスタGAS getClient の初期値（破棄時の戻り先）
    initialSettings: null,      // マスタGAS getUserSettings の初期値
    currentClient: null,        // 編集中の clients 側の値
    currentSettings: null,      // 編集中の settings 側の値
    changeLog: [],
    dirtySections: new Set(),   // どのセクションが編集されているか
    saving: false
  };

  // ============ 初期化 ============
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    // セッション確認
    const session = window.uzAdmin.getSession();
    if (!session || !session.authenticated) {
      location.href = 'index.html';
      return;
    }
    // URL パラメータから clientId 取得（?id=… を主、?clientId=… にも後方互換）
    const urlParams = new URLSearchParams(location.search);
    state.clientId = urlParams.get('id') || urlParams.get('clientId');
    if (!state.clientId) {
      showError('clientId が指定されていません');
      return;
    }
    // 初期データロード
    await loadAll();
    // イベント登録
    bindEvents();
  }

  async function loadAll() {
    showLoading();
    try {
      // 並列で取得（独立した3つの呼び出し）
      const [clientRes, settingsRes, logRes] = await Promise.all([
        window.uzAdmin.callMasterGas('getClient', { clientId: state.clientId }),
        window.uzAdmin.callMasterGas('getUserSettings', { clientId: state.clientId }),
        window.uzAdmin.callMasterGas('getChangeLog', { clientId: state.clientId, limit: 50 })
      ]);
      // 認証エラーは handleAuthError で吸収（true 返却で遷移発火済み）
      if (window.uzAdmin.handleAuthError(clientRes)) return;
      if (window.uzAdmin.handleAuthError(settingsRes)) return;
      if (window.uzAdmin.handleAuthError(logRes)) return;
      // 通常エラー
      if (!clientRes.ok) { showError('クライアント情報取得失敗: ' + (clientRes.message || clientRes.code || clientRes.error || 'unknown')); return; }
      if (!settingsRes.ok) { showError('ユーザー設定取得失敗: ' + (settingsRes.message || settingsRes.code || settingsRes.error || 'unknown')); return; }
      if (!logRes.ok) { showError('変更履歴取得失敗: ' + (logRes.message || logRes.code || logRes.error || 'unknown')); return; }
      // state 反映
      state.initialClient = clientRes.client;
      state.currentClient = JSON.parse(JSON.stringify(clientRes.client));  // deep copy
      state.initialSettings = settingsRes.settings || {};
      state.currentSettings = JSON.parse(JSON.stringify(state.initialSettings));
      state.changeLog = logRes.logs || [];
      // ヘッダー描画
      renderHeader();
      // 各セクション描画
      renderBasicInfo();
      renderTimecard();
      renderLogoIcon();
      renderFeatureVisibility();
      renderServiceMaster();
      renderCostMaster();
      renderContract();
      // 認証セクションはボタンのみ・描画不要
      renderChangeLog();
      // 表示切替
      hideLoading();
      document.getElementById('edit-main').hidden = false;
    } catch (err) {
      showError('読み込みに失敗しました: ' + (err && err.message ? err.message : String(err)));
    }
  }

  // ============ ヘッダー ============
  function renderHeader() {
    document.getElementById('store-name-header').textContent = state.currentClient.storeName || '(店舗名未設定)';
    document.getElementById('client-id-header').textContent = state.currentClient.clientId;
    const gradeBadge = document.getElementById('grade-badge-header');
    const grade = state.currentClient.grade || computeGrade(state.currentClient.timecardCount);
    gradeBadge.textContent = grade;
    gradeBadge.className = 'grade-badge grade-badge--' + grade;
  }

  // ============ §1 基本情報 ============
  function renderBasicInfo() {
    document.getElementById('f-client-id').value = state.currentClient.clientId;
    document.getElementById('f-store-name').value = state.currentClient.storeName || '';
    // ユーザーSS settings からも引く
    document.getElementById('f-contractor-name').value = state.currentSettings.contractorName || '';
    document.getElementById('f-representative-name').value = state.currentSettings.representativeName || '';
    document.getElementById('f-address').value = state.currentSettings.address || '';
    document.getElementById('f-phone').value = state.currentSettings.phone || '';
    document.getElementById('f-email').value = state.currentSettings.email || '';
    // 営業時間
    const bh = state.currentSettings.businessHours || {};
    document.getElementById('f-business-open').value = bh.open || '';
    document.getElementById('f-business-close').value = bh.close || '';
    document.getElementById('f-close-next-day').checked = !!bh.closeNextDay;
  }

  function readBasicInfo() {
    state.currentClient.storeName = document.getElementById('f-store-name').value.trim();
    state.currentSettings.contractorName = document.getElementById('f-contractor-name').value.trim();
    state.currentSettings.representativeName = document.getElementById('f-representative-name').value.trim();
    state.currentSettings.address = document.getElementById('f-address').value.trim();
    state.currentSettings.phone = document.getElementById('f-phone').value.trim();
    state.currentSettings.email = document.getElementById('f-email').value.trim();
    state.currentSettings.businessHours = {
      open: document.getElementById('f-business-open').value,
      close: document.getElementById('f-business-close').value,
      closeNextDay: document.getElementById('f-close-next-day').checked
    };
  }

  // ============ §2 タイムカード ============
  function renderTimecard() {
    document.getElementById('f-timecard-count').value = String(state.currentClient.timecardCount != null ? state.currentClient.timecardCount : 0);
    updateGradeDisplay();
  }

  function readTimecard() {
    state.currentClient.timecardCount = parseInt(document.getElementById('f-timecard-count').value, 10) || 0;
    state.currentClient.grade = computeGrade(state.currentClient.timecardCount);
  }

  function updateGradeDisplay() {
    const current = parseInt(document.getElementById('f-timecard-count').value, 10) || 0;
    const grade = computeGrade(current);
    const el = document.getElementById('grade-display');
    el.textContent = grade;
    el.className = 'grade-display grade-display--' + grade;
    // タイムカード減少警告
    const initial = state.initialClient.timecardCount;
    document.getElementById('timecard-decrease-warning').hidden = !(current < initial);
  }

  function computeGrade(count) {
    const n = Number(count);
    if (n === 0) return 'アストラ';
    if (n >= 5) return 'レオ';
    return 'unknown';
  }

  // ============ §3 ロゴ・アイコン ============
  function renderLogoIcon() {
    const clientId = state.currentClient.clientId;
    const buster = '?v=' + Date.now();
    document.getElementById('preview-store-logo').src = 'https://raw.githubusercontent.com/kana19/' + clientId + '/main/icons/store-logo.png' + buster;
    document.getElementById('preview-icon-192').src = 'https://raw.githubusercontent.com/kana19/' + clientId + '/main/icons/icon-192.png' + buster;
    document.getElementById('preview-icon-512').src = 'https://raw.githubusercontent.com/kana19/' + clientId + '/main/icons/icon-512.png' + buster;
    // 画像読込失敗時はプレースホルダー
    ['preview-store-logo', 'preview-icon-192', 'preview-icon-512'].forEach(function (id) {
      const img = document.getElementById(id);
      img.onerror = function () {
        img.onerror = null; // 無限ループ防止
        img.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><rect width="100" height="40" fill="%23e0e0e0"/><text x="50" y="25" text-anchor="middle" fill="%23999" font-size="12">未設定</text></svg>';
      };
    });
    // 色
    const themeColor = state.currentSettings.themeColor || '#0B1842';
    const logoBg = state.currentSettings.logoBackgroundColor || '#FFFFFF';
    document.getElementById('f-theme-color').value = themeColor;
    document.getElementById('f-theme-color-text').value = themeColor;
    document.getElementById('f-logo-background-color').value = logoBg;
    document.getElementById('f-logo-background-color-text').value = logoBg;
  }

  function readLogoIcon() {
    const themeText = document.getElementById('f-theme-color-text').value;
    state.currentSettings.themeColor = /^#[0-9A-Fa-f]{6}$/.test(themeText) ? themeText : document.getElementById('f-theme-color').value;
    const logoBgText = document.getElementById('f-logo-background-color-text').value;
    state.currentSettings.logoBackgroundColor = /^#[0-9A-Fa-f]{6}$/.test(logoBgText) ? logoBgText : document.getElementById('f-logo-background-color').value;
  }

  async function handleAssetUpload(assetType, file) {
    // クライアント側バリデーション（app.js の validateAssetFile）
    const v = window.uzAdmin.validateAssetFile(file, 5);
    if (!v.ok) {
      showToast(v.message, 'error');
      return;
    }
    // ファイル → Base64 変換
    let base64;
    try {
      base64 = await fileToBase64(file);
    } catch (err) {
      showToast('ファイル読込失敗: ' + (err && err.message ? err.message : String(err)), 'error');
      return;
    }
    showToast('アップロード中…', 'info');
    const res = await window.uzAdmin.callMasterGas('uploadUserAsset', {
      clientId: state.clientId,
      assetType: assetType,
      fileBase64: base64,
      mimeType: file.type
    });
    if (window.uzAdmin.handleAuthError(res)) return;
    if (!res.ok) {
      showToast('アップロード失敗: ' + (res.message || res.code || res.error || 'unknown'), 'error');
      return;
    }
    showToast('アップロード成功', 'success');
    // プレビュー更新（応答の downloadUrl がキャッシュバスター付き）
    const previewMap = {
      'store-logo': 'preview-store-logo',
      'icon-192': 'preview-icon-192',
      'icon-512': 'preview-icon-512'
    };
    const previewId = previewMap[assetType];
    if (previewId) document.getElementById(previewId).src = res.downloadUrl;
    // 変更履歴も更新
    refreshChangeLog();
  }

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () {
        const result = reader.result;
        // data:image/png;base64,XXXX のプレフィックスを除去
        const parts = String(result).split(',');
        resolve(parts.length > 1 ? parts[1] : parts[0]);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // ============ §4 機能ON/OFF ============
  function renderFeatureVisibility() {
    const fv = state.currentSettings.featureVisibility || {};
    document.getElementById('fv-clockin-menu').checked = fv.clockin_menu !== false;
    document.getElementById('fv-payroll-menu').checked = fv.payroll_menu !== false;
    document.getElementById('fv-shift-schedule').checked = !!fv.shiftScheduleEnabled;
    document.getElementById('fv-receipt-ocr').checked = !!fv.receipt_ocr;
    document.getElementById('fv-bank-csv').checked = !!fv.bank_csv;
    document.getElementById('fv-payment-calendar').checked = !!fv.payment_calendar;
    document.getElementById('fv-doc-automation').checked = !!fv.doc_automation;
  }

  function readFeatureVisibility() {
    state.currentSettings.featureVisibility = {
      clockin_menu: document.getElementById('fv-clockin-menu').checked,
      payroll_menu: document.getElementById('fv-payroll-menu').checked,
      shiftScheduleEnabled: document.getElementById('fv-shift-schedule').checked,
      receipt_ocr: document.getElementById('fv-receipt-ocr').checked,
      bank_csv: document.getElementById('fv-bank-csv').checked,
      payment_calendar: document.getElementById('fv-payment-calendar').checked,
      doc_automation: document.getElementById('fv-doc-automation').checked
    };
  }

  // ============ §5 サービスマスタ ============
  function renderServiceMaster() {
    const tbody = document.getElementById('service-table-body');
    tbody.innerHTML = '';
    const list = state.currentSettings.serviceList || [];
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="empty-row">サービスが登録されていません</td></tr>';
      return;
    }
    list.forEach(function (svc, idx) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td><input type="text" data-svc-idx="' + idx + '" data-svc-field="name" value="' + escapeHtml(svc.name || '') + '" maxlength="30"></td>' +
        '<td>' +
          '<select data-svc-idx="' + idx + '" data-svc-field="taxRate">' +
            '<option value="0"' + (Number(svc.taxRate) === 0 ? ' selected' : '') + '>0%</option>' +
            '<option value="8"' + (Number(svc.taxRate) === 8 ? ' selected' : '') + '>8%</option>' +
            '<option value="10"' + (Number(svc.taxRate) === 10 ? ' selected' : '') + '>10%</option>' +
          '</select>' +
        '</td>' +
        '<td><button type="button" class="btn-icon-delete" data-svc-del="' + idx + '">🗑️</button></td>';
      tbody.appendChild(tr);
    });
  }

  function readServiceMaster() {
    const tbody = document.getElementById('service-table-body');
    const inputs = tbody.querySelectorAll('[data-svc-idx]');
    const list = [];
    inputs.forEach(function (el) {
      const idx = parseInt(el.dataset.svcIdx, 10);
      const field = el.dataset.svcField;
      if (!list[idx]) list[idx] = {};
      if (field === 'taxRate') {
        list[idx][field] = parseInt(el.value, 10);
      } else {
        list[idx][field] = el.value.trim();
      }
    });
    // 空のものを除外
    state.currentSettings.serviceList = list.filter(function (s) { return s && s.name; });
  }

  function addService() {
    if (!state.currentSettings.serviceList) state.currentSettings.serviceList = [];
    state.currentSettings.serviceList.push({ name: '', taxRate: 10 });
    renderServiceMaster();
    markDirty('service-master');
  }

  function deleteService(idx) {
    state.currentSettings.serviceList.splice(idx, 1);
    renderServiceMaster();
    markDirty('service-master');
  }

  // ============ §6 科目マスタ ============
  const FIXED_COST_CODES = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 31];

  function renderCostMaster() {
    const tbody = document.getElementById('cost-master-table-body');
    tbody.innerHTML = '';
    const list = (state.currentSettings.costMasterList || []).slice();
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-row">科目マスタが登録されていません</td></tr>';
      return;
    }
    // コード順にソート
    list.sort(function (a, b) { return Number(a.code) - Number(b.code); });
    list.forEach(function (cm, idx) {
      const codeNum = Number(cm.code);
      const isFixed = FIXED_COST_CODES.indexOf(codeNum) >= 0;
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + escapeHtml(cm.code) + '</td>' +
        '<td>' +
          (isFixed
            ? '<span class="readonly-text">' + escapeHtml(cm.name) + '</span>'
            : '<input type="text" data-cm-idx="' + idx + '" data-cm-field="name" value="' + escapeHtml(cm.name || '') + '" maxlength="30" placeholder="（未設定）">'
          ) +
        '</td>' +
        '<td>' +
          '<select data-cm-idx="' + idx + '" data-cm-field="taxRate">' +
            '<option value="0"' + (Number(cm.taxRate) === 0 ? ' selected' : '') + '>0%</option>' +
            '<option value="8"' + (Number(cm.taxRate) === 8 ? ' selected' : '') + '>8%</option>' +
            '<option value="10"' + (Number(cm.taxRate) === 10 ? ' selected' : '') + '>10%</option>' +
          '</select>' +
        '</td>' +
        '<td>' + (isFixed ? '固定' : '任意') + '</td>' +
        '<td>' +
          '<label class="toggle-inline">' +
            '<input type="checkbox" data-cm-idx="' + idx + '" data-cm-field="smartphoneVisible"' + (cm.smartphoneVisible ? ' checked' : '') + '> 表示' +
          '</label>' +
        '</td>';
      tbody.appendChild(tr);
    });
    // 並び替え結果を state にも反映（再描画/保存時の整合性のため）
    state.currentSettings.costMasterList = list;
  }

  function readCostMaster() {
    const tbody = document.getElementById('cost-master-table-body');
    const updatedList = JSON.parse(JSON.stringify(state.currentSettings.costMasterList || []));
    updatedList.sort(function (a, b) { return Number(a.code) - Number(b.code); });

    const inputs = tbody.querySelectorAll('[data-cm-idx]');
    inputs.forEach(function (el) {
      const idx = parseInt(el.dataset.cmIdx, 10);
      const field = el.dataset.cmField;
      if (!updatedList[idx]) return;
      if (field === 'smartphoneVisible') {
        updatedList[idx][field] = el.checked;
      } else if (field === 'taxRate') {
        updatedList[idx][field] = parseInt(el.value, 10);
      } else if (field === 'name') {
        // 固定科目は name の input が出ない・ここに来ないが、防御的に固定はスキップ
        const codeNum = Number(updatedList[idx].code);
        if (FIXED_COST_CODES.indexOf(codeNum) < 0) {
          updatedList[idx][field] = el.value.trim();
        }
      }
    });
    state.currentSettings.costMasterList = updatedList;
  }

  // ============ §7 契約情報 ============
  function renderContract() {
    document.getElementById('f-contract-start').value = state.currentClient.contractStart || '';
    document.getElementById('f-contract-end').value = state.currentClient.contractEnd || '';
    document.getElementById('f-monthly-fee').value = state.currentClient.monthlyFee != null ? state.currentClient.monthlyFee : 0;
    document.getElementById('f-contract-status').value = state.currentClient.contractStatus || 'active';
  }

  function readContract() {
    state.currentClient.contractStart = document.getElementById('f-contract-start').value;
    state.currentClient.contractEnd = document.getElementById('f-contract-end').value;
    state.currentClient.monthlyFee = parseInt(document.getElementById('f-monthly-fee').value, 10) || 0;
    state.currentClient.contractStatus = document.getElementById('f-contract-status').value;
  }

  // ============ §9 変更履歴 ============
  function renderChangeLog() {
    const tbody = document.getElementById('change-log-table-body');
    tbody.innerHTML = '';
    if (!state.changeLog || state.changeLog.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="empty-row">変更履歴がありません</td></tr>';
      return;
    }
    state.changeLog.forEach(function (log) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + escapeHtml(formatTs(log.ts)) + '</td>' +
        '<td>' + escapeHtml(log.action) + '</td>' +
        '<td><code class="log-detail">' + escapeHtml(JSON.stringify(log.detail || {})) + '</code></td>';
      tbody.appendChild(tr);
    });
  }

  async function refreshChangeLog() {
    const res = await window.uzAdmin.callMasterGas('getChangeLog', { clientId: state.clientId, limit: 50 });
    if (window.uzAdmin.handleAuthError(res)) return;
    if (!res.ok) {
      showToast('変更履歴の取得に失敗: ' + (res.message || res.code || res.error || 'unknown'), 'error');
      return;
    }
    state.changeLog = res.logs || [];
    renderChangeLog();
  }

  // ============ Dirty 管理 ============
  function markDirty(sectionName) {
    state.dirtySections.add(sectionName);
    const ind = document.querySelector('[data-section="' + sectionName + '"] .dirty-indicator');
    if (ind) ind.hidden = false;
    updateFooter();
  }

  function clearDirty() {
    state.dirtySections.clear();
    document.querySelectorAll('.dirty-indicator').forEach(function (el) { el.hidden = true; });
    updateFooter();
  }

  function updateFooter() {
    const dirty = state.dirtySections.size > 0;
    document.getElementById('btn-discard').disabled = !dirty || state.saving;
    document.getElementById('btn-save').disabled = !dirty || state.saving;
    document.getElementById('footer-status').textContent = dirty
      ? state.dirtySections.size + ' セクション編集中'
      : '';
  }

  // ============ 保存 ============
  async function saveAll() {
    if (state.dirtySections.size === 0) return;

    // 全フィールドを state に反映
    readBasicInfo();
    readTimecard();
    readLogoIcon();
    readFeatureVisibility();
    readServiceMaster();
    readCostMaster();
    readContract();

    // タイムカード減少時の確認
    if (state.currentClient.timecardCount < state.initialClient.timecardCount) {
      const ok = await confirmModal({
        title: 'タイムカード数減少の確認',
        body: 'タイムカード数を ' + state.initialClient.timecardCount + ' → ' + state.currentClient.timecardCount +
              ' に減らします。既存スタッフ枠のうち一部が無効化されます。本当に保存しますか？'
      });
      if (!ok) return;
    }
    // 契約解約時の確認
    if (state.currentClient.contractStatus === 'terminated' && state.initialClient.contractStatus !== 'terminated') {
      const ok = await confirmModal({
        title: '契約解約の確認',
        body: '契約状態を「解約済」に変更します。ユーザーPWAは引き続き動作しますが、運営ポータルから「解約済」扱いになります。本当に保存しますか？'
      });
      if (!ok) return;
    }

    state.saving = true;
    updateFooter();
    showToast('保存中…', 'info');

    try {
      const tasks = [];
      const taskLabels = [];

      // clients 側の更新
      const clientFields = diffClient();
      if (Object.keys(clientFields).length > 0) {
        tasks.push(window.uzAdmin.callMasterGas('updateClient', {
          clientId: state.clientId,
          fields: clientFields
        }));
        taskLabels.push('updateClient');
      }
      // settings 側の更新
      const settingsFields = diffSettings();
      if (Object.keys(settingsFields).length > 0) {
        tasks.push(window.uzAdmin.callMasterGas('updateUserSettings', {
          clientId: state.clientId,
          fields: settingsFields
        }));
        taskLabels.push('updateUserSettings');
      }

      if (tasks.length === 0) {
        // dirty があるが差分なし（極稀）：dirty だけクリア
        clearDirty();
        showToast('変更はありません', 'info');
        return;
      }

      const results = await Promise.all(tasks);
      // エラーチェック
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (window.uzAdmin.handleAuthError(r)) return;
        if (!r.ok) {
          showToast('保存失敗（' + taskLabels[i] + '）: ' + (r.message || r.code || r.error || 'unknown'), 'error');
          return;
        }
      }
      // 成功 → 初期値を更新
      state.initialClient = JSON.parse(JSON.stringify(state.currentClient));
      state.initialSettings = JSON.parse(JSON.stringify(state.currentSettings));
      clearDirty();
      showToast('保存しました', 'success');
      // 変更履歴を再取得
      refreshChangeLog();
      // 店舗名・グレードが変わった可能性 → ヘッダー再描画
      renderHeader();
    } catch (err) {
      showToast('保存失敗: ' + (err && err.message ? err.message : String(err)), 'error');
    } finally {
      state.saving = false;
      updateFooter();
    }
  }

  function diffClient() {
    const fields = {};
    if (state.currentClient.storeName !== state.initialClient.storeName) fields.storeName = state.currentClient.storeName;
    if (state.currentClient.timecardCount !== state.initialClient.timecardCount) fields.timecardCount = state.currentClient.timecardCount;
    if (state.currentClient.contractStatus !== state.initialClient.contractStatus) fields.contractStatus = state.currentClient.contractStatus;
    if (state.currentClient.contractStart !== state.initialClient.contractStart) fields.contractStart = state.currentClient.contractStart;
    if (state.currentClient.contractEnd !== state.initialClient.contractEnd) fields.contractEnd = state.currentClient.contractEnd;
    if (state.currentClient.monthlyFee !== state.initialClient.monthlyFee) fields.monthlyFee = state.currentClient.monthlyFee;
    return fields;
  }

  function diffSettings() {
    const fields = {};
    const scalarKeys = ['storeName', 'contractorName', 'representativeName', 'address', 'phone', 'email', 'themeColor', 'logoBackgroundColor'];
    scalarKeys.forEach(function (k) {
      if (state.currentSettings[k] !== state.initialSettings[k]) fields[k] = state.currentSettings[k];
    });
    const objKeys = ['businessHours', 'featureVisibility', 'serviceList', 'costMasterList'];
    objKeys.forEach(function (k) {
      if (JSON.stringify(state.currentSettings[k]) !== JSON.stringify(state.initialSettings[k])) {
        fields[k] = state.currentSettings[k];
      }
    });
    return fields;
  }

  function discardAll() {
    state.currentClient = JSON.parse(JSON.stringify(state.initialClient));
    state.currentSettings = JSON.parse(JSON.stringify(state.initialSettings));
    renderBasicInfo();
    renderTimecard();
    renderLogoIcon();
    renderFeatureVisibility();
    renderServiceMaster();
    renderCostMaster();
    renderContract();
    clearDirty();
    showToast('変更を破棄しました', 'info');
  }

  // ============ §8 PIN再発行 ============
  async function resetPin() {
    const newPin = await confirmModal({
      title: 'PIN再発行',
      body: 'ユーザーの新しいPINを入力してください（4〜8桁の数字）。発行と同時に即時反映されます。',
      input: true,
      inputNote: '4〜8桁の数字のみ。半角',
      inputPlaceholder: '例：9876'
    });
    if (!newPin) return;
    if (!/^\d{4,8}$/.test(newPin)) {
      showToast('4〜8桁の数字を入力してください', 'error');
      return;
    }
    const res = await window.uzAdmin.callMasterGas('resetUserPin', { clientId: state.clientId, newPin: newPin });
    if (window.uzAdmin.handleAuthError(res)) return;
    if (!res.ok) {
      showToast('PIN再発行失敗: ' + (res.message || res.code || res.error || 'unknown'), 'error');
      return;
    }
    showToast('PINを再発行しました（新PIN: ' + newPin + '）', 'success');
    refreshChangeLog();
  }

  // ============ §8 ロック解除 ============
  async function unlockAuth() {
    const ok = await confirmModal({
      title: 'ロック解除',
      body: 'このユーザーの failCount を 0 にリセットし、ロックを解除します。本当に実行しますか？'
    });
    if (!ok) return;
    const res = await window.uzAdmin.callMasterGas('unlockUserAuth', { clientId: state.clientId });
    if (window.uzAdmin.handleAuthError(res)) return;
    if (!res.ok) {
      showToast('ロック解除失敗: ' + (res.message || res.code || res.error || 'unknown'), 'error');
      return;
    }
    showToast('ロックを解除しました', 'success');
    refreshChangeLog();
  }

  // ============ モーダル ============
  function confirmModal(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      const modal = document.getElementById('modal-confirm');
      document.getElementById('modal-title').textContent = opts.title || '確認';
      document.getElementById('modal-body').textContent = opts.body || '';
      const inputArea = document.getElementById('modal-input-area');
      const input = document.getElementById('modal-input');
      const inputNote = document.getElementById('modal-input-note');
      if (opts.input) {
        inputArea.hidden = false;
        input.value = '';
        input.placeholder = opts.inputPlaceholder || '';
        inputNote.textContent = opts.inputNote || '';
        setTimeout(function () { input.focus(); }, 50);
      } else {
        inputArea.hidden = true;
      }
      modal.hidden = false;

      const ok = document.getElementById('modal-ok');
      const cancel = document.getElementById('modal-cancel');
      function cleanup() {
        modal.hidden = true;
        ok.onclick = null;
        cancel.onclick = null;
        document.removeEventListener('keydown', onKey);
      }
      function onKey(ev) {
        if (ev.key === 'Escape') {
          cleanup();
          resolve(opts.input ? null : false);
        } else if (ev.key === 'Enter' && opts.input) {
          ev.preventDefault();
          const val = input.value.trim();
          cleanup();
          resolve(val);
        }
      }
      ok.onclick = function () {
        const val = opts.input ? input.value.trim() : true;
        cleanup();
        resolve(val);
      };
      cancel.onclick = function () {
        cleanup();
        resolve(opts.input ? null : false);
      };
      document.addEventListener('keydown', onKey);
    });
  }

  // ============ トースト ============
  let toastTimer = null;
  function showToast(msg, type) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast toast--' + (type || 'info');
    t.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3000);
  }

  // ============ 表示制御 ============
  function showLoading() {
    document.getElementById('loading-state').hidden = false;
    document.getElementById('error-state').hidden = true;
    document.getElementById('edit-main').hidden = true;
  }
  function hideLoading() {
    document.getElementById('loading-state').hidden = true;
  }
  function showError(msg) {
    document.getElementById('loading-state').hidden = true;
    document.getElementById('edit-main').hidden = true;
    document.getElementById('error-state').hidden = false;
    document.getElementById('error-message').textContent = msg;
  }

  // ============ ヘルパー ============
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function formatTs(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  // ============ イベントバインド ============
  function bindEvents() {
    const dirtyMap = {
      'f-store-name': 'basic-info', 'f-contractor-name': 'basic-info', 'f-representative-name': 'basic-info',
      'f-address': 'basic-info', 'f-phone': 'basic-info', 'f-email': 'basic-info',
      'f-business-open': 'basic-info', 'f-business-close': 'basic-info', 'f-close-next-day': 'basic-info',
      'f-timecard-count': 'timecard',
      'f-theme-color': 'logo-icon', 'f-theme-color-text': 'logo-icon',
      'f-logo-background-color': 'logo-icon', 'f-logo-background-color-text': 'logo-icon',
      'fv-clockin-menu': 'feature-visibility', 'fv-payroll-menu': 'feature-visibility',
      'fv-shift-schedule': 'feature-visibility', 'fv-receipt-ocr': 'feature-visibility',
      'fv-bank-csv': 'feature-visibility', 'fv-payment-calendar': 'feature-visibility',
      'fv-doc-automation': 'feature-visibility',
      'f-contract-start': 'contract', 'f-contract-end': 'contract',
      'f-monthly-fee': 'contract', 'f-contract-status': 'contract'
    };
    Object.keys(dirtyMap).forEach(function (id) {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', function () { markDirty(dirtyMap[id]); });
      el.addEventListener('change', function () { markDirty(dirtyMap[id]); });
    });

    // タイムカード数変更でグレード再計算
    document.getElementById('f-timecard-count').addEventListener('change', updateGradeDisplay);

    // 色 input ⇔ text 同期
    ['theme-color', 'logo-background-color'].forEach(function (name) {
      const colorEl = document.getElementById('f-' + name);
      const textEl = document.getElementById('f-' + name + '-text');
      colorEl.addEventListener('input', function () {
        textEl.value = colorEl.value.toUpperCase();
        markDirty('logo-icon');
      });
      textEl.addEventListener('input', function () {
        if (/^#[0-9A-Fa-f]{6}$/.test(textEl.value)) {
          colorEl.value = textEl.value;
          markDirty('logo-icon');
        }
      });
    });

    // ロゴ・アイコンアップロード
    [
      { btn: 'btn-upload-store-logo', file: 'upload-store-logo', type: 'store-logo' },
      { btn: 'btn-upload-icon-192', file: 'upload-icon-192', type: 'icon-192' },
      { btn: 'btn-upload-icon-512', file: 'upload-icon-512', type: 'icon-512' }
    ].forEach(function (cfg) {
      document.getElementById(cfg.btn).addEventListener('click', function () {
        document.getElementById(cfg.file).click();
      });
      document.getElementById(cfg.file).addEventListener('change', function (e) {
        const file = e.target.files[0];
        if (file) handleAssetUpload(cfg.type, file);
        e.target.value = '';  // 同じファイル再選択を可能に
      });
    });

    // サービスマスタ操作（イベント委譲）
    const svcBody = document.getElementById('service-table-body');
    svcBody.addEventListener('input', function (e) {
      if (e.target.dataset.svcIdx !== undefined) markDirty('service-master');
    });
    svcBody.addEventListener('change', function (e) {
      if (e.target.dataset.svcIdx !== undefined) markDirty('service-master');
    });
    svcBody.addEventListener('click', function (e) {
      if (e.target.dataset.svcDel !== undefined) {
        readServiceMaster();
        deleteService(parseInt(e.target.dataset.svcDel, 10));
      }
    });
    document.getElementById('btn-add-service').addEventListener('click', function () {
      readServiceMaster();
      addService();
    });

    // 科目マスタ操作（イベント委譲）
    const cmBody = document.getElementById('cost-master-table-body');
    cmBody.addEventListener('input', function (e) {
      if (e.target.dataset.cmIdx !== undefined) markDirty('cost-master');
    });
    cmBody.addEventListener('change', function (e) {
      if (e.target.dataset.cmIdx !== undefined) markDirty('cost-master');
    });

    // 認証セクション
    document.getElementById('btn-reset-pin').addEventListener('click', resetPin);
    document.getElementById('btn-unlock-auth').addEventListener('click', unlockAuth);

    // 変更履歴
    document.getElementById('btn-refresh-change-log').addEventListener('click', function () {
      refreshChangeLog();
      showToast('変更履歴を更新しました', 'info');
    });

    // 最下部操作バー
    document.getElementById('btn-discard').addEventListener('click', function () {
      confirmModal({ title: '変更を破棄', body: '編集中の変更を全て破棄して元に戻します。よろしいですか？' })
        .then(function (ok) { if (ok) discardAll(); });
    });
    document.getElementById('btn-save').addEventListener('click', saveAll);

    // エラー状態の再読み込み
    document.getElementById('error-retry-btn').addEventListener('click', loadAll);

    // ログアウト
    document.getElementById('logout-btn').addEventListener('click', function () {
      window.uzAdmin.clearSession();
      location.href = 'index.html';
    });

    // ページ離脱警告
    window.addEventListener('beforeunload', function (e) {
      if (state.dirtySections.size > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }
})();
