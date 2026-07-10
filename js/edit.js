/* ============================================================
 * ultra-z-admin / 第7段階 6-G ユーザー編集画面
 *   - 単一スクロール9セクション構成（タブ構造なし）
 *   - 運営ポータル管轄：枠（タイムカード数・マスタ件数枠 S/P・契約）＋全体設定
 *     （スタッフ個別情報・取引先・売上・コスト・出勤データは管轄外・編集UIなし）
 *
 *   - 6-G：マスタ件数枠の上限制御本実装
 *     §2 マスタ件数枠 input が現在使用件数を下回る場合、
 *       .quota-field に --over クラスを付与（薄黄色背景＋警告色枠線）。
 *       「現在: N件」表記も --over クラスで太字＋警告色化。
 *     §5/§5-2 のテーブル行で枠超過分（N+1 行目以降）に
 *       data-over-quota="true" を付与し薄黄色強調。
 *     ＋ボタン押下で追加した結果、枠を超える場合は確認モーダル
 *       （保存可・運営判断を尊重・キャンセル可）。
 *     既存の §5/§5-2/§6 description ピル警告（.quota-warning）は維持。
 *     04_運営ポータル.md §3-1 / §4-1 / 00_原則.md §6-6 に整合。
 *
 *   - 6-F：用語統一「アプリ表示」＋smartphoneVisible 範囲縮小
 *     §5 サービスマスタ・§5-2 仕入マスタは 4列構成（smartphoneVisible 列なし）。
 *     §6 販管費マスタの列ラベル「アプリ表示」に統一。
 *
 *   - 6-E：販管費マスタ任意枠（C）5件固定化
 *     §2 マスタ件数枠 UI は S/P 2軸編集＋C 固定表示テキスト。
 *     diffClient から costOptionalQuota 削除（編集不可のため差分発生せず）。
 *
 *   - 6-D：仕入原価マスタ purchaseMasterList 対応・clients 13列化
 *     §5-2 仕入マスタ セクション・購入科目 ID は `p001`〜の連番自動採番。
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
      state.currentClient = JSON.parse(JSON.stringify(clientRes.client));
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
      renderPurchaseMaster();
      renderCostMaster();
      renderContract();
      renderOps();
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
  // 営業時間：終了時刻が開始時刻以前のとき翌日跨ぎと自動判定（register と統一）
  function isCloseNextDay(open, close) {
    if (!open || !close) return false;
    return close <= open;
  }
  function updateNextDayBadge() {
    const badge = document.getElementById('f-next-day-badge');
    if (!badge) return;
    const cross = isCloseNextDay(
      document.getElementById('f-business-open').value,
      document.getElementById('f-business-close').value
    );
    badge.hidden = !cross;
    badge.style.display = cross ? 'inline-block' : 'none';
  }
  function renderBasicInfo() {
    document.getElementById('f-client-id').value = state.currentClient.clientId;
    document.getElementById('f-store-name').value = state.currentClient.storeName || '';
    document.getElementById('f-contractor-name').value = state.currentClient.contractorName || '';
    document.getElementById('f-representative-name').value = state.currentClient.representativeName || '';
    document.getElementById('f-address').value = state.currentClient.address || '';
    document.getElementById('f-phone').value = state.currentClient.phone != null ? String(state.currentClient.phone) : '';
    document.getElementById('f-email').value = state.currentClient.email || '';
    const bh = state.currentSettings.businessHours || {};
    document.getElementById('f-business-open').value = bh.open || '';
    document.getElementById('f-business-close').value = bh.close || '';
    updateNextDayBadge();
  }

  function readBasicInfo() {
    state.currentClient.storeName = document.getElementById('f-store-name').value.trim();
    state.currentClient.contractorName = document.getElementById('f-contractor-name').value.trim();
    state.currentClient.representativeName = document.getElementById('f-representative-name').value.trim();
    state.currentClient.address = document.getElementById('f-address').value.trim();
    state.currentClient.phone = document.getElementById('f-phone').value.trim();
    state.currentClient.email = document.getElementById('f-email').value.trim();
    state.currentSettings.businessHours = {
      open: document.getElementById('f-business-open').value,
      close: document.getElementById('f-business-close').value,
      closeNextDay: isCloseNextDay(document.getElementById('f-business-open').value, document.getElementById('f-business-close').value)
    };
  }

  // ============ §2 タイムカード・マスタ枠 ============
  function renderTimecard() {
    document.getElementById('f-timecard-count').value = String(state.currentClient.timecardCount != null ? state.currentClient.timecardCount : 0);
    // マスタ件数枠（S/P 2軸編集・C は5固定編集不可）
    const smq = (state.currentClient.serviceMasterQuota != null && state.currentClient.serviceMasterQuota !== '')
      ? Number(state.currentClient.serviceMasterQuota) : 5;
    const pmq = (state.currentClient.purchaseMasterQuota != null && state.currentClient.purchaseMasterQuota !== '')
      ? Number(state.currentClient.purchaseMasterQuota) : 3;
    document.getElementById('f-service-master-quota').value = String(smq);
    document.getElementById('f-purchase-master-quota').value = String(pmq);
    // C は5固定維持（state には常に5を保持し、API への送信は diffClient で抑止）
    state.currentClient.costOptionalQuota = 5;
    updateGradeDisplay();
    updateQuotaCurrent();
    updateQuotaStatusInTables();
  }

  function readTimecard() {
    state.currentClient.timecardCount = parseInt(document.getElementById('f-timecard-count').value, 10) || 0;
    state.currentClient.grade = computeGrade(state.currentClient.timecardCount);
    const smqRaw = parseInt(document.getElementById('f-service-master-quota').value, 10);
    const pmqRaw = parseInt(document.getElementById('f-purchase-master-quota').value, 10);
    if (isFinite(smqRaw) && smqRaw >= 1) state.currentClient.serviceMasterQuota = smqRaw;
    if (isFinite(pmqRaw) && pmqRaw >= 1) state.currentClient.purchaseMasterQuota = pmqRaw;
    state.currentClient.costOptionalQuota = 5;
  }

  function updateGradeDisplay() {
    const current = parseInt(document.getElementById('f-timecard-count').value, 10) || 0;
    const grade = computeGrade(current);
    const el = document.getElementById('grade-display');
    el.textContent = grade;
    el.className = 'grade-display grade-display--' + grade;
    const initial = state.initialClient.timecardCount;
    document.getElementById('timecard-decrease-warning').hidden = !(current < initial);
  }

  function computeGrade(count) {
    const n = Number(count);
    if (n === 0) return 'アストラ';
    if (n >= 5) return 'レオ';
    return 'unknown';
  }

  // ============ 6-G：件数枠ヘルパー ============
  function getServiceUsedCount() {
    return (state.currentSettings && Array.isArray(state.currentSettings.serviceList))
      ? state.currentSettings.serviceList.filter(function (s) { return s && s.name; }).length : 0;
  }
  function getPurchaseUsedCount() {
    return (state.currentSettings && Array.isArray(state.currentSettings.purchaseMasterList))
      ? state.currentSettings.purchaseMasterList.filter(function (p) { return p && p.name; }).length : 0;
  }
  function getCostOptionalUsedCount() {
    return (state.currentSettings && Array.isArray(state.currentSettings.costMasterList))
      ? state.currentSettings.costMasterList.filter(function (c) {
          return c && c.code >= 26 && c.code <= 30 && c.name && String(c.name).trim() !== '';
        }).length : 0;
  }
  function getServiceQuotaValue() {
    return parseInt(document.getElementById('f-service-master-quota').value, 10) || 5;
  }
  function getPurchaseQuotaValue() {
    return parseInt(document.getElementById('f-purchase-master-quota').value, 10) || 3;
  }

  // 6-G：§2 マスタ件数枠 input 右側の「現在: N 件」表示＋枠超過の視覚強調
  function updateQuotaCurrent() {
    const serviceUsed = getServiceUsedCount();
    const purchaseUsed = getPurchaseUsedCount();
    const costOptionalUsed = getCostOptionalUsedCount();
    const smq = getServiceQuotaValue();
    const pmq = getPurchaseQuotaValue();

    const smqEl = document.getElementById('f-service-master-quota-current');
    const pmqEl = document.getElementById('f-purchase-master-quota-current');
    const coqEl = document.getElementById('f-cost-optional-quota-current');
    const sField = document.getElementById('quota-field-service');
    const pField = document.getElementById('quota-field-purchase');

    // サービス：枠 < 使用 で警告
    if (smqEl) {
      const overS = serviceUsed > smq;
      smqEl.textContent = overS
        ? '（現在: ' + serviceUsed + ' 件 ⚠ 枠超過）'
        : '（現在: ' + serviceUsed + ' 件）';
      smqEl.classList.toggle('quota-current--over', overS);
      if (sField) sField.classList.toggle('quota-field--over', overS);
    }
    // 仕入：枠 < 使用 で警告
    if (pmqEl) {
      const overP = purchaseUsed > pmq;
      pmqEl.textContent = overP
        ? '（現在: ' + purchaseUsed + ' 件 ⚠ 枠超過）'
        : '（現在: ' + purchaseUsed + ' 件）';
      pmqEl.classList.toggle('quota-current--over', overP);
      if (pField) pField.classList.toggle('quota-field--over', overP);
    }
    // 任意枠（C）：5固定・使用件数のみ表示（input なし）
    if (coqEl) {
      coqEl.textContent = '（任意枠使用: ' + costOptionalUsed + ' / 5 件）';
    }
  }

  // §5/§5-2/§6 description に「付与枠数 N 件 / 使用 M 件」を表示
  function updateQuotaStatusInTables() {
    const smq = getServiceQuotaValue();
    const pmq = getPurchaseQuotaValue();
    const coq = 5;
    const serviceUsed = getServiceUsedCount();
    const purchaseUsed = getPurchaseUsedCount();
    const costOptionalUsed = getCostOptionalUsedCount();

    const sStatus = document.getElementById('service-master-quota-status');
    const pStatus = document.getElementById('purchase-master-quota-status');
    const cStatus = document.getElementById('cost-optional-quota-status');
    if (sStatus) {
      const over = serviceUsed > smq;
      sStatus.innerHTML = '<strong>付与枠数：' + smq + ' 件 / 現在使用：' + serviceUsed + ' 件</strong>'
        + (over ? ' <span class="quota-warning">⚠ 枠数を超えています（保存可・運営判断）</span>' : '');
    }
    if (pStatus) {
      const over = purchaseUsed > pmq;
      pStatus.innerHTML = '<strong>付与枠数：' + pmq + ' 件 / 現在使用：' + purchaseUsed + ' 件</strong>'
        + (over ? ' <span class="quota-warning">⚠ 枠数を超えています（保存可・運営判断）</span>' : '');
    }
    if (cStatus) {
      cStatus.innerHTML = '<strong>任意枠付与枠数：' + coq + ' 件固定（税務署様式準拠）／現在使用：' + costOptionalUsed + ' 件</strong>';
    }
  }

  // ============ §3 ロゴ・アイコン ============
  function renderLogoIcon() {
    const clientId = state.currentClient.clientId;
    const buster = '?v=' + Date.now();
    document.getElementById('preview-store-logo').src = 'https://raw.githubusercontent.com/kana19/' + clientId + '/main/icons/store-logo.png' + buster;
    document.getElementById('preview-icon-192').src = 'https://raw.githubusercontent.com/kana19/' + clientId + '/main/icons/icon-192.png' + buster;
    document.getElementById('preview-icon-512').src = 'https://raw.githubusercontent.com/kana19/' + clientId + '/main/icons/icon-512.png' + buster;
    document.getElementById('preview-icon-192-maskable').src = 'https://raw.githubusercontent.com/kana19/' + clientId + '/main/icons/icon-192-maskable.png' + buster;
    document.getElementById('preview-icon-512-maskable').src = 'https://raw.githubusercontent.com/kana19/' + clientId + '/main/icons/icon-512-maskable.png' + buster;
    document.getElementById('preview-apple-touch-icon').src = 'https://raw.githubusercontent.com/kana19/' + clientId + '/main/icons/apple-touch-icon.png' + buster;
    ['preview-store-logo', 'preview-icon-192', 'preview-icon-512', 'preview-icon-192-maskable', 'preview-icon-512-maskable', 'preview-apple-touch-icon'].forEach(function (id) {
      const img = document.getElementById(id);
      img.onerror = function () {
        img.onerror = null;
        img.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><rect width="100" height="40" fill="%23e0e0e0"/><text x="50" y="25" text-anchor="middle" fill="%23999" font-size="12">未設定</text></svg>';
      };
    });
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
    const v = window.uzAdmin.validateAssetFile(file, 5);
    if (!v.ok) {
      showToast(v.message, 'error');
      return;
    }
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
    const previewMap = {
      'store-logo': 'preview-store-logo',
      'icon-192': 'preview-icon-192',
      'icon-512': 'preview-icon-512',
      'icon-192-maskable': 'preview-icon-192-maskable',
      'icon-512-maskable': 'preview-icon-512-maskable',
      'apple-touch-icon': 'preview-apple-touch-icon'
    };
    const previewId = previewMap[assetType];
    if (previewId) document.getElementById(previewId).src = res.downloadUrl;
    refreshChangeLog();
  }

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () {
        const result = reader.result;
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
    document.getElementById('fv-qr-proof').checked = !!fv.qrProofEnabled;
    document.getElementById('fv-shift-schedule').checked = !!fv.shiftScheduleEnabled;
    document.getElementById('fv-receipt-ocr').checked = !!fv.receipt_ocr;
    document.getElementById('fv-bank-csv').checked = !!fv.bank_csv;
    document.getElementById('fv-payment-calendar').checked = !!fv.payment_calendar;
    document.getElementById('fv-doc-automation').checked = !!fv.doc_automation;
    document.getElementById('fv-fax-order-ocr').checked = !!fv.fax_order_ocr;
  }

  function readFeatureVisibility() {
    state.currentSettings.featureVisibility = {
      clockin_menu: document.getElementById('fv-clockin-menu').checked,
      payroll_menu: document.getElementById('fv-payroll-menu').checked,
      qrProofEnabled: document.getElementById('fv-qr-proof').checked,
      shiftScheduleEnabled: document.getElementById('fv-shift-schedule').checked,
      receipt_ocr: document.getElementById('fv-receipt-ocr').checked,
      bank_csv: document.getElementById('fv-bank-csv').checked,
      payment_calendar: document.getElementById('fv-payment-calendar').checked,
      doc_automation: document.getElementById('fv-doc-automation').checked,
      fax_order_ocr: document.getElementById('fv-fax-order-ocr').checked
    };
  }

  // ============ §5 サービスマスタ ============
  // 4列構成（コード・サービス名・税率・操作）。
  // 6-G：枠超過行に data-over-quota="true" 付与（薄黄色強調）。
  function renderServiceMaster() {
    const tbody = document.getElementById('service-table-body');
    tbody.innerHTML = '';
    const list = state.currentSettings.serviceList || [];
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="empty-row">ユーザーが未登録（アプリ側で登録されると表示されます）</td></tr>';
      return;
    }
    // B案：運営は中身を編集しない（確定仕様F・ユーザー主権）。閲覧のみの読み取り専用表示。
    list.forEach(function (svc) {
      const idDisplay = svc.id || '(未割当)';
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td><span class="readonly-text">' + escapeHtml(idDisplay) + '</span></td>' +
        '<td><span class="readonly-text">' + escapeHtml(svc.name || '') + '</span></td>' +
        '<td><span class="readonly-text">' + (Number(svc.taxRate) || 0) + '%</span></td>';
      tbody.appendChild(tr);
    });
  }

  function readServiceMaster() {
    const tbody = document.getElementById('service-table-body');
    const existing = JSON.parse(JSON.stringify(state.currentSettings.serviceList || []));
    const inputs = tbody.querySelectorAll('[data-svc-idx]');
    inputs.forEach(function (el) {
      const idx = parseInt(el.dataset.svcIdx, 10);
      const field = el.dataset.svcField;
      if (!existing[idx]) existing[idx] = {};
      if (field === 'taxRate') {
        existing[idx][field] = parseInt(el.value, 10);
      } else if (field === 'name') {
        existing[idx][field] = el.value.trim();
      }
    });
    existing.forEach(function (s) {
      if (s && 'smartphoneVisible' in s) delete s.smartphoneVisible;
    });
    state.currentSettings.serviceList = existing.filter(function (s) { return s && s.name; });
  }

  function nextServiceId() {
    const list = state.currentSettings.serviceList || [];
    let maxN = 0;
    list.forEach(function (s) {
      const m = String(s.id || '').match(/^sv(\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (isFinite(n) && n > maxN) maxN = n;
      }
    });
    return 'sv' + String(maxN + 1).padStart(3, '0');
  }

  // 6-G：追加時に枠を超える場合は確認モーダル（保存可・運営判断尊重）
  async function addService() {
    if (!state.currentSettings.serviceList) state.currentSettings.serviceList = [];
    const currentUsed = getServiceUsedCount();
    const quota = getServiceQuotaValue();
    const willBe = currentUsed + 1;
    if (willBe > quota) {
      const ok = await confirmModal({
        title: 'サービスマスタ枠超過の確認',
        body: '付与枠数（' + quota + ' 件）を超えて追加します（追加後 ' + willBe + ' 件）。保存は可能ですが、運営判断として実施しますか？'
      });
      if (!ok) return;
    }
    state.currentSettings.serviceList.push({
      id: nextServiceId(),
      name: '',
      taxRate: 10
    });
    renderServiceMaster();
    markDirty('service-master');
    updateQuotaCurrent();
    updateQuotaStatusInTables();
  }

  function deleteService(idx) {
    state.currentSettings.serviceList.splice(idx, 1);
    renderServiceMaster();
    markDirty('service-master');
    updateQuotaCurrent();
    updateQuotaStatusInTables();
  }

  // ============ §5-2 仕入マスタ ============
  function renderPurchaseMaster() {
    const tbody = document.getElementById('purchase-master-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!Array.isArray(state.currentSettings.purchaseMasterList)) {
      state.currentSettings.purchaseMasterList = [];
    }
    const list = state.currentSettings.purchaseMasterList;
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="empty-row">ユーザーが未登録（アプリ側で登録されると表示されます）</td></tr>';
      return;
    }
    // B案：運営は中身を編集しない（確定仕様F・ユーザー主権）。閲覧のみの読み取り専用表示。
    list.forEach(function (p) {
      const tr = document.createElement('tr');
      const idDisplay = p.id || '(未割当)';
      const taxRate = (p.defaultTaxRate != null ? p.defaultTaxRate : (p.taxRate != null ? p.taxRate : 10));
      tr.innerHTML =
        '<td><span class="readonly-text">' + escapeHtml(idDisplay) + '</span></td>' +
        '<td><span class="readonly-text">' + escapeHtml(p.name || '') + '</span></td>' +
        '<td><span class="readonly-text">' + (Number(taxRate) || 0) + '%</span></td>';
      tbody.appendChild(tr);
    });
  }

  function readPurchaseMaster() {
    const tbody = document.getElementById('purchase-master-table-body');
    if (!tbody) return;
    if (!Array.isArray(state.currentSettings.purchaseMasterList)) {
      state.currentSettings.purchaseMasterList = [];
    }
    const updatedList = JSON.parse(JSON.stringify(state.currentSettings.purchaseMasterList));
    const inputs = tbody.querySelectorAll('[data-pm-idx]');
    inputs.forEach(function (el) {
      const idx = parseInt(el.dataset.pmIdx, 10);
      const field = el.dataset.pmField;
      if (!updatedList[idx]) return;
      if (field === 'defaultTaxRate') {
        updatedList[idx][field] = parseInt(el.value, 10);
      } else if (field === 'name') {
        updatedList[idx][field] = el.value.trim();
      }
    });
    updatedList.forEach(function (p) {
      if (p && 'smartphoneVisible' in p) delete p.smartphoneVisible;
    });
    state.currentSettings.purchaseMasterList = updatedList;
  }

  function nextPurchaseId() {
    const list = state.currentSettings.purchaseMasterList || [];
    let maxN = 0;
    list.forEach(function (p) {
      const m = String(p.id || '').match(/^p(\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (isFinite(n) && n > maxN) maxN = n;
      }
    });
    return 'p' + String(maxN + 1).padStart(3, '0');
  }

  // 6-G：追加時に枠を超える場合は確認モーダル
  async function addPurchase() {
    if (!Array.isArray(state.currentSettings.purchaseMasterList)) {
      state.currentSettings.purchaseMasterList = [];
    }
    const currentUsed = getPurchaseUsedCount();
    const quota = getPurchaseQuotaValue();
    const willBe = currentUsed + 1;
    if (willBe > quota) {
      const ok = await confirmModal({
        title: '仕入マスタ枠超過の確認',
        body: '付与枠数（' + quota + ' 件）を超えて追加します（追加後 ' + willBe + ' 件）。保存は可能ですが、運営判断として実施しますか？'
      });
      if (!ok) return;
    }
    state.currentSettings.purchaseMasterList.push({
      id: nextPurchaseId(),
      name: '',
      defaultTaxRate: 10
    });
    renderPurchaseMaster();
    markDirty('purchase-master');
    updateQuotaCurrent();
    updateQuotaStatusInTables();
  }

  function deletePurchase(idx) {
    state.currentSettings.purchaseMasterList.splice(idx, 1);
    renderPurchaseMaster();
    markDirty('purchase-master');
    updateQuotaCurrent();
    updateQuotaStatusInTables();
  }

  // ============ §6 販管費マスタ ============
  const FIXED_COST_CODES = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 31];

  function renderCostMaster() {
    const tbody = document.getElementById('cost-master-table-body');
    tbody.innerHTML = '';
    const list = (state.currentSettings.costMasterList || []).slice();
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-row">科目マスタが登録されていません</td></tr>';
      return;
    }
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

    readBasicInfo();
    readTimecard();
    readLogoIcon();
    readFeatureVisibility();
    readServiceMaster();
    readPurchaseMaster();
    readCostMaster();
    readContract();

    if (state.currentClient.timecardCount < state.initialClient.timecardCount) {
      const ok = await confirmModal({
        title: 'タイムカード数減少の確認',
        body: 'タイムカード数を ' + state.initialClient.timecardCount + ' → ' + state.currentClient.timecardCount +
              ' に減らします。既存スタッフ枠のうち一部が無効化されます。本当に保存しますか？'
      });
      if (!ok) return;
    }
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

      const clientFields = diffClient();
      const settingsFieldsPre = diffSettings();
      // 段2/段3フラグは user SS B16 が正本だが、dashboard 一覧表示用に master clients にも複製する。
      // featureVisibility が変更された保存時のみ、clients 側の複製も更新する。
      if (settingsFieldsPre.featureVisibility) {
        const fv = settingsFieldsPre.featureVisibility;
        clientFields.qrProofEnabled = !!fv.qrProofEnabled;
        clientFields.shiftScheduleEnabled = !!fv.shiftScheduleEnabled;
      }
      if (Object.keys(clientFields).length > 0) {
        tasks.push(window.uzAdmin.callMasterGas('updateClient', {
          clientId: state.clientId,
          fields: clientFields
        }));
        taskLabels.push('updateClient');
      }
      const settingsFields = diffSettings();
      if (Object.keys(settingsFields).length > 0) {
        tasks.push(window.uzAdmin.callMasterGas('updateUserSettings', {
          clientId: state.clientId,
          fields: settingsFields
        }));
        taskLabels.push('updateUserSettings');
      }

      if (tasks.length === 0) {
        clearDirty();
        showToast('変更はありません', 'info');
        return;
      }

      const results = await Promise.all(tasks);
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (window.uzAdmin.handleAuthError(r)) return;
        if (!r.ok) {
          showToast('保存失敗（' + taskLabels[i] + '）: ' + (r.message || r.code || r.error || 'unknown'), 'error');
          return;
        }
      }
      state.initialClient = JSON.parse(JSON.stringify(state.currentClient));
      state.initialSettings = JSON.parse(JSON.stringify(state.currentSettings));
      clearDirty();
      showToast('保存しました', 'success');
      refreshChangeLog();
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
    // マスタ件数枠（運営内部管理項目・S/P 2軸編集）
    //   costOptionalQuota は税務署様式準拠で5固定・編集UI廃止のため差分検出対象外
    if (Number(state.currentClient.serviceMasterQuota) !== Number(state.initialClient.serviceMasterQuota)) {
      fields.serviceMasterQuota = state.currentClient.serviceMasterQuota;
    }
    if (Number(state.currentClient.purchaseMasterQuota) !== Number(state.initialClient.purchaseMasterQuota)) {
      fields.purchaseMasterQuota = state.currentClient.purchaseMasterQuota;
    }
    // 基本情報（契約者名・代表者名・住所・電話・メール）は clients が正本（03_データ仕様.md §1-0-4）
    ['contractorName', 'representativeName', 'address', 'phone', 'email'].forEach(function (k) {
      if (state.currentClient[k] !== state.initialClient[k]) fields[k] = state.currentClient[k];
    });
    return fields;
  }

  function diffSettings() {
    const fields = {};
    const scalarKeys = ['storeName', 'themeColor', 'logoBackgroundColor'];
    scalarKeys.forEach(function (k) {
      if (state.currentSettings[k] !== state.initialSettings[k]) fields[k] = state.currentSettings[k];
    });
    // serviceList / purchaseMasterList は運営側では読み取り専用（確定仕様F・ユーザー主権）。
    // 保存対象に含めない。販管費 costMasterList は運営編集対象のため残す。
    const objKeys = ['businessHours', 'featureVisibility', 'costMasterList'];
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
    renderPurchaseMaster();
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

  // ============ §8 ユーザーGASコード再取得（保守用）============
  // prepareUserGasCode を呼び、SPREADSHEET_ID 差込済みの完成コードを
  // クリップボードにコピーする。テンプレGAS更新・障害復旧時の保守導線。
  async function copyUserGasCode() {
    const sheetId = state.currentClient && state.currentClient.sheetId
      ? String(state.currentClient.sheetId) : '';
    if (!sheetId) {
      showToast('この店舗の sheetId（ユーザーSS ID）が取得できません', 'error');
      return;
    }
    const btn = document.getElementById('btn-copy-gas-code');
    const orig = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '取得中...'; }
    try {
      const res = await window.uzAdmin.callMasterGas('prepareUserGasCode', {
        clientId: state.clientId,
        spreadsheetId: sheetId
      });
      if (window.uzAdmin.handleAuthError(res)) return;
      if (!res || !res.ok || !res.gasCode) {
        showToast('コード取得失敗: ' + (res && (res.message || res.code) || 'unknown'), 'error');
        return;
      }
      // クリップボードへコピー（失敗時は新規タブに全文表示してフォールバック）
      try {
        await navigator.clipboard.writeText(res.gasCode);
        showToast('ユーザーGASコードをコピーしました（' + res.gasCode.length + '文字）。Apps Script に全置換してください', 'success');
      } catch (clipErr) {
        const w = window.open('', '_blank');
        if (w) {
          w.document.title = 'ユーザーGASコード ' + state.clientId;
          const pre = w.document.createElement('pre');
          pre.style.whiteSpace = 'pre-wrap';
          pre.style.wordBreak = 'break-all';
          pre.textContent = res.gasCode;
          w.document.body.appendChild(pre);
          showToast('自動コピー不可。新規タブのコードを全選択してコピーしてください', 'info');
        } else {
          showToast('コピーできませんでした（ポップアップ許可が必要）', 'error');
        }
      }
      refreshChangeLog();
    } catch (err) {
      showToast('コード取得エラー: ' + ((err && err.message) || err), 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = orig; }
    }
  }

  // ============ 操作（納品カード再発行・停止/再開・完全削除）============
  // 停止/再開ボタンのラベルを現在の契約状態で更新する。
  function renderOps() {
    const btn = document.getElementById('btn-toggle-suspend');
    if (!btn) return;
    const st = (state.currentClient && state.currentClient.contractStatus) || 'active';
    btn.textContent = (st === 'suspended') ? '再開' : '停止';
    btn.disabled = (st === 'terminated');
  }

  async function reissueDeliveryCard() {
    const btn = document.getElementById('btn-reissue-card');
    const orig = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    try {
      // displayPin は渡さない（再発行時は平文PIN非保持＝カードは「別途連絡」表記）
      const res = await window.uzAdmin.callMasterGas('generateDeliveryCard', { clientId: state.clientId });
      if (window.uzAdmin.handleAuthError(res)) return;
      if (!res || res.ok === false || !res.pdfBase64) {
        showToast('納品カード生成失敗: ' + ((res && (res.message || res.code || res.error)) || 'unknown'), 'error');
        return;
      }
      downloadBase64Pdf(res.pdfBase64, 'delivery_card_' + state.clientId + '.pdf');
      showToast('納品カードPDFをダウンロードしました', 'success');
    } catch (err) {
      showToast('納品カード生成エラー: ' + ((err && err.message) || err), 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = orig || '📄 納品カード再発行'; }
    }
  }

  function downloadBase64Pdf(base64, filename) {
    try {
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    } catch (e) {
      showToast('PDFダウンロード失敗: ' + ((e && e.message) || e), 'error');
    }
  }

  async function toggleSuspend() {
    const cur = (state.currentClient && state.currentClient.contractStatus) || 'active';
    if (cur === 'terminated') return;
    const next = (cur === 'suspended') ? 'active' : 'suspended';
    const label = (next === 'suspended') ? '停止' : '再開';
    const ok = await confirmModal({
      title: label + 'の確認',
      body: 'この店舗を「' + (next === 'suspended' ? '停止中' : '稼働中') + '」にします。よろしいですか？'
    });
    if (!ok) return;
    await _applyStatusChange(next, label + 'しました');
  }

  async function terminateClient() {
    const ok = await confirmModal({
      title: '完全削除（解約済）の確認',
      body: 'この店舗を「解約済」にし、一覧から除外します（データは保持・物理削除はしません）。本当に実行しますか？'
    });
    if (!ok) return;
    await _applyStatusChange('terminated', '解約済にしました');
  }

  async function _applyStatusChange(newStatus, successMsg) {
    const res = await window.uzAdmin.callMasterGas('updateClient', {
      clientId: state.clientId,
      fields: { contractStatus: newStatus }
    });
    if (window.uzAdmin.handleAuthError(res)) return;
    if (!res || !res.ok) {
      showToast('状態変更失敗: ' + ((res && (res.message || res.code || res.error)) || 'unknown'), 'error');
      return;
    }
    state.currentClient.contractStatus = newStatus;
    if (state.initialClient) state.initialClient.contractStatus = newStatus;
    const sel = document.getElementById('f-contract-status');
    if (sel) sel.value = newStatus;
    renderOps();
    renderHeader();
    refreshChangeLog();
    showToast(successMsg, 'success');
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
      'f-business-open': 'basic-info', 'f-business-close': 'basic-info',
      'f-timecard-count': 'timecard',
      'f-service-master-quota': 'timecard',
      'f-purchase-master-quota': 'timecard',
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

    document.getElementById('f-timecard-count').addEventListener('change', updateGradeDisplay);

    // 営業時間：翌日跨ぎ自動判定バッジ更新
    document.getElementById('f-business-open').addEventListener('change', updateNextDayBadge);
    document.getElementById('f-business-close').addEventListener('change', updateNextDayBadge);

    // 6-G：件数枠 input 変更で §2 表示＋§5/§5-2/§6 ステータス＋テーブル行強調も更新
    document.getElementById('f-service-master-quota').addEventListener('input', function () {
      readTimecard();
      updateQuotaCurrent();
      updateQuotaStatusInTables();
      renderServiceMaster();  // 枠超過行の data-over-quota 再付与
    });
    document.getElementById('f-purchase-master-quota').addEventListener('input', function () {
      readTimecard();
      updateQuotaCurrent();
      updateQuotaStatusInTables();
      renderPurchaseMaster();  // 同上
    });

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
      { btn: 'btn-upload-icon-512', file: 'upload-icon-512', type: 'icon-512' },
      { btn: 'btn-upload-icon-192-maskable', file: 'upload-icon-192-maskable', type: 'icon-192-maskable' },
      { btn: 'btn-upload-icon-512-maskable', file: 'upload-icon-512-maskable', type: 'icon-512-maskable' },
      { btn: 'btn-upload-apple-touch-icon', file: 'upload-apple-touch-icon', type: 'apple-touch-icon' }
    ].forEach(function (cfg) {
      document.getElementById(cfg.btn).addEventListener('click', function () {
        document.getElementById(cfg.file).click();
      });
      document.getElementById(cfg.file).addEventListener('change', function (e) {
        const file = e.target.files[0];
        if (file) handleAssetUpload(cfg.type, file);
        e.target.value = '';
      });
    });

    // サービスマスタ操作（イベント委譲）
    const svcBody = document.getElementById('service-table-body');
    svcBody.addEventListener('input', function (e) {
      if (e.target.dataset.svcIdx !== undefined) {
        markDirty('service-master');
        readServiceMaster();
        updateQuotaCurrent();
        updateQuotaStatusInTables();
      }
    });
    svcBody.addEventListener('change', function (e) {
      if (e.target.dataset.svcIdx !== undefined) {
        markDirty('service-master');
        readServiceMaster();
        updateQuotaCurrent();
        updateQuotaStatusInTables();
      }
    });
    svcBody.addEventListener('click', function (e) {
      if (e.target.dataset.svcDel !== undefined) {
        readServiceMaster();
        deleteService(parseInt(e.target.dataset.svcDel, 10));
      }
    });
    const btnAddService = document.getElementById('btn-add-service');
    if (btnAddService) {
      btnAddService.addEventListener('click', function () {
        readServiceMaster();
        addService();
      });
    }

    // 仕入マスタ操作（イベント委譲）
    const pmBody = document.getElementById('purchase-master-table-body');
    if (pmBody) {
      pmBody.addEventListener('input', function (e) {
        if (e.target.dataset.pmIdx !== undefined) {
          markDirty('purchase-master');
          readPurchaseMaster();
          updateQuotaCurrent();
          updateQuotaStatusInTables();
        }
      });
      pmBody.addEventListener('change', function (e) {
        if (e.target.dataset.pmIdx !== undefined) {
          markDirty('purchase-master');
          readPurchaseMaster();
          updateQuotaCurrent();
          updateQuotaStatusInTables();
        }
      });
      pmBody.addEventListener('click', function (e) {
        if (e.target.dataset.pmDel !== undefined) {
          readPurchaseMaster();
          deletePurchase(parseInt(e.target.dataset.pmDel, 10));
        }
      });
    }
    const btnAddPurchase = document.getElementById('btn-add-purchase');
    if (btnAddPurchase) {
      btnAddPurchase.addEventListener('click', function () {
        readPurchaseMaster();
        addPurchase();
      });
    }

    // 販管費マスタ操作（イベント委譲）
    const cmBody = document.getElementById('cost-master-table-body');
    cmBody.addEventListener('input', function (e) {
      if (e.target.dataset.cmIdx !== undefined) {
        markDirty('cost-master');
        readCostMaster();
        updateQuotaCurrent();
        updateQuotaStatusInTables();
      }
    });
    cmBody.addEventListener('change', function (e) {
      if (e.target.dataset.cmIdx !== undefined) {
        markDirty('cost-master');
        readCostMaster();
        updateQuotaCurrent();
        updateQuotaStatusInTables();
      }
    });

    // 認証セクション
    document.getElementById('btn-reset-pin').addEventListener('click', resetPin);
    document.getElementById('btn-unlock-auth').addEventListener('click', unlockAuth);
    document.getElementById('btn-copy-gas-code').addEventListener('click', copyUserGasCode);

    // 操作（dashboard 操作列から集約）：納品カード再発行・停止/再開・完全削除
    var reissueBtn = document.getElementById('btn-reissue-card');
    if (reissueBtn) reissueBtn.addEventListener('click', reissueDeliveryCard);
    var suspendBtn = document.getElementById('btn-toggle-suspend');
    if (suspendBtn) suspendBtn.addEventListener('click', toggleSuspend);
    var terminateBtn = document.getElementById('btn-terminate');
    if (terminateBtn) terminateBtn.addEventListener('click', terminateClient);

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
