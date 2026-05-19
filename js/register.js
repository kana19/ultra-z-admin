/* ============================================================
 * ultra-z-admin / 第7段階 小段階7-C 新規登録ウィザード
 *   - 7ステップ構成（Step 1〜6 入力 + Step 7 自動処理本体）
 *   - 7-C 改修点：
 *       Step 7 自動処理本体を実装（プレースホルダから本実装へ移行）
 *       マスタGAS の 8 action を順次呼出して新規ユーザー環境を構築：
 *         1. generateClientId       → clientId 採番
 *         2. createUserRepository   → GitHub テンプレからフォーク
 *         3. uploadUserAsset × 3    → logo / icon-192 / icon-512（任意・選択時のみ）
 *                                     skipClientCheck:true を付与（マスタGAS v0.5.7 対応・
 *                                     registerNewClient 実行前のため clients シート未登録）
 *         4. writeUserRepositoryFiles → manifest.json / theme.css / app.js
 *         5. createUserSpreadsheet  → ユーザーSS 新規作成＋B17 masterQuota 初期投入
 *         6. createUserGasDeployment → Apps Script API V1 でGAS デプロイ
 *         7. registerNewClient      → clients/auth/change_log 一括投入
 *         8. generateDeliveryCard   → 納品カード A6 PDF 生成
 *       PIN ハッシュ化：SHA-256(clientId + '|' + pin) を Web Crypto API で計算
 *       進捗UI：8ステップを段階的に表示・各ステップ成功時にチェック・エラー時に赤表示
 *       完了画面：納品カードPDFダウンロード・各種URL・PINを表示
 *       エラー時：失敗ステップを明示・既に作成された clientId を表示
 *                 （自動ロールバックは実装しない・運営側で個別対応）
 *       btn-execute クリック時ガード：currentStep !== 7 ならスキップ・
 *                 多重実行防止（Step7Progress.running / completed チェック）
 *   - 6-F 改修点（継続）：
 *       3-2-①：サービスマスタの smartphoneVisible 列を廃止（4列構成）
 *            登録＝表示固定・業種により非表示にする概念なし（00_原則.md §6-5）
 *       3-2-②：仕入マスタの smartphoneVisible 列を廃止（4列構成）
 *            登録＝表示固定（同上）
 *       3-2-③：販管費マスタの列ラベル「スマホ・iPad表示」→「アプリ表示」に変更
 *            （業種により使わない科目をユーザーアプリ側で非表示にする運用専用）
 *       defaultPurchaseMasterListFixture から smartphoneVisible:true を削除
 *       Step 6 サマリーの「スマホ・iPad表示 X件」→「アプリ表示 X件」
 *   - 6-E 改修点（継続）：
 *       3-1：販管費マスタ任意枠（C）5件固定化（編集UI廃止・固定表示テキスト化）
 *            （税務署様式準拠・拡張販売対象外・01_商品体系.md §4-2）
 *            state.step3.costOptionalQuota は 5 固定維持・readStep3 / paintStep3 から coq input 操作削除
 *       3-2-①：サービスマスタに id フィールド対応（sv001〜連番自動採番）
 *            03_データ仕様.md §1-1 serviceList JSON 構造に整合
 *       Step 6 サマリーに「販管費マスタ任意枠：5件固定」明示
 *   - 6-D 改修点（継続）：
 *       Step 3 を2段構成（3-1 枠付与＋3-2 雛形投入）
 *       仕入マスタ ID プレフィックス `pNNN` 連番自動採番
 *       業種別自動判定機構は導入しない（00_原則.md §4-5）
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
        // 6-D：マスタ件数枠（運営側内部管理項目・01_商品体系.md §4-2）
        // 基本枠：S=5 / P=3 / C=5・UI硬制限なし・拡張オプション販売時は edit 画面でも変更可
        serviceMasterQuota: 5,
        purchaseMasterQuota: 3,
        costOptionalQuota: 5,
        serviceList: [],
        purchaseMasterList: [],   // 6-D：新設・settings.B5 へ投入
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
  // 6-D：仕入原価マスタ汎用フォールバック雛形（3件）
  // マスタGAS v0.5.5 の _defaultPurchaseMasterList_ と完全整合。
  // ID プレフィックス `pNNN` 連番（コストシート F列に格納される値と一致）。
  // 業種別自動判定機構はなし（00_原則.md §4-5）。
  // 業種カスタマイズはターゲット社が納品時にこのウィザードまたは edit 画面で手作業投入。
  // 6-F：smartphoneVisible フィールド削除（登録＝表示固定・00_原則.md §6-5）
  function defaultPurchaseMasterList() {
    return [
      { id: 'p001', name: '仕入',     defaultTaxRate: 10 },
      { id: 'p002', name: '材料費',   defaultTaxRate: 10 },
      { id: 'p003', name: '消耗品',   defaultTaxRate: 10 }
    ];
  }

  function initStep3Defaults() {
    RegisterState.data.step3.serviceList = [];
    RegisterState.data.step3.purchaseMasterList = defaultPurchaseMasterList();
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
    if (n === 3) { renderServiceTable(); renderPurchaseTable(); renderCostTable(); paintStep3(); }
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
    // 6-E：付与枠数を state から input に復元（S/P のみ・C は固定5表示でinput無し）
    const s3 = RegisterState.data.step3;
    const smqEl = $('f3-service-master-quota');
    const pmqEl = $('f3-purchase-master-quota');
    if (smqEl) smqEl.value = s3.serviceMasterQuota;
    if (pmqEl) pmqEl.value = s3.purchaseMasterQuota;
    // 6-E：C は5固定維持（state に保持・HTML側は固定表示テキスト）
    s3.costOptionalQuota = 5;
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
    // 6-E：付与枠数を input から state に反映（S/P のみ・C は5固定維持）
    const s3 = RegisterState.data.step3;
    const smqEl = $('f3-service-master-quota');
    const pmqEl = $('f3-purchase-master-quota');
    if (smqEl) {
      const v = parseInt(smqEl.value, 10);
      if (!isFinite(v) || v < 1) {
        showStepError('step3-error', 'サービスマスタの付与枠数は1以上の整数で指定してください');
        return false;
      }
      s3.serviceMasterQuota = v;
    }
    if (pmqEl) {
      const v = parseInt(pmqEl.value, 10);
      if (!isFinite(v) || v < 1) {
        showStepError('step3-error', '仕入マスタの付与枠数は1以上の整数で指定してください');
        return false;
      }
      s3.purchaseMasterQuota = v;
    }
    // 6-E：C は5固定（編集UI廃止・税務署様式準拠）
    s3.costOptionalQuota = 5;
    // サービス・仕入・販管費マスタは行内 input を逐次読込（イベント側で随時 state に反映している前提）
    // 念のため最終同期
    syncServiceTableToState();
    syncPurchaseTableToState();   // 6-D：仕入マスタ同期
    syncCostTableToState();
    // バリデーション：サービス名空文字は自動除去（規定）。固定科目改名は readonly のためそもそも変えられない
    RegisterState.data.step3.serviceList = RegisterState.data.step3.serviceList.filter(function (s) {
      return s && s.name;
    });
    // 6-D：仕入マスタ・名前空欄は自動除去（規定）
    RegisterState.data.step3.purchaseMasterList = RegisterState.data.step3.purchaseMasterList.filter(function (p) {
      return p && p.name;
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

  // 6-E：戻る／円ジャンプ時の付与枠数だけはバリデーション抜きで state へ吸い上げる
  // （バリデーションエラーは「次へ」時のみ表示）S/P 2軸対応・C は5固定維持
  function readStep3QuotasSilent() {
    const s3 = RegisterState.data.step3;
    const smqEl = $('f3-service-master-quota');
    const pmqEl = $('f3-purchase-master-quota');
    if (smqEl) {
      const v = parseInt(smqEl.value, 10);
      if (isFinite(v) && v >= 1) s3.serviceMasterQuota = v;
    }
    if (pmqEl) {
      const v = parseInt(pmqEl.value, 10);
      if (isFinite(v) && v >= 1) s3.purchaseMasterQuota = v;
    }
    // 6-E：C は5固定維持（input が存在しない）
    s3.costOptionalQuota = 5;
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
  // 6-F：smartphoneVisible 列廃止（登録＝表示固定・00_原則.md §6-5）
  //   4列構成（コード・サービス名・税率・操作）
  // 6-E：id フィールド対応（sv001〜連番自動採番）
  //   03_データ仕様.md §1-1 serviceList JSON 構造に整合
  //   各科目には sv001〜の連番ID（コード）が自動採番される
  function renderServiceTable() {
    const tbody = $('register-service-tbody');
    tbody.innerHTML = '';
    const list = RegisterState.data.step3.serviceList;
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-row">サービス未登録（後で追加可能）</td></tr>';
      return true;
    }
    list.forEach(function (svc, idx) {
      const idDisplay = svc.id || '(未割当)';
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td><span class="readonly-text">' + escapeHtml(idDisplay) + '</span></td>' +
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
    // 6-E：id を維持するため既存リストを保持してマージ更新する
    const existing = JSON.parse(JSON.stringify(RegisterState.data.step3.serviceList || []));
    const inputs = tbody.querySelectorAll('[data-svc-idx]');
    inputs.forEach(function (el) {
      const idx = parseInt(el.dataset.svcIdx, 10);
      const field = el.dataset.svcField;
      if (!existing[idx]) existing[idx] = {};
      if (field === 'taxRate') existing[idx][field] = parseInt(el.value, 10);
      else if (field === 'name') existing[idx][field] = el.value.trim();
    });
    // 6-F：smartphoneVisible が残っていれば除去（防御的に）
    existing.forEach(function (s) {
      if (s && 'smartphoneVisible' in s) delete s.smartphoneVisible;
    });
    RegisterState.data.step3.serviceList = existing.filter(function (s) { return s; });
    return true;
  }
  // ID プレフィックス `svNNN` の連番自動採番（既存IDの最大値+1）
  function nextServiceId() {
    const list = RegisterState.data.step3.serviceList || [];
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
  function addService() {
    syncServiceTableToState();
    RegisterState.data.step3.serviceList.push({
      id: nextServiceId(),
      name: '',
      taxRate: 10
    });
    renderServiceTable();
  }
  function deleteService(idx) {
    syncServiceTableToState();
    RegisterState.data.step3.serviceList.splice(idx, 1);
    renderServiceTable();
  }

  // ============ Step 3 仕入マスタテーブル（6-D 新設） ============
  // 03_データ仕様.md §1-3 purchaseMasterList の編集 UI
  // ID プレフィックス：p001〜（コストシート F列に格納される値と一致）
  // 業種別自動判定機構はなし（00_原則.md §4-5）
  // 6-F：smartphoneVisible 列廃止（登録＝表示固定・00_原則.md §6-5）
  //   4列構成（コード・科目名・税率・操作）
  function renderPurchaseTable() {
    const tbody = $('register-purchase-tbody');
    if (!tbody) return true;
    tbody.innerHTML = '';
    const list = RegisterState.data.step3.purchaseMasterList || [];
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-row">仕入科目未登録（後で追加可能）</td></tr>';
      return true;
    }
    list.forEach(function (p, idx) {
      const taxRate = (p.defaultTaxRate != null ? p.defaultTaxRate : (p.taxRate != null ? p.taxRate : 10));
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td><span class="readonly-text">' + escapeHtml(p.id || '(未割当)') + '</span></td>' +
        '<td><input type="text" data-pm-idx="' + idx + '" data-pm-field="name" value="' + escapeHtml(p.name || '') + '" maxlength="30" placeholder="（例：仕入(酒類・食材)）"></td>' +
        '<td>' +
          '<select data-pm-idx="' + idx + '" data-pm-field="defaultTaxRate">' +
            '<option value="0"'  + (Number(taxRate) === 0  ? ' selected' : '') + '>0%</option>' +
            '<option value="8"'  + (Number(taxRate) === 8  ? ' selected' : '') + '>8%</option>' +
            '<option value="10"' + (Number(taxRate) === 10 ? ' selected' : '') + '>10%</option>' +
          '</select>' +
        '</td>' +
        '<td><button type="button" class="btn-icon-delete" data-pm-del="' + idx + '">🗑️</button></td>';
      tbody.appendChild(tr);
    });
    return true;
  }

  function syncPurchaseTableToState() {
    const tbody = $('register-purchase-tbody');
    if (!tbody) return true;
    const updated = JSON.parse(JSON.stringify(RegisterState.data.step3.purchaseMasterList || []));
    const inputs = tbody.querySelectorAll('[data-pm-idx]');
    inputs.forEach(function (el) {
      const idx = parseInt(el.dataset.pmIdx, 10);
      const field = el.dataset.pmField;
      if (!updated[idx]) return;
      if (field === 'defaultTaxRate') updated[idx][field] = parseInt(el.value, 10);
      else if (field === 'name') updated[idx][field] = el.value.trim();
    });
    // 6-F：smartphoneVisible が残っていれば除去（防御的に）
    updated.forEach(function (p) {
      if (p && 'smartphoneVisible' in p) delete p.smartphoneVisible;
    });
    RegisterState.data.step3.purchaseMasterList = updated;
    return true;
  }

  // ID プレフィックス `pNNN` の連番自動採番（既存IDの最大値+1）
  function nextPurchaseId() {
    const list = RegisterState.data.step3.purchaseMasterList || [];
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

  function addPurchase() {
    syncPurchaseTableToState();
    if (!Array.isArray(RegisterState.data.step3.purchaseMasterList)) {
      RegisterState.data.step3.purchaseMasterList = [];
    }
    RegisterState.data.step3.purchaseMasterList.push({
      id: nextPurchaseId(),
      name: '',
      defaultTaxRate: 10
    });
    renderPurchaseTable();
  }

  function deletePurchase(idx) {
    syncPurchaseTableToState();
    RegisterState.data.step3.purchaseMasterList.splice(idx, 1);
    renderPurchaseTable();
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
    // 6-D：仕入マスタサマリー
    const purchaseList = s3.purchaseMasterList || [];
    const purchaseText = purchaseList.length
      ? purchaseList.map(function (p) {
          const tax = (p.defaultTaxRate != null ? p.defaultTaxRate : (p.taxRate != null ? p.taxRate : 10));
          return p.name + '（' + tax + '%）';
        }).join(' / ')
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
      section('Step 3：マスタ件数枠＋3種マスタ雛形', 3, [
        // 6-E：S/P は編集可・C は5件固定（税務署様式準拠・編集不可）
        ['付与枠数（運営内部管理・S/P）',
          'サービスマスタ ' + s3.serviceMasterQuota + ' 件 / ' +
          '仕入マスタ ' + s3.purchaseMasterQuota + ' 件'],
        ['販管費マスタ任意枠（C）', '5件固定（税務署様式準拠・編集不可）'],
        ['サービスマスタ', serviceText],
        ['仕入マスタ', purchaseText],
        ['販管費マスタ', '青色申告デフォルト 24件 / 任意枠使用 ' + customCostCount + ' 件 / アプリ表示 ' + visibleCount + ' 件']
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

  // ============================================================
  // Step 7：自動処理本体（7-C）
  //   マスタGAS の 8 action を順次呼出して新規ユーザー環境を構築する。
  //   進捗を画面に逐次表示し、エラー時は失敗ステップ＋clientId を提示する。
  //
  //   実行順序（04_運営ポータル.md §3 Step 7 準拠）：
  //     1. generateClientId          → state.clientId 保持
  //     2. createUserRepository      → GitHubテンプレ ultra-z-leo からフォーク
  //     3. uploadUserAsset × 3        → logo / icon-192 / icon-512（選択時のみ）
  //     4. writeUserRepositoryFiles  → manifest.json / theme.css / app.js 書込
  //     5. createUserSpreadsheet     → SS生成＋settings初期化＋B17 masterQuota
  //     6. createUserGasDeployment   → Apps Script API V1 でGAS デプロイ
  //     7. registerNewClient         → clients/auth/change_log 一括投入
  //     8. generateDeliveryCard      → 納品カードPDF（A6・Base64）
  //
  //   エラーハンドリング：
  //     - 各ステップで応答 ok:false なら即停止
  //     - 既に作成された clientId / spreadsheetId / repoUrl / gasUrl を表示
  //     - 自動ロールバックは実装しない（複合トランザクション化はスコープ外）
  //     - 失敗内容を運営に明示し、運営側で個別対応する設計（プロジェクト指示 §3-2）
  // ============================================================

  // 実行状態の管理（プログレスUI 更新と完了画面の組立で参照）
  const Step7Progress = {
    running: false,
    clientId: '',
    spreadsheetId: '',
    spreadsheetUrl: '',
    repoUrl: '',
    gasUrl: '',
    deliveryCardBase64: '',
    completed: false,
    failedAt: '',
    errorMessage: ''
  };

  // 進捗UIの定義（8 ステップ）
  // id: progress-row 要素の data-step-id 属性と一致
  // label: 画面表示ラベル
  const STEP7_STAGES = [
    { id: 'clientId',     label: '1. clientId 発行' },
    { id: 'repo',         label: '2. GitHubリポジトリ生成' },
    { id: 'assets',       label: '3. ロゴ・アイコン アップロード' },
    { id: 'repoFiles',    label: '4. manifest / theme.css / app.js 書込' },
    { id: 'spreadsheet',  label: '5. ユーザーSS 生成・settings 初期化' },
    { id: 'gas',          label: '6. ユーザーGAS デプロイ' },
    { id: 'client',       label: '7. clients/auth/change_log 投入' },
    { id: 'deliveryCard', label: '8. 納品カード PDF 生成' }
  ];

  // ---- SHA-256（Web Crypto API）-----------------------------------
  // マスタGAS hashPin(pin, salt) と同一仕様：salt + '|' + pin の SHA-256 を16進文字列で返す
  // 新規登録時の salt は clientId（マスタGAS 側 _changeUserPin_ 等と整合）
  async function sha256Hex(text) {
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
    const bytes = new Uint8Array(buf);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      hex += ('0' + bytes[i].toString(16)).slice(-2);
    }
    return hex;
  }
  async function hashPin(pin, salt) {
    return sha256Hex(String(salt || '') + '|' + String(pin));
  }

  // ---- File → Base64（dataURL ヘッダー除去後の純Base64）---------
  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      if (!file) { resolve(''); return; }
      const reader = new FileReader();
      reader.onload = function () {
        const result = String(reader.result || '');
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = function () { reject(new Error('FileReader 失敗：' + file.name)); };
      reader.readAsDataURL(file);
    });
  }

  // ---- 進捗UI 操作 ------------------------------------------------
  function step7SetStatus(stageId, status, detail) {
    // status: 'pending' | 'running' | 'done' | 'error'
    const row = document.querySelector('[data-step-id="' + stageId + '"]');
    if (!row) return;
    row.classList.remove('progress-pending', 'progress-running', 'progress-done', 'progress-error');
    row.classList.add('progress-' + status);
    const iconEl = row.querySelector('.progress-icon');
    if (iconEl) {
      iconEl.textContent =
        status === 'done'    ? '✅' :
        status === 'error'   ? '❌' :
        status === 'running' ? '⏳' : '○';
    }
    if (detail !== undefined) {
      const detailEl = row.querySelector('.progress-detail');
      if (detailEl) detailEl.textContent = detail || '';
    }
  }

  function step7InitProgressUI() {
    const container = $('step7-progress-container');
    if (!container) return;
    container.innerHTML = STEP7_STAGES.map(function (s) {
      return (
        '<div class="progress-row progress-pending" data-step-id="' + s.id + '">' +
          '<span class="progress-icon">○</span>' +
          '<span class="progress-label">' + escapeHtml(s.label) + '</span>' +
          '<span class="progress-detail"></span>' +
        '</div>'
      );
    }).join('');
  }

  // 実行中の操作（執行用ヘルパー：応答が ok:false なら例外 throw）
  async function callGasAction(action, extra) {
    const res = await window.uzAdmin.callMasterGas(action, extra || {});
    if (window.uzAdmin.handleAuthError && window.uzAdmin.handleAuthError(res)) {
      // セッション失効：handleAuthError が index.html へ遷移済
      throw new Error('セッション失効');
    }
    if (!res || res.ok !== true) {
      const code = (res && (res.code || res.error)) || 'unknown';
      const msg  = (res && (res.message || res._message)) || '';
      const err = new Error(action + ' 失敗 [' + code + ']' + (msg ? ' ' + msg : ''));
      err._gasResponse = res;
      throw err;
    }
    return res;
  }

  // 完了画面の組立
  function buildCompletionView() {
    const s1 = RegisterState.data.step1;
    const ownerUrl = 'https://kana19.github.io/' + Step7Progress.clientId + '/';
    const staffUrl = ownerUrl + 'staff-clockin.html';
    const pdfBase64 = Step7Progress.deliveryCardBase64;
    const pdfHref = pdfBase64
      ? 'data:application/pdf;base64,' + pdfBase64
      : '#';
    const pdfFilename = 'delivery_card_' + Step7Progress.clientId + '.pdf';

    return (
      '<div class="completion-card">' +
        '<div class="completion-header">' +
          '<span class="completion-icon">🎉</span>' +
          '<h3>新規登録が完了しました</h3>' +
        '</div>' +
        '<dl class="completion-list">' +
          '<dt>店舗名</dt><dd>' + escapeHtml(s1.storeName) + '</dd>' +
          '<dt>clientId</dt><dd><code>' + escapeHtml(Step7Progress.clientId) + '</code></dd>' +
          '<dt>オーナーアプリ URL</dt><dd><a href="' + escapeHtml(ownerUrl) + '" target="_blank" rel="noopener">' + escapeHtml(ownerUrl) + '</a></dd>' +
          '<dt>スタッフ打刻 URL</dt><dd><a href="' + escapeHtml(staffUrl) + '" target="_blank" rel="noopener">' + escapeHtml(staffUrl) + '</a></dd>' +
          '<dt>ユーザーSS URL</dt><dd><a href="' + escapeHtml(Step7Progress.spreadsheetUrl) + '" target="_blank" rel="noopener">' + escapeHtml(Step7Progress.spreadsheetUrl) + '</a></dd>' +
          '<dt>ユーザーGAS URL</dt><dd><code class="break-all">' + escapeHtml(Step7Progress.gasUrl) + '</code></dd>' +
          '<dt>初期PIN</dt><dd><code>' + escapeHtml(RegisterState.data.step5.pin) + '</code> <span class="completion-warn">⚠ お客様へ別途お伝えください</span></dd>' +
        '</dl>' +
        (pdfBase64
          ? '<div class="completion-actions">' +
              '<a class="btn-primary" href="' + pdfHref + '" download="' + escapeHtml(pdfFilename) + '">📄 納品カードPDFをダウンロード</a>' +
              '<a class="btn-secondary" href="dashboard.html">ダッシュボードへ戻る</a>' +
            '</div>'
          : '<div class="completion-actions">' +
              '<a class="btn-secondary" href="dashboard.html">ダッシュボードへ戻る</a>' +
            '</div>'
        ) +
      '</div>'
    );
  }

  // エラー画面の組立
  function buildErrorView() {
    const completedItems = [];
    if (Step7Progress.clientId)       completedItems.push(['clientId',       Step7Progress.clientId]);
    if (Step7Progress.repoUrl)        completedItems.push(['リポジトリ',     Step7Progress.repoUrl]);
    if (Step7Progress.spreadsheetUrl) completedItems.push(['ユーザーSS',     Step7Progress.spreadsheetUrl]);
    if (Step7Progress.gasUrl)         completedItems.push(['ユーザーGAS URL', Step7Progress.gasUrl]);

    return (
      '<div class="completion-card completion-card--error">' +
        '<div class="completion-header">' +
          '<span class="completion-icon">⚠</span>' +
          '<h3>登録処理が中断しました</h3>' +
        '</div>' +
        '<p class="completion-error-message">' +
          '失敗ステップ：<strong>' + escapeHtml(Step7Progress.failedAt) + '</strong><br>' +
          escapeHtml(Step7Progress.errorMessage) +
        '</p>' +
        (completedItems.length
          ? '<p>以下は作成済です（必要に応じて手動でロールバック・再開してください）：</p>' +
            '<dl class="completion-list">' +
              completedItems.map(function (r) {
                return '<dt>' + escapeHtml(r[0]) + '</dt><dd><code class="break-all">' + escapeHtml(r[1]) + '</code></dd>';
              }).join('') +
            '</dl>'
          : '<p>マスタGAS への呼出は発生していません。Step 6 へ戻って再実行可能です。</p>'
        ) +
        '<div class="completion-actions">' +
          '<a class="btn-secondary" href="dashboard.html">ダッシュボードへ戻る</a>' +
        '</div>' +
      '</div>'
    );
  }

  // メイン実行関数
  async function executeStep7() {
    if (Step7Progress.running) return;
    if (Step7Progress.completed) return;
    Step7Progress.running = true;
    Step7Progress.clientId = '';
    Step7Progress.spreadsheetId = '';
    Step7Progress.spreadsheetUrl = '';
    Step7Progress.repoUrl = '';
    Step7Progress.gasUrl = '';
    Step7Progress.deliveryCardBase64 = '';
    Step7Progress.completed = false;
    Step7Progress.failedAt = '';
    Step7Progress.errorMessage = '';

    // UI 初期化
    step7InitProgressUI();
    const execBtn = $('btn-execute');
    if (execBtn) execBtn.disabled = true;
    const backBtn = $('btn-back');
    if (backBtn) backBtn.disabled = true;
    const completionEl = $('step7-completion');
    if (completionEl) completionEl.innerHTML = '';

    const s1 = RegisterState.data.step1;
    const s2 = RegisterState.data.step2;
    const s3 = RegisterState.data.step3;
    const s4 = RegisterState.data.step4;
    const s5 = RegisterState.data.step5;

    // 各ステップを順次実行（ok:false で throw して catch で停止）
    try {

      // ---- 1. generateClientId ----
      step7SetStatus('clientId', 'running', '採番中...');
      const r1 = await callGasAction('generateClientId', {});
      Step7Progress.clientId = String(r1.clientId || '');
      if (!Step7Progress.clientId) {
        throw new Error('generateClientId 応答に clientId が含まれていません');
      }
      step7SetStatus('clientId', 'done', Step7Progress.clientId);

      // ---- 2. createUserRepository ----
      step7SetStatus('repo', 'running', 'GitHub テンプレからフォーク中...');
      const r2 = await callGasAction('createUserRepository', {
        clientId: Step7Progress.clientId,
        storeName: s1.storeName
      });
      Step7Progress.repoUrl = String(r2.repoUrl || '');
      step7SetStatus('repo', 'done', Step7Progress.repoUrl || '(URLなし)');

      // ---- 3. uploadUserAsset × 3（選択時のみ）----
      step7SetStatus('assets', 'running', 'アップロード中...');
      const assets = [
        { type: 'store-logo', file: s4.logoFile,    label: 'ロゴ'      },
        { type: 'icon-192',   file: s4.icon192File, label: 'アイコン192' },
        { type: 'icon-512',   file: s4.icon512File, label: 'アイコン512' }
      ];
      const uploadedLabels = [];
      const skippedLabels = [];
      for (let i = 0; i < assets.length; i++) {
        const a = assets[i];
        if (!a.file) { skippedLabels.push(a.label); continue; }
        const b64 = await fileToBase64(a.file);
        await callGasAction('uploadUserAsset', {
          clientId: Step7Progress.clientId,
          assetType: a.type,
          fileBase64: b64,
          mimeType: a.file.type,
          // v0.5.7：新規登録時は registerNewClient 実行前のため clients シート参照を
          // バイパスする（マスタGAS v0.5.7 の skipClientCheck 対応）
          skipClientCheck: true
        });
        uploadedLabels.push(a.label);
      }
      const assetDetail =
        (uploadedLabels.length ? uploadedLabels.join('・') + ' アップロード済' : '全てスキップ') +
        (skippedLabels.length  ? '（未選択：' + skippedLabels.join('・') + '）' : '');
      step7SetStatus('assets', 'done', assetDetail);

      // ---- 4. writeUserRepositoryFiles ----
      // 注：このステップは createUserGasDeployment 完了後の gasUrl が必要だが、
      //     マスタGAS 側の writeUserRepositoryFiles は gasUrl を必須要求する仕様。
      //     順序を入れ替え：5（SS）→ 6（GAS）→ 4（リポファイル）の順で実行する。
      //     UI 上は「4. リポファイル書込」と表示しつつ、実行順序は SS/GAS 完了後とする。
      step7SetStatus('repoFiles', 'pending', '（SS・GAS 生成後に実行）');

      // ---- 5. createUserSpreadsheet ----
      step7SetStatus('spreadsheet', 'running', 'SS 生成中...');
      const r5 = await callGasAction('createUserSpreadsheet', {
        clientId:             Step7Progress.clientId,
        storeName:            s1.storeName,
        serviceList:          s3.serviceList,
        costMasterList:       s3.costMasterList,
        purchaseMasterList:   s3.purchaseMasterList,
        businessHours:        s1.businessHours,
        serviceMasterQuota:   s3.serviceMasterQuota,
        purchaseMasterQuota:  s3.purchaseMasterQuota,
        costOptionalQuota:    s3.costOptionalQuota
      });
      Step7Progress.spreadsheetId = String(r5.spreadsheetId || '');
      Step7Progress.spreadsheetUrl = String(r5.spreadsheetUrl || '');
      if (!Step7Progress.spreadsheetId) {
        throw new Error('createUserSpreadsheet 応答に spreadsheetId が含まれていません');
      }
      step7SetStatus('spreadsheet', 'done', Step7Progress.spreadsheetId);

      // ---- 6. createUserGasDeployment ----
      step7SetStatus('gas', 'running', 'Apps Script API V1 でデプロイ中（30秒〜1分）...');
      const r6 = await callGasAction('createUserGasDeployment', {
        clientId:      Step7Progress.clientId,
        spreadsheetId: Step7Progress.spreadsheetId
      });
      Step7Progress.gasUrl = String(r6.gasUrl || '');
      if (!Step7Progress.gasUrl) {
        throw new Error('createUserGasDeployment 応答に gasUrl が含まれていません');
      }
      step7SetStatus('gas', 'done', 'デプロイ完了');

      // ---- 4 実行（writeUserRepositoryFiles を SS/GAS 後に実行）----
      step7SetStatus('repoFiles', 'running', 'manifest / theme.css / app.js 書込中...');
      await callGasAction('writeUserRepositoryFiles', {
        clientId:    Step7Progress.clientId,
        gasUrl:      Step7Progress.gasUrl,
        storeName:   s1.storeName,
        themeColor:  s4.themeColor,
        logoBgColor: s4.logoBgColor
      });
      step7SetStatus('repoFiles', 'done', '4ファイル書込済');

      // ---- 7. registerNewClient ----
      step7SetStatus('client', 'running', 'PINハッシュ計算・clients/auth/change_log 投入中...');
      const pinHashHex = await hashPin(s5.pin, Step7Progress.clientId);
      await callGasAction('registerNewClient', {
        clientId: Step7Progress.clientId,
        pinHash:  pinHashHex,
        fields: {
          storeName:           s1.storeName,
          timecardCount:       s2.timecardCount,
          spreadsheetId:       Step7Progress.spreadsheetId,
          gasUrl:              Step7Progress.gasUrl,
          partnerId:           '',
          contractStart:       s1.contractStart,
          contractEnd:         s1.contractEnd,
          monthlyFee:          s1.monthlyFee,
          serviceMasterQuota:  s3.serviceMasterQuota,
          purchaseMasterQuota: s3.purchaseMasterQuota,
          costOptionalQuota:   s3.costOptionalQuota
        }
      });
      step7SetStatus('client', 'done', '投入完了');

      // ---- 8. generateDeliveryCard ----
      step7SetStatus('deliveryCard', 'running', 'A6 PDF 生成中...');
      const r8 = await callGasAction('generateDeliveryCard', {
        clientId: Step7Progress.clientId,
        pin:      s5.pin
      });
      Step7Progress.deliveryCardBase64 = String(r8.pdfBase64 || '');
      step7SetStatus('deliveryCard', 'done', '生成完了（' + (Step7Progress.deliveryCardBase64.length) + ' bytes）');

      // ---- 完了 ----
      Step7Progress.completed = true;
      Step7Progress.running = false;
      if (completionEl) completionEl.innerHTML = buildCompletionView();
      if (execBtn) execBtn.hidden = true;
      showToast('新規登録が完了しました', 'success');

    } catch (err) {
      // ---- エラー停止 ----
      Step7Progress.running = false;
      Step7Progress.errorMessage = String((err && err.message) || err);
      // 失敗ステップを特定（進捗UI の running 行）
      const runningRow = document.querySelector('[data-step-id].progress-running');
      if (runningRow) {
        const stageId = runningRow.getAttribute('data-step-id');
        const stage = STEP7_STAGES.filter(function (s) { return s.id === stageId; })[0];
        Step7Progress.failedAt = stage ? stage.label : stageId;
        step7SetStatus(stageId, 'error', Step7Progress.errorMessage);
      } else {
        Step7Progress.failedAt = '(不明)';
      }
      if (completionEl) completionEl.innerHTML = buildErrorView();
      if (execBtn) execBtn.disabled = false;
      if (backBtn) backBtn.disabled = false;
      showToast('登録処理が中断しました', 'error');
    }
  }


  function bindEvents() {
    // 下部ナビ
    $('btn-next').addEventListener('click', goNext);
    $('btn-back').addEventListener('click', goBack);
    $('btn-execute').addEventListener('click', function () {
      // 7-C：Step 7 自動処理本体を起動
      // 防御：Step 6 等で誤押下されても動かないガード（フッターボタン表示制御の
      //       タイミング不整合・CSS上の z-index 競合等を考慮）。
      //       本来は showStep() で hidden 切替されている想定だが、安全側に寄せる。
      if (RegisterState.currentStep !== 7) {
        return;
      }
      // 多重実行防止
      if (Step7Progress.running) return;
      if (Step7Progress.completed) return;

      // 確認ダイアログ（プロジェクト指示 §3-2 確定操作の3ステップ目）
      const s1 = RegisterState.data.step1;
      const okToProceed = confirm(
        '以下の内容で新規登録を実行します。\n\n' +
        '店舗名：' + s1.storeName + '\n' +
        'タイムカード数：' + RegisterState.data.step2.timecardCount + '\n' +
        '月額:¥' + Number(s1.monthlyFee).toLocaleString('ja-JP') + '\n\n' +
        '・GitHubリポジトリ生成\n' +
        '・Googleスプレッドシート生成\n' +
        '・Apps Script デプロイ\n' +
        '・clients / auth / change_log 投入\n' +
        '・納品カードPDF 生成\n\n' +
        'を一括実行します。所要時間 1〜2 分。よろしいですか？'
      );
      if (!okToProceed) return;
      executeStep7();
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

    // Step 3：仕入マスタテーブルのイベント委譲（6-D 新設）
    const pmBody = $('register-purchase-tbody');
    if (pmBody) {
      pmBody.addEventListener('input', function (e) {
        if (e.target.dataset.pmIdx !== undefined) syncPurchaseTableToState();
      });
      pmBody.addEventListener('change', function (e) {
        if (e.target.dataset.pmIdx !== undefined) syncPurchaseTableToState();
      });
      pmBody.addEventListener('click', function (e) {
        if (e.target.dataset.pmDel !== undefined) {
          deletePurchase(parseInt(e.target.dataset.pmDel, 10));
        }
      });
    }
    const btnAddPurchase = $('btn-add-purchase');
    if (btnAddPurchase) btnAddPurchase.addEventListener('click', addPurchase);

    // Step 3：販管費マスタテーブルのイベント委譲（6-D：「科目マスタ」→「販管費マスタ」改名）
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
