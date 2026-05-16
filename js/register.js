/* ============================================================
 * ultra-z-admin / 第7段階 小段階7-C 新規登録ウィザード
 *   - 7ステップ構成（Step 1〜6 入力 + Step 7 実行プレースホルダ）
 *   - 7-B からの変更点：
 *       Step 3 にマスタ件数枠（serviceMasterQuota / costOptionalQuota）の運営内部管理入力を追加
 *       defaultCostMasterList() のコード20〜25 を国税庁様式（令和7年分以降）と整合
 *         （旧 7-B では 21=雑給 / 22=外注工賃 / ... と1つズレていた）
 *   - Step 7 自動処理本体は次フェーズで実装するため、本フェーズの
 *     「登録実行」ボタンは disabled で停止する
 *   - state は全てクライアント側保持（マスタGAS 投入は次フェーズ）
 *
 * 名前空間：window.uzAdmin（app.js が AdminApp/AdminAuth から橋渡し）
 *
 * 依存：app.js → auth.js → register.js の順に読み込み
 * ============================================================ */
(function () {
  'use strict';

  // ============ 状態 ============
  const RegisterState = {
    currentStep: 1,
    maxReachedStep: 1, // 円クリックで戻れる最大Step（前進制御用）
    data: {
      step1: {
        contractorName: '',
        representativeName: '',
        address: '',
        phone: '',
        email: '',
        storeName: '',
        businessHours: { open: '18:00', close: '02:00', closeNextDay: true },
        contractStart: '',
        contractDuration: '1',
        contractEnd: '',
        monthlyFee: 4980
      },
      step2: { timecardCount: 5 },
      step3: {
        // v0.5.1：マスタ件数枠（運営側内部管理項目・01_商品体系.md §4-2）
        // 既定5・UI硬制限なし・拡張オプション販売時は edit 画面でも変更可
        serviceMasterQuota: 5,
        costOptionalQuota: 5,
        serviceList: [],
        costMasterList: []
      },
      step4: {
        logoFile: null,
        icon192File: null,
        icon512File: null,
        logoBgColor: '#FFFFFF',
        themeColor: '#0B1842'
      },
      step5: { pin: '', pinMode: 'auto' }
    }
  };

  const FIXED_COST_CODES = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 31];

  // ============ ユーティリティ ============
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(id) { return document.getElementById(id); }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function isoDate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function addYears(yyyymmdd, years) {
    // contractStart の翌日扱いではなく、N年後の前日（典型例：2026-05-16 から1年 → 2027-05-15）
    if (!yyyymmdd) return '';
    const parts = yyyymmdd.split('-');
    if (parts.length !== 3) return '';
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const d = parseInt(parts[2], 10);
    if (!y || !m || !d) return '';
    const target = new Date(y + years, m - 1, d);
    target.setDate(target.getDate() - 1);
    return isoDate(target);
  }

  function showToast(msg, type) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast toast--' + (type || 'info');
    t.hidden = false;
    setTimeout(function () { t.hidden = true; }, 3000);
  }

  function generateAutoPin() {
    let pin = '';
    for (let i = 0; i < 8; i++) {
      pin += Math.floor(Math.random() * 10);
    }
    return pin;
  }

  // 弱PIN警告：連続数字（昇順/降順4桁以上）or 同一数字繰り返し（3回以上）or 全同一
  function detectWeakPin(pin) {
    if (!pin) return null;
    if (/^(\d)\1+$/.test(pin)) return '全桁が同じ数字です';
    let ascending = 1, descending = 1, same = 1;
    let maxAsc = 1, maxDesc = 1, maxSame = 1;
    for (let i = 1; i < pin.length; i++) {
      const cur = pin.charCodeAt(i), prev = pin.charCodeAt(i - 1);
      ascending = (cur === prev + 1) ? ascending + 1 : 1;
      descending = (cur === prev - 1) ? descending + 1 : 1;
      same = (cur === prev) ? same + 1 : 1;
      maxAsc = Math.max(maxAsc, ascending);
      maxDesc = Math.max(maxDesc, descending);
      maxSame = Math.max(maxSame, same);
    }
    if (maxAsc >= 4) return '昇順の連続数字（' + maxAsc + '桁）が含まれます';
    if (maxDesc >= 4) return '降順の連続数字（' + maxDesc + '桁）が含まれます';
    if (maxSame >= 3) return '同じ数字の繰り返し（' + maxSame + '回）が含まれます';
    return null;
  }

  // ============ 初期化 ============
  document.addEventListener('DOMContentLoaded', function () {
    // セッション確認
    const session = window.uzAdmin && window.uzAdmin.getSession();
    if (!session || !session.authenticated) {
      location.href = 'index.html';
      return;
    }

    initStep1Defaults();
    initStep3Defaults();
    initStep5Defaults();

    bindEvents();
    renderStepper();
    showStep(1);
  });

  // ============ Step1 既定値 ============
  function initStep1Defaults() {
    const today = new Date();
    const todayIso = isoDate(today);
    $('f1-contract-start').value = todayIso;
    RegisterState.data.step1.contractStart = todayIso;
    recomputeContractEnd();
  }

  // ============ Step3 既定値（青色申告デフォルト） ============
  // 国税庁青色申告決算書（令和7年分以降）と整合した固定値。
  // 03_データ仕様.md §1-2・01_商品体系.md §4-2 と完全整合。
  // コード20/21/25 はアプリ全体（スタッフプルダウン・給与確定スポット突合・PC出勤管理科目別合計列・
  // staffList.costCategory・税理士用CSV）でハードコードされているため、改廃禁止。
  function defaultCostMasterList() {
    return [
      { code: 8,  name: '租税公課',       taxRate: 0,  smartphoneVisible: false },
      { code: 9,  name: '荷造運賃',       taxRate: 10, smartphoneVisible: true  },
      { code: 10, name: '水道光熱費',     taxRate: 10, smartphoneVisible: true  },
      { code: 11, name: '旅費交通費',     taxRate: 10, smartphoneVisible: true  },
      { code: 12, name: '通信費',         taxRate: 10, smartphoneVisible: true  },
      { code: 13, name: '広告宣伝費',     taxRate: 10, smartphoneVisible: true  },
      { code: 14, name: '接待交際費',     taxRate: 10, smartphoneVisible: true  },
      { code: 15, name: '損害保険料',     taxRate: 0,  smartphoneVisible: false },
      { code: 16, name: '修繕費',         taxRate: 10, smartphoneVisible: true  },
      { code: 17, name: '消耗品費',       taxRate: 10, smartphoneVisible: true  },
      { code: 18, name: '減価償却費',     taxRate: 0,  smartphoneVisible: false },
      { code: 19, name: '福利厚生費',     taxRate: 10, smartphoneVisible: true  },
      { code: 20, name: '給料賃金',       taxRate: 0,  smartphoneVisible: false },
      { code: 21, name: '外注工賃',       taxRate: 10, smartphoneVisible: false },
      { code: 22, name: '利子割引料',     taxRate: 0,  smartphoneVisible: false },
      { code: 23, name: '地代家賃',       taxRate: 10, smartphoneVisible: true  },
      { code: 24, name: '貸倒金',         taxRate: 0,  smartphoneVisible: false },
      { code: 25, name: '税理士等の報酬', taxRate: 10, smartphoneVisible: false },
      { code: 26, name: '',               taxRate: 10, smartphoneVisible: false },
      { code: 27, name: '',               taxRate: 10, smartphoneVisible: false },
      { code: 28, name: '',               taxRate: 10, smartphoneVisible: false },
      { code: 29, name: '',               taxRate: 10, smartphoneVisible: false },
      { code: 30, name: '',               taxRate: 10, smartphoneVisible: false },
      { code: 31, name: '雑費',           taxRate: 10, smartphoneVisible: true  }
    ];
  }
  function initStep3Defaults() {
    RegisterState.data.step3.serviceList = [];
    RegisterState.data.step3.costMasterList = defaultCostMasterList();
  }

  // ============ Step5 既定値（自動PIN） ============
  function initStep5Defaults() {
    const pin = generateAutoPin();
    RegisterState.data.step5.pin = pin;
    $('f5-pin').value = pin;
    updatePinWarning();
  }

  // ============ ステッパー描画 ============
  function renderStepper() {
    const items = document.querySelectorAll('.step-item');
    items.forEach(function (li) {
      const step = parseInt(li.getAttribute('data-step'), 10);
      li.classList.remove('step-current', 'step-done', 'step-future');
      if (step === RegisterState.currentStep) li.classList.add('step-current');
      else if (step < RegisterState.currentStep) li.classList.add('step-done');
      else if (step <= RegisterState.maxReachedStep) li.classList.add('step-done');
      else li.classList.add('step-future');
    });
    $('footer-step-info').textContent = 'Step ' + RegisterState.currentStep + ' / 7';
  }

  // ============ Step 切替 ============
  function showStep(n) {
    RegisterState.currentStep = n;
    if (n > RegisterState.maxReachedStep) RegisterState.maxReachedStep = n;
    document.querySelectorAll('.step-panel').forEach(function (p) {
      p.hidden = (parseInt(p.getAttribute('data-panel'), 10) !== n);
    });
    // ナビ表示
    $('btn-back').disabled = (n === 1);
    if (n === 6) {
      $('btn-next').textContent = 'Step 7 へ';
      $('btn-next').hidden = false;
      $('btn-execute').hidden = true;
    } else if (n === 7) {
      $('btn-next').hidden = true;
      $('btn-execute').hidden = false;
    } else {
      $('btn-next').textContent = '次へ';
      $('btn-next').hidden = false;
      $('btn-execute').hidden = true;
    }
    // Step 別の遅延描画
    if (n === 3) { renderServiceTable(); renderCostTable(); paintStep3(); }
    if (n === 6) {
      readAllSteps();
      $('summary-container').innerHTML = buildSummary();
      bindSummaryEditLinks();
    }
    renderStepper();
    // 上部にスクロール
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ============ Step 別読込（state → form） ============
  // 主に state.dataの内容を form input に反映する（戻る時に値を保持）
  function paintStep1() {
    const s = RegisterState.data.step1;
    $('f1-contractor-name').value = s.contractorName;
    $('f1-representative-name').value = s.representativeName;
    $('f1-address').value = s.address;
    $('f1-phone').value = s.phone;
    $('f1-email').value = s.email;
    $('f1-store-name').value = s.storeName;
    $('f1-business-open').value = s.businessHours.open;
    $('f1-business-close').value = s.businessHours.close;
    $('f1-close-next-day').checked = !!s.businessHours.closeNextDay;
    $('f1-contract-start').value = s.contractStart;
    $('f1-contract-duration').value = s.contractDuration;
    $('f1-contract-end').value = s.contractEnd;
    $('f1-monthly-fee').value = s.monthlyFee;
    toggleContractEndEditable();
  }
  function paintStep2() {
    const radios = document.querySelectorAll('input[name="f2-timecard"]');
    radios.forEach(function (r) { r.checked = (parseInt(r.value, 10) === RegisterState.data.step2.timecardCount); });
    updateGradeDerivation();
  }
  function paintStep3() {
    // v0.5.1：付与枠数を state から input に復元
    const s3 = RegisterState.data.step3;
    const smqEl = $('f3-service-master-quota');
    const coqEl = $('f3-cost-optional-quota');
    if (smqEl) smqEl.value = s3.serviceMasterQuota;
    if (coqEl) coqEl.value = s3.costOptionalQuota;
  }
  function paintStep4() {
    const s = RegisterState.data.step4;
    $('f4-logo-bg-color').value = s.logoBgColor;
    $('f4-logo-bg-color-text').value = s.logoBgColor.toUpperCase();
    $('f4-theme-color').value = s.themeColor;
    $('f4-theme-color-text').value = s.themeColor.toUpperCase();
    $('f4-logo-filename').textContent = s.logoFile ? s.logoFile.name : '未選択';
    $('f4-icon192-filename').textContent = s.icon192File ? s.icon192File.name : '未選択';
    $('f4-icon512-filename').textContent = s.icon512File ? s.icon512File.name : '未選択';
  }
  function paintStep5() {
    const s = RegisterState.data.step5;
    document.querySelectorAll('input[name="f5-pin-mode"]').forEach(function (r) {
      r.checked = (r.value === s.pinMode);
    });
    $('f5-pin').value = s.pin;
    $('f5-pin').readOnly = (s.pinMode === 'auto');
    $('f5-pin').classList.toggle('readonly', s.pinMode === 'auto');
    $('btn-regenerate-pin').hidden = (s.pinMode !== 'auto');
    updatePinWarning();
  }

  // ============ Step 別保存（form → state）／ バリデーション ============
  function readStep1AndValidate() {
    const s = RegisterState.data.step1;
    s.contractorName = $('f1-contractor-name').value.trim();
    s.representativeName = $('f1-representative-name').value.trim();
    s.address = $('f1-address').value.trim();
    s.phone = $('f1-phone').value.trim();
    s.email = $('f1-email').value.trim();
    s.storeName = $('f1-store-name').value.trim();
    s.businessHours = {
      open: $('f1-business-open').value,
      close: $('f1-business-close').value,
      closeNextDay: $('f1-close-next-day').checked
    };
    s.contractStart = $('f1-contract-start').value;
    s.contractDuration = $('f1-contract-duration').value;
    s.contractEnd = $('f1-contract-end').value;
    s.monthlyFee = parseInt($('f1-monthly-fee').value, 10) || 0;

    const errors = [];
    if (!s.contractorName) errors.push('契約者名（事業者名）');
    if (!s.representativeName) errors.push('代表者名');
    if (!s.address) errors.push('住所');
    if (!s.phone) errors.push('電話番号');
    else if (!/^[0-9\-]+$/.test(s.phone)) errors.push('電話番号（数字とハイフンのみ）');
    if (!s.email) errors.push('メールアドレス');
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email)) errors.push('メールアドレス（形式）');
    if (!s.storeName) errors.push('店舗名');
    if (!s.contractStart) errors.push('契約開始日');
    if (!s.contractEnd) errors.push('契約終了日');
    if (!s.monthlyFee || s.monthlyFee < 0) errors.push('月額（0以上の整数）');

    if (errors.length) {
      showStepError('step1-error', '入力エラー：' + errors.join(' / '));
      return false;
    }
    hideStepError('step1-error');
    return true;
  }

  function readStep2AndValidate() {
    const checked = document.querySelector('input[name="f2-timecard"]:checked');
    if (!checked) {
      showStepError('step2-error', 'タイムカード数を選択してください');
      return false;
    }
    RegisterState.data.step2.timecardCount = parseInt(checked.value, 10);
    hideStepError('step2-error');
    return true;
  }

  function readStep3AndValidate() {
    // v0.5.1：付与枠数を input から state に反映
    const s3 = RegisterState.data.step3;
    const smqEl = $('f3-service-master-quota');
    const coqEl = $('f3-cost-optional-quota');
    if (smqEl) {
      const v = parseInt(smqEl.value, 10);
      if (!isFinite(v) || v < 1) {
        showStepError('step3-error', '売上品目マスタの付与枠数は1以上の整数で指定してください');
        return false;
      }
      s3.serviceMasterQuota = v;
    }
    if (coqEl) {
      const v = parseInt(coqEl.value, 10);
      if (!isFinite(v) || v < 1) {
        showStepError('step3-error', 'コストマスタ任意枠の付与枠数は1以上の整数で指定してください');
        return false;
      }
      s3.costOptionalQuota = v;
    }
    // サービス・科目マスタは行内 input を逐次読込（イベント側で随時 state に反映している前提）
    // 念のため最終同期
    syncServiceTableToState();
    syncCostTableToState();
    // バリデーション：サービス名空文字は自動除去（規定）。固定科目改名は readonly のためそもそも変えられない
    RegisterState.data.step3.serviceList = RegisterState.data.step3.serviceList.filter(function (s) {
      return s && s.name;
    });
    hideStepError('step3-error');
    return true;
  }

  function readStep4AndValidate() {
    const s = RegisterState.data.step4;
    s.logoBgColor = $('f4-logo-bg-color-text').value || $('f4-logo-bg-color').value;
    s.themeColor = $('f4-theme-color-text').value || $('f4-theme-color').value;
    // 色形式チェック
    if (!/^#[0-9A-Fa-f]{6}$/.test(s.logoBgColor)) {
      showStepError('step4-error', 'ロゴ背景色の形式が不正です（#RRGGBB）');
      return false;
    }
    if (!/^#[0-9A-Fa-f]{6}$/.test(s.themeColor)) {
      showStepError('step4-error', 'テーマカラーの形式が不正です（#RRGGBB）');
      return false;
    }
    // ファイルは任意（必須としない・Step 7 のアップロードで未選択ならスキップ想定）
    hideStepError('step4-error');
    return true;
  }

  function readStep5AndValidate() {
    const s = RegisterState.data.step5;
    s.pin = $('f5-pin').value.trim();
    if (!/^[0-9]{4,8}$/.test(s.pin)) {
      showStepError('step5-error', 'PIN は 4〜8桁の数字で入力してください');
      return false;
    }
    hideStepError('step5-error');
    return true;
  }

  function readAllSteps() {
    // Step 6 の確認画面組立前に全 state を最新化（現Step以外は既に同期済の想定だが念のため）
    // 現在表示中 Step の input は既に state に反映済（read* を都度呼ぶため）
    // 何もしないでOK
  }

  // ============ ステップエラー表示 ============
  function showStepError(id, msg) {
    const el = $(id);
    el.textContent = msg;
    el.hidden = false;
  }
  function hideStepError(id) {
    const el = $(id);
    el.textContent = '';
    el.hidden = true;
  }

  // ============ ナビ（戻る／次へ／円クリック） ============
  function goNext() {
    const cur = RegisterState.currentStep;
    if (cur === 1 && !readStep1AndValidate()) return;
    if (cur === 2 && !readStep2AndValidate()) return;
    if (cur === 3 && !readStep3AndValidate()) return;
    if (cur === 4 && !readStep4AndValidate()) return;
    if (cur === 5 && !readStep5AndValidate()) return;
    if (cur === 6) {
      // Step6 → Step7 へ進む（Step7 は実行プレースホルダ）
      showStep(7);
      return;
    }
    if (cur === 7) {
      // 実行ボタンは別 handler。ここには来ない想定
      return;
    }
    const next = cur + 1;
    showStep(next);
    // 描画後の paint（state を form に反映）
    if (next === 2) paintStep2();
    else if (next === 3) paintStep3();
    else if (next === 4) paintStep4();
    else if (next === 5) paintStep5();
  }

  function goBack() {
    const cur = RegisterState.currentStep;
    if (cur <= 1) return;
    // 現Stepの入力を一旦保存（戻ったら復元可能に）
    if (cur === 1) readStep1AndValidate();
    else if (cur === 2) readStep2AndValidate();
    else if (cur === 3) { syncServiceTableToState(); syncCostTableToState(); readStep3QuotasSilent(); }
    else if (cur === 4) readStep4AndValidate();
    else if (cur === 5) readStep5AndValidate();
    const prev = cur - 1;
    showStep(prev);
    if (prev === 1) paintStep1();
    else if (prev === 2) paintStep2();
    else if (prev === 3) paintStep3();
    else if (prev === 4) paintStep4();
    else if (prev === 5) paintStep5();
  }

  function gotoStep(target) {
    // 円クリック：完了Step or 現Step or 完了済より1つ先 までは自由に行ける
    if (target < 1 || target > 7) return;
    if (target > RegisterState.maxReachedStep) return; // 前進はバリデーション必要
    // 現Step の値を保存
    const cur = RegisterState.currentStep;
    if (cur === 1) readStep1AndValidate();
    else if (cur === 2) readStep2AndValidate();
    else if (cur === 3) { syncServiceTableToState(); syncCostTableToState(); readStep3QuotasSilent(); }
    else if (cur === 4) readStep4AndValidate();
    else if (cur === 5) readStep5AndValidate();
    showStep(target);
    if (target === 1) paintStep1();
    else if (target === 2) paintStep2();
    else if (target === 3) paintStep3();
    else if (target === 4) paintStep4();
    else if (target === 5) paintStep5();
  }

  // v0.5.1：戻る／円ジャンプ時の付与枠数だけはバリデーション抜きで state へ吸い上げる
  // （バリデーションエラーは「次へ」時のみ表示）
  function readStep3QuotasSilent() {
    const s3 = RegisterState.data.step3;
    const smqEl = $('f3-service-master-quota');
    const coqEl = $('f3-cost-optional-quota');
    if (smqEl) {
      const v = parseInt(smqEl.value, 10);
      if (isFinite(v) && v >= 1) s3.serviceMasterQuota = v;
    }
    if (coqEl) {
      const v = parseInt(coqEl.value, 10);
      if (isFinite(v) && v >= 1) s3.costOptionalQuota = v;
    }
  }

  // ============ Step 1 補助 ============
  function recomputeContractEnd() {
    const dur = $('f1-contract-duration').value;
    const start = $('f1-contract-start').value;
    if (dur === 'custom') {
      // 直接編集可
      $('f1-contract-end').readOnly = false;
      $('f1-contract-end').classList.remove('readonly');
      return;
    }
    const years = parseInt(dur, 10) || 1;
    const end = addYears(start, years);
    $('f1-contract-end').value = end;
    RegisterState.data.step1.contractEnd = end;
  }
  function toggleContractEndEditable() {
    const dur = $('f1-contract-duration').value;
    const readOnly = (dur !== 'custom');
    $('f1-contract-end').readOnly = readOnly;
    $('f1-contract-end').classList.toggle('readonly', readOnly);
  }

  // ============ Step 2 補助 ============
  function updateGradeDerivation() {
    const checked = document.querySelector('input[name="f2-timecard"]:checked');
    const n = checked ? parseInt(checked.value, 10) : 5;
    const grade = (n === 0) ? 'アストラ' : (n >= 5 ? 'レオ' : 'unknown');
    const display = $('f2-grade-display');
    if (grade === 'アストラ') {
      display.innerHTML =
        '<span class="grade-derivation-badge grade-derivation-badge--astra">アストラ判定</span>' +
        '<span class="grade-derivation-desc">PC版機能群は非表示（タイムカード打刻機能を持たない構成）</span>';
    } else if (grade === 'レオ') {
      display.innerHTML =
        '<span class="grade-derivation-badge grade-derivation-badge--leo">レオ判定</span>' +
        '<span class="grade-derivation-desc">PC版4項目構造（タイムカード・売上・コスト・出勤）</span>';
    } else {
      display.innerHTML =
        '<span class="grade-derivation-badge">unknown</span>' +
        '<span class="grade-derivation-desc">想定外の値です</span>';
    }
  }

  // ============ Step 3 サービステーブル ============
  function renderServiceTable() {
    const tbody = $('register-service-tbody');
    tbody.innerHTML = '';
    const list = RegisterState.data.step3.serviceList;
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="empty-row">サービス未登録（後で追加可能）</td></tr>';
      return true;
    }
    list.forEach(function (svc, idx) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td><input type="text" data-svc-idx="' + idx + '" data-svc-field="name" value="' + escapeHtml(svc.name || '') + '" maxlength="30" placeholder="例：セット"></td>' +
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
    return true;
  }
  function syncServiceTableToState() {
    const tbody = $('register-service-tbody');
    if (!tbody) return true;
    const inputs = tbody.querySelectorAll('[data-svc-idx]');
    const list = [];
    inputs.forEach(function (el) {
      const idx = parseInt(el.dataset.svcIdx, 10);
      const field = el.dataset.svcField;
      if (!list[idx]) list[idx] = {};
      if (field === 'taxRate') list[idx][field] = parseInt(el.value, 10);
      else list[idx][field] = el.value.trim();
    });
    RegisterState.data.step3.serviceList = list.filter(function (s) { return s; });
    return true;
  }
  function addService() {
    syncServiceTableToState();
    RegisterState.data.step3.serviceList.push({ name: '', taxRate: 10 });
    renderServiceTable();
  }
  function deleteService(idx) {
    syncServiceTableToState();
    RegisterState.data.step3.serviceList.splice(idx, 1);
    renderServiceTable();
  }

  // ============ Step 3 科目マスタテーブル ============
  function renderCostTable() {
    const tbody = $('register-cost-tbody');
    tbody.innerHTML = '';
    const list = RegisterState.data.step3.costMasterList.slice();
    list.sort(function (a, b) { return Number(a.code) - Number(b.code); });
    list.forEach(function (cm, idx) {
      const isFixed = FIXED_COST_CODES.indexOf(Number(cm.code)) >= 0;
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
    RegisterState.data.step3.costMasterList = list;
    return true;
  }
  function syncCostTableToState() {
    const tbody = $('register-cost-tbody');
    if (!tbody) return true;
    const updated = JSON.parse(JSON.stringify(RegisterState.data.step3.costMasterList));
    updated.sort(function (a, b) { return Number(a.code) - Number(b.code); });
    const inputs = tbody.querySelectorAll('[data-cm-idx]');
    inputs.forEach(function (el) {
      const idx = parseInt(el.dataset.cmIdx, 10);
      const field = el.dataset.cmField;
      if (!updated[idx]) return;
      if (field === 'smartphoneVisible') updated[idx][field] = el.checked;
      else if (field === 'taxRate') updated[idx][field] = parseInt(el.value, 10);
      else if (field === 'name') {
        if (FIXED_COST_CODES.indexOf(Number(updated[idx].code)) < 0) {
          updated[idx][field] = el.value.trim();
        }
      }
    });
    RegisterState.data.step3.costMasterList = updated;
    return true;
  }

  // ============ Step 4 補助 ============
  function pickFile(inputId, slot) {
    $(inputId).click();
    // change イベントで slot にファイル格納＋プレビュー更新
    const input = $(inputId);
    input.onchange = function (e) {
      const file = e.target.files[0];
      if (!file) return;
      const v = window.uzAdmin.validateAssetFile(file, 5);
      if (!v.ok) {
        showToast(v.message, 'error');
        e.target.value = '';
        return;
      }
      RegisterState.data.step4[slot.field] = file;
      $(slot.previewId).src = URL.createObjectURL(file);
      $(slot.filenameId).textContent = file.name;
      e.target.value = '';
    };
  }

  function updatePinWarning() {
    const pin = $('f5-pin').value.trim();
    const w = detectWeakPin(pin);
    const el = $('f5-pin-warning');
    if (w) {
      el.textContent = '⚠ 弱PIN警告：' + w;
      el.hidden = false;
    } else {
      el.textContent = '';
      el.hidden = true;
    }
  }

  // ============ Step 6 確認画面組立 ============
  function buildSummary() {
    const s1 = RegisterState.data.step1;
    const s2 = RegisterState.data.step2;
    const s3 = RegisterState.data.step3;
    const s4 = RegisterState.data.step4;
    const s5 = RegisterState.data.step5;
    const grade = s2.timecardCount === 0 ? 'アストラ' : (s2.timecardCount >= 5 ? 'レオ' : 'unknown');

    function section(title, stepNum, rows) {
      return (
        '<section class="summary-section">' +
          '<div class="summary-section-header">' +
            '<h3>' + escapeHtml(title) + '</h3>' +
            '<a href="#" class="summary-edit-link" data-edit-step="' + stepNum + '">修正する</a>' +
          '</div>' +
          '<dl class="summary-list">' +
            rows.map(function (r) {
              return '<dt>' + escapeHtml(r[0]) + '</dt><dd>' + (r[2] === 'html' ? r[1] : escapeHtml(r[1])) + '</dd>';
            }).join('') +
          '</dl>' +
        '</section>'
      );
    }

    const bh = s1.businessHours || {};
    const bhText = (bh.open || '-') + ' 〜 ' + (bh.close || '-') + (bh.closeNextDay ? '（翌日跨ぎ）' : '');
    const serviceText = (s3.serviceList && s3.serviceList.length)
      ? s3.serviceList.map(function (sv) { return sv.name + '（' + sv.taxRate + '%）'; }).join(' / ')
      : '（未登録）';
    const customCostCount = (s3.costMasterList || []).filter(function (cm) {
      return [26, 27, 28, 29, 30].indexOf(Number(cm.code)) >= 0 && cm.name;
    }).length;
    const visibleCount = (s3.costMasterList || []).filter(function (cm) { return cm.smartphoneVisible; }).length;
    const html =
      section('Step 1：基本情報', 1, [
        ['契約者名', s1.contractorName],
        ['代表者名', s1.representativeName],
        ['住所', s1.address],
        ['電話番号', s1.phone],
        ['メールアドレス', s1.email],
        ['店舗名', s1.storeName],
        ['営業時間', bhText],
        ['契約開始日', s1.contractStart],
        ['契約期間', s1.contractDuration === 'custom' ? 'カスタム' : (s1.contractDuration + '年')],
        ['契約終了日', s1.contractEnd],
        ['月額', '¥' + Number(s1.monthlyFee).toLocaleString('ja-JP')]
      ]) +
      section('Step 2：タイムカード数', 2, [
        ['タイムカード数', String(s2.timecardCount)],
        ['グレード派生', grade]
      ]) +
      section('Step 3：サービス・科目マスタ', 3, [
        ['付与枠数（運営内部管理）', '売上品目マスタ ' + s3.serviceMasterQuota + ' 件 / コストマスタ任意枠 ' + s3.costOptionalQuota + ' 件'],
        ['サービスマスタ', serviceText],
        ['科目マスタ', '青色申告デフォルト 25件 / 任意枠使用 ' + customCostCount + ' 件 / スマホ表示 ' + visibleCount + ' 件']
      ]) +
      section('Step 4：ロゴ・テーマ', 4, [
        ['店舗ロゴ', s4.logoFile ? s4.logoFile.name : '（未選択・Step 7 でスキップ）'],
        ['ホーム画面アイコン 192', s4.icon192File ? s4.icon192File.name : '（未選択）'],
        ['ホーム画面アイコン 512', s4.icon512File ? s4.icon512File.name : '（未選択）'],
        ['ロゴ背景色', '<span class="color-chip" style="background:' + escapeHtml(s4.logoBgColor) + '"></span> ' + escapeHtml(s4.logoBgColor), 'html'],
        ['テーマカラー', '<span class="color-chip" style="background:' + escapeHtml(s4.themeColor) + '"></span> ' + escapeHtml(s4.themeColor), 'html']
      ]) +
      section('Step 5：初期PIN', 5, [
        ['発行方式', s5.pinMode === 'auto' ? '自動生成（8桁）' : '手動指定'],
        ['PIN', s5.pin]
      ]);
    return html;
  }

  function bindSummaryEditLinks() {
    document.querySelectorAll('.summary-edit-link').forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        const target = parseInt(a.getAttribute('data-edit-step'), 10);
        gotoStep(target);
        if (target === 1) paintStep1();
        else if (target === 2) paintStep2();
        else if (target === 3) paintStep3();
        else if (target === 4) paintStep4();
        else if (target === 5) paintStep5();
      });
    });
  }

  // ============ イベントバインド ============
  function bindEvents() {
    // 下部ナビ
    $('btn-next').addEventListener('click', goNext);
    $('btn-back').addEventListener('click', goBack);
    $('btn-execute').addEventListener('click', function () {
      alert('Step 7 自動処理本体は次フェーズで実装予定です。\n\n本フェーズ（7-C）は Step 3 マスタ件数枠の運営内部管理項目追加までの実装範囲です。');
    });

    // ステッパー円クリック
    document.querySelectorAll('.step-item').forEach(function (li) {
      li.addEventListener('click', function () {
        const step = parseInt(li.getAttribute('data-step'), 10);
        gotoStep(step);
      });
    });

    // Step 1：契約期間変更時に終了日を再計算
    $('f1-contract-duration').addEventListener('change', function () {
      toggleContractEndEditable();
      recomputeContractEnd();
    });
    $('f1-contract-start').addEventListener('change', recomputeContractEnd);
    // 終了日 (custom 時のみ手動編集可)
    $('f1-contract-end').addEventListener('change', function () {
      if ($('f1-contract-duration').value === 'custom') {
        RegisterState.data.step1.contractEnd = $('f1-contract-end').value;
      }
    });

    // Step 2：ラジオ変更でグレード更新
    document.querySelectorAll('input[name="f2-timecard"]').forEach(function (r) {
      r.addEventListener('change', updateGradeDerivation);
    });

    // Step 3：サービステーブルのイベント委譲
    const svcBody = $('register-service-tbody');
    svcBody.addEventListener('input', function (e) {
      if (e.target.dataset.svcIdx !== undefined) syncServiceTableToState();
    });
    svcBody.addEventListener('change', function (e) {
      if (e.target.dataset.svcIdx !== undefined) syncServiceTableToState();
    });
    svcBody.addEventListener('click', function (e) {
      if (e.target.dataset.svcDel !== undefined) {
        deleteService(parseInt(e.target.dataset.svcDel, 10));
      }
    });
    $('btn-add-service').addEventListener('click', addService);

    // Step 3：科目マスタテーブルのイベント委譲
    const cmBody = $('register-cost-tbody');
    cmBody.addEventListener('input', function (e) {
      if (e.target.dataset.cmIdx !== undefined) syncCostTableToState();
    });
    cmBody.addEventListener('change', function (e) {
      if (e.target.dataset.cmIdx !== undefined) syncCostTableToState();
    });

    // Step 4：ファイル選択
    $('btn-pick-logo').addEventListener('click', function () {
      pickFile('f4-logo-file', { field: 'logoFile', previewId: 'preview-logo', filenameId: 'f4-logo-filename' });
    });
    $('btn-pick-icon-192').addEventListener('click', function () {
      pickFile('f4-icon192-file', { field: 'icon192File', previewId: 'preview-icon-192', filenameId: 'f4-icon192-filename' });
    });
    $('btn-pick-icon-512').addEventListener('click', function () {
      pickFile('f4-icon512-file', { field: 'icon512File', previewId: 'preview-icon-512', filenameId: 'f4-icon512-filename' });
    });

    // Step 4：色 input ⇔ text 同期 + プリセット
    ['logo-bg-color', 'theme-color'].forEach(function (suffix) {
      const colorEl = $('f4-' + suffix);
      const textEl = $('f4-' + suffix + '-text');
      colorEl.addEventListener('input', function () { textEl.value = colorEl.value.toUpperCase(); });
      textEl.addEventListener('input', function () {
        if (/^#[0-9A-Fa-f]{6}$/.test(textEl.value)) colorEl.value = textEl.value;
      });
    });
    document.querySelectorAll('.theme-preset').forEach(function (b) {
      b.style.background = b.dataset.color;
      b.addEventListener('click', function () {
        const col = b.dataset.color;
        $('f4-theme-color').value = col;
        $('f4-theme-color-text').value = col.toUpperCase();
      });
    });

    // Step 5：自動/手動 切替
    document.querySelectorAll('input[name="f5-pin-mode"]').forEach(function (r) {
      r.addEventListener('change', function () {
        RegisterState.data.step5.pinMode = r.value;
        if (r.value === 'auto') {
          $('f5-pin').readOnly = true;
          $('f5-pin').classList.add('readonly');
          $('btn-regenerate-pin').hidden = false;
          const pin = generateAutoPin();
          $('f5-pin').value = pin;
          RegisterState.data.step5.pin = pin;
          updatePinWarning();
        } else {
          $('f5-pin').readOnly = false;
          $('f5-pin').classList.remove('readonly');
          $('btn-regenerate-pin').hidden = true;
          $('f5-pin').value = '';
          RegisterState.data.step5.pin = '';
          updatePinWarning();
        }
      });
    });
    $('btn-regenerate-pin').addEventListener('click', function () {
      const pin = generateAutoPin();
      $('f5-pin').value = pin;
      RegisterState.data.step5.pin = pin;
      updatePinWarning();
    });
    $('f5-pin').addEventListener('input', function () {
      // 手動モード時のみ反映
      if (RegisterState.data.step5.pinMode === 'manual') {
        RegisterState.data.step5.pin = $('f5-pin').value.trim();
        updatePinWarning();
      }
    });

    // 離脱警告（入力された後）
    window.addEventListener('beforeunload', function (e) {
      const s = RegisterState.data.step1;
      const anyEntered = s.contractorName || s.representativeName || s.storeName;
      if (anyEntered) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }
})();
