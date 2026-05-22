/* ============================================================
 * ultra-z-admin / 第7段階 小段階7-D 新規登録ウィザード（ハイブリッド方式）
 *   - 7ステップ構成（Step 1〜6 入力 + Step 7 自動処理本体）
 *   - 7-D 改修点（ハイブリッド方式）：
 *       Step 6（ユーザーGAS デプロイ）を Apps Script API V1 自動化から
 *       ターゲット社運営担当の手動デプロイ＋マスタGAS 補助型へ変更。
 *       背景：Google 公式が Apps Script API はサービスアカウントで動作しないと
 *       明示しており、責任を持って販売可能な商品とするため Google 標準フローへ移行。
 *
 *       マスタGAS の action ペア：
 *         prepareUserGasCode   → SPREADSHEET_ID 差込済の完成 GAS ソースを返却
 *         registerUserGasUrl   → 手動デプロイで取得した URL の形式検証＋疎通テスト
 *
 *       UI フロー：
 *         Step 5 完了後、Step 6 行にハイブリッドパネル展開
 *           ├ コード一式コピーボタン（prepareUserGasCode 経由）
 *           ├ Apps Script エディタ起動リンク
 *           ├ 手動デプロイ手順チェックリスト
 *           └ WebアプリURL 入力＋登録ボタン
 *         URL登録 → registerUserGasUrl で疎通確認 → 成功なら
 *         Step 4（リポファイル書込）・7（clients投入）・8（納品カードPDF）自動継続
 *
 *   - 7-C 改修点（継続・Step 6 以外）：
 *       マスタGAS の 8 action を順次呼出して新規ユーザー環境を構築：
 *         1. generateClientId       → clientId 採番
 *         2. createUserRepository   → GitHub テンプレからフォーク
 *         3. uploadUserAsset × 3    → logo / icon-192 / icon-512（任意・選択時のみ）
 *         4. writeUserRepositoryFiles → manifest.json / theme.css / app.js
 *         5. createUserSpreadsheet  → ユーザーSS 新規作成＋B17 masterQuota 初期投入
 *         6. prepareUserGasCode + 手動デプロイ + registerUserGasUrl ← 7-D 変更
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
        // マスタ件数枠（運営側内部管理項目・01_商品体系.md §4-2）
        // 基本枠：S=5 / P=5 / C=5・UI硬制限なし・拡張オプション販売時は edit 画面でも変更可
        // マスタの中身（サービス・仕入）はユーザーがアプリ側で登録する（確定仕様F）。
        // 運営は枠数のみ制御。serviceList / purchaseMasterList は空配列で投入する。
        // costMasterList は青色申告決算書互換の固定構造のため Step7 で defaultCostMasterList を投入する。
        serviceMasterQuota: 5,
        purchaseMasterQuota: 5,
        costOptionalQuota: 5,
        serviceList: [],
        purchaseMasterList: [],
        costMasterList: []
      },
      step4: {
        logoFile: null,
        icon192File: null,
        icon512File: null,
        icon192maskFile: null,
        icon512maskFile: null,
        appletouchFile: null,
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
  // Step3 初期化：マスタの中身はユーザー主権（確定仕様F）。
  //   サービス・仕入は空配列で投入し、ユーザーがアプリ側で登録する。
  //   販管費（costMasterList）は青色申告決算書互換の固定構造のため defaultCostMasterList を投入する。
  function initStep3Defaults() {
    RegisterState.data.step3.serviceList = [];
    RegisterState.data.step3.purchaseMasterList = [];
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
    // hidden 属性が CSS で上書きされるケースに備え style.display で確実に制御する
    if (n === 7) {
      // Step7：登録実行を右下（Step1〜6の「次へ」と同位置）に置く。
      //   戻る・次へは非表示。step-info を残して左右に分離（実行ボタンが右端）。
      //   修正は上部ステッパー円で戻れる。完了後は completion 内の「ダッシュボードへ戻る」。
      $('btn-back').style.display = 'none';
      $('footer-step-info').style.display = '';
      $('btn-next').hidden = true;
      $('btn-next').style.display = 'none';
      $('btn-execute').hidden = false;
      $('btn-execute').style.display = '';
    } else {
      // Step1〜6：戻る＋step-info＋次へ。登録実行は誤押下防止のため完全非表示。
      $('btn-back').style.display = '';
      $('btn-back').disabled = (n === 1);
      $('footer-step-info').style.display = '';
      $('btn-next').textContent = '次へ';
      $('btn-next').hidden = false;
      $('btn-next').style.display = '';
      $('btn-execute').hidden = true;
      $('btn-execute').style.display = 'none';
    }
    // Step 別の遅延描画
    if (n === 3) { renderCostTable(); paintStep3(); }
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
    updateNextDayBadge();
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
      closeNextDay: isCloseNextDay($('f1-business-open').value, $('f1-business-close').value)
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
    // 付与枠数を input から state に反映（S/P のみ・C は5固定維持）
    // マスタの中身（サービス・仕入）はユーザー主権のため空配列を維持する。
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
    // C は5固定（編集UI廃止・税務署様式準拠）
    s3.costOptionalQuota = 5;
    // 販管費マスタの行内編集を state へ最終同期
    syncCostTableToState();
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
    else if (cur === 3) { syncCostTableToState(); readStep3QuotasSilent(); }
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
    else if (cur === 3) { syncCostTableToState(); readStep3QuotasSilent(); }
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
  // 営業時間：終了時刻が開始時刻以前のとき翌日跨ぎと自動判定する。
  //   両時刻が同値のときは跨ぎなし（24時間営業や未設定の例外は判定しない）。
  function isCloseNextDay(open, close) {
    if (!open || !close) return false;
    return close <= open;
  }
  function updateNextDayBadge() {
    const badge = $('f1-next-day-badge');
    if (!badge) return;
    const cross = isCloseNextDay($('f1-business-open').value, $('f1-business-close').value);
    badge.hidden = !cross;
    badge.style.display = cross ? 'inline-block' : 'none';
  }
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

  // ============ Step 3 販管費マスタテーブル ============
  // 青色申告決算書互換の販管費科目（コードシート D列='2'・03_データ仕様.md §1-2）。
  //   固定枠（コード8〜25・31）は名称 readonly・税率と smartphoneVisible のみ編集可。
  //   任意枠（コード26〜30）は名称も編集可。
  //   smartphoneVisible はユーザーアプリのコスト入力モーダル販管費タブでの表示制御（00_原則.md §6-5）。
  function renderCostTable() {
    const tbody = $('register-cost-tbody');
    if (!tbody) return true;
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
    const customCostCount = (s3.costMasterList || []).filter(function (cm) {
      return [26, 27, 28, 29, 30].indexOf(Number(cm.code)) >= 0 && cm.name;
    }).length;
    const visibleCount = (s3.costMasterList || []).filter(function (cm) { return cm.smartphoneVisible; }).length;
    // 販管費マスタの詳細テーブル（コード・科目名・税率・アプリ表示）
    const costRows = (s3.costMasterList || []).slice().sort(function (a, b) {
      return Number(a.code) - Number(b.code);
    });
    const costTableHtml =
      '<table class="summary-cost-table" style="width:100%;border-collapse:collapse;font-size:13px;margin-top:4px">' +
        '<thead><tr>' +
          '<th style="text-align:left;border-bottom:1px solid #ccc;padding:4px">コード</th>' +
          '<th style="text-align:left;border-bottom:1px solid #ccc;padding:4px">科目名</th>' +
          '<th style="text-align:left;border-bottom:1px solid #ccc;padding:4px">税率</th>' +
          '<th style="text-align:left;border-bottom:1px solid #ccc;padding:4px">アプリ表示</th>' +
        '</tr></thead>' +
        '<tbody>' +
        costRows.map(function (cm) {
          const name = cm.name && cm.name !== '' ? cm.name : '（未設定）';
          return '<tr>' +
                 '<td style="padding:3px 4px">' + escapeHtml(String(cm.code)) + '</td>' +
                 '<td style="padding:3px 4px">' + escapeHtml(name) + '</td>' +
                 '<td style="padding:3px 4px">' + (Number(cm.taxRate) || 0) + '%</td>' +
                 '<td style="padding:3px 4px">' + (cm.smartphoneVisible ? '✅ 表示' : '—') + '</td>' +
                 '</tr>';
        }).join('') +
        '</tbody>' +
      '</table>';
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
      section('Step 3：マスタ件数枠＋販管費設定', 3, [
        ['サービスマスタ枠数', s3.serviceMasterQuota + ' 件'],
        ['仕入マスタ枠数', s3.purchaseMasterQuota + ' 件'],
        ['販管費マスタ任意枠', '5件固定（税務署様式準拠・編集不可）'],
        ['販管費マスタ', '青色申告デフォルト 24件 / 任意枠使用 ' + customCostCount + ' 件 / アプリ表示 ' + visibleCount + ' 件'],
        ['販管費マスタ詳細', costTableHtml, 'html']
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
  // 7-D：gas ステップは手動デプロイ補助型のため特殊扱い（STEP6_MANUAL に分離）
  const STEP7_STAGES = [
    { id: 'clientId',     label: '1. clientId 発行' },
    { id: 'repo',         label: '2. GitHubリポジトリ生成' },
    { id: 'assets',       label: '3. ロゴ・アイコン アップロード' },
    { id: 'repoFiles',    label: '4. manifest / theme.css / app.js 書込' },
    { id: 'spreadsheet',  label: '5. ユーザーSS 生成・settings 初期化' },
    { id: 'gas',          label: '6. ユーザーGAS デプロイ（運営担当の手動操作）' },
    { id: 'client',       label: '7. clients/auth/change_log 投入' }
  ];
  // 注：納品カードPDF は登録処理（Step7）から分離した（04_運営ポータル.md §9）。
  //   「登録」と「納品物生成」は別概念であり、納品カード生成の失敗で登録全体を
  //   中断させない。納品カードは登録完了後に best-effort で試行し、失敗しても
  //   登録成功は揺るがない。dashboard / 完了画面から何度でも再発行できる。

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
      // gas 行（Step 6）は手動運用パネル展開用の余白を持つため `progress-row-gas` クラス付加
      const extraCls = (s.id === 'gas') ? ' progress-row-gas' : '';
      return (
        '<div class="progress-row progress-pending' + extraCls + '" data-step-id="' + s.id + '">' +
          '<span class="progress-icon">○</span>' +
          '<span class="progress-label">' + escapeHtml(s.label) + '</span>' +
          '<span class="progress-detail"></span>' +
          (s.id === 'gas'
            ? '<div class="manual-gas-panel" id="manual-gas-panel" hidden></div>'
            : ''
          ) +
        '</div>'
      );
    }).join('');
  }

  // ============================================================
  // 7-D：Step 6 手動運用パネル（ハイブリッド方式）
  //   Step 5 完了後に展開され、運営担当が約2分の手動操作を行う：
  //     1. 「コード一式をコピー」→ クリップボードへ
  //     2. 「Apps Script エディタを開く」→ 別タブで script.google.com/home
  //     3. 新規プロジェクト作成・コード貼付・保存・デプロイ→URL取得
  //     4. URL を入力欄にペースト → 「URL登録」ボタン
  //     5. registerUserGasUrl で疎通テスト → 成功なら Step 4/7/8 自動継続
  // ============================================================

  // 手動運用パネルの状態
  const ManualGasState = {
    waiting: false,        // URL 入力待ちか
    onUrlConfirmed: null,  // URL 確定時に呼ぶコールバック（Promise resolver）
    gasCode: '',           // prepareUserGasCode で取得した完成コード
    projectTitle: ''       // Apps Script プロジェクト名（= clientId）
  };

  function buildManualGasPanelHtml(prepResult) {
    const editorUrl = (prepResult.manualSteps && prepResult.manualSteps.editorUrl)
      ? prepResult.manualSteps.editorUrl
      : 'https://script.google.com/home';
    const projectTitle = escapeHtml(prepResult.projectTitle || '');

    return (
      '<div class="manual-gas-box">' +
        '<p class="manual-gas-intro">' +
          '<strong>運営担当タスク：</strong>以下の手順でユーザーGAS を作成してください（所要 約2分）。' +
        '</p>' +
        '<ol class="manual-gas-steps">' +
          '<li class="manual-gas-step">' +
            '<div class="manual-gas-step-title">① Apps Script エディタを別タブで開く</div>' +
            '<a class="btn-secondary manual-gas-btn" href="' + escapeHtml(editorUrl) + '" target="_blank" rel="noopener">' +
              '🔗 Apps Script エディタを開く' +
            '</a>' +
          '</li>' +
          '<li class="manual-gas-step">' +
            '<div class="manual-gas-step-title">② 新しいプロジェクトを作成</div>' +
            '<p class="manual-gas-note">' +
              '左上「<strong>+ 新しいプロジェクト</strong>」をクリック。<br>' +
              '左上のタイトル「無題のプロジェクト」をクリックし、以下に変更：' +
            '</p>' +
            '<div class="manual-gas-copyable">' +
              '<code id="manual-gas-title">' + projectTitle + '</code>' +
              '<button type="button" class="btn-tiny" id="manual-gas-title-copy-btn">コピー</button>' +
            '</div>' +
          '</li>' +
          '<li class="manual-gas-step">' +
            '<div class="manual-gas-step-title">③ コードをコピー</div>' +
            '<button type="button" class="btn-primary manual-gas-btn" id="manual-gas-copy-btn">' +
              '📋 コード一式をコピー' +
            '</button>' +
          '</li>' +
          '<li class="manual-gas-step">' +
            '<div class="manual-gas-step-title">④ コードを貼り付けて保存</div>' +
            '<p class="manual-gas-note">' +
              'コード.gs エディタ内をクリック → <code>Ctrl+A</code> で全選択 → <code>Delete</code> → <code>Ctrl+V</code> でペースト → <code>Ctrl+S</code> で保存' +
            '</p>' +
          '</li>' +
          '<li class="manual-gas-step">' +
            '<div class="manual-gas-step-title">⑤ ウェブアプリとしてデプロイ</div>' +
            '<p class="manual-gas-note">' +
              '右上「<strong>デプロイ</strong>」→「<strong>新しいデプロイ</strong>」→ 歯車⚙ →「<strong>ウェブアプリ</strong>」を選択。<br>' +
              '「次のユーザーとして実行：<strong>自分</strong>」「アクセスできるユーザー：<strong>全員</strong>」を確認し、「<strong>デプロイ</strong>」を押下。<br>' +
              '初回は承認ダイアログ → 詳細 →「安全ではないページに移動」→ 許可。' +
            '</p>' +
          '</li>' +
          '<li class="manual-gas-step">' +
            '<div class="manual-gas-step-title">⑥ ウェブアプリURL を貼り付けて登録</div>' +
            '<p class="manual-gas-note">' +
              'デプロイ完了画面に表示された「ウェブアプリ URL」（<code>https://script.google.com/macros/s/.../exec</code>）をコピーして下に貼付：' +
            '</p>' +
            '<div class="manual-gas-url-form">' +
              '<input type="text" id="manual-gas-url-input" class="manual-gas-url-input" ' +
                'placeholder="https://script.google.com/macros/s/AKfycb.../exec">' +
              '<button type="button" class="btn-primary" id="manual-gas-submit-btn">URL登録</button>' +
            '</div>' +
            '<p class="manual-gas-error" id="manual-gas-error" hidden></p>' +
          '</li>' +
        '</ol>' +
      '</div>'
    );
  }

  // クリップボードコピー（execCommand フォールバック付き）
  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; })
        .catch(function () { return copyToClipboardFallback(text); });
    }
    return Promise.resolve(copyToClipboardFallback(text));
  }
  function copyToClipboardFallback(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.setAttribute('readonly', '');
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  // 手動運用パネルのイベントバインド
  function bindManualGasPanelEvents() {
    const copyBtn = document.getElementById('manual-gas-copy-btn');
    const titleCopyBtn = document.getElementById('manual-gas-title-copy-btn');
    const submitBtn = document.getElementById('manual-gas-submit-btn');
    const urlInput = document.getElementById('manual-gas-url-input');
    const errorEl = document.getElementById('manual-gas-error');

    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        copyToClipboard(ManualGasState.gasCode).then(function (ok) {
          if (ok) {
            showToast('コードをクリップボードにコピーしました', 'success');
          } else {
            showToast('コピーに失敗しました。手動で選択してください', 'error');
          }
        });
      });
    }
    if (titleCopyBtn) {
      titleCopyBtn.addEventListener('click', function () {
        copyToClipboard(ManualGasState.projectTitle).then(function (ok) {
          if (ok) showToast('プロジェクト名をコピーしました', 'success');
        });
      });
    }
    if (submitBtn) {
      submitBtn.addEventListener('click', function () {
        const url = urlInput ? String(urlInput.value || '').trim() : '';
        if (!url) {
          if (errorEl) {
            errorEl.textContent = 'URL を入力してください。';
            errorEl.hidden = false;
          }
          return;
        }
        if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec(\?.*)?$/.test(url)) {
          if (errorEl) {
            errorEl.textContent = 'URL の形式が正しくありません。https://script.google.com/macros/s/.../exec の形式で入力してください。';
            errorEl.hidden = false;
          }
          return;
        }
        if (errorEl) errorEl.hidden = true;
        submitBtn.disabled = true;
        if (urlInput) urlInput.disabled = true;
        if (typeof ManualGasState.onUrlConfirmed === 'function') {
          ManualGasState.onUrlConfirmed(url);
        }
      });
    }
  }

  // Step 6 の手動運用パネルを開き、ユーザーが URL を確定するまで待つ
  // Promise<string> を返す（resolve 値が運営担当が入力した gasUrl）
  function waitForManualGasUrl(prepResult) {
    return new Promise(function (resolve) {
      ManualGasState.waiting = true;
      ManualGasState.gasCode = prepResult.gasCode || '';
      ManualGasState.projectTitle = prepResult.projectTitle || '';

      const panel = document.getElementById('manual-gas-panel');
      if (!panel) {
        // フェイルセーフ：パネルが見当たらない場合はエラー
        ManualGasState.waiting = false;
        throw new Error('manual-gas-panel 要素が見つかりません');
      }
      panel.innerHTML = buildManualGasPanelHtml(prepResult);
      panel.hidden = false;
      bindManualGasPanelEvents();

      ManualGasState.onUrlConfirmed = function (url) {
        ManualGasState.waiting = false;
        ManualGasState.onUrlConfirmed = null;
        resolve(url);
      };

      // パネル位置にスクロール
      try {
        const gasRow = document.querySelector('[data-step-id="gas"]');
        if (gasRow && gasRow.scrollIntoView) {
          gasRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      } catch (_e) { /* ignore */ }
    });
  }

  // 手動運用パネルをクローズ（成功時）
  function closeManualGasPanel() {
    const panel = document.getElementById('manual-gas-panel');
    if (panel) panel.hidden = true;
  }

  // URL 検証失敗時に手動運用パネルへエラー表示し、再入力を促す
  function showManualGasErrorAndRetry(errorMessage) {
    const errorEl = document.getElementById('manual-gas-error');
    const submitBtn = document.getElementById('manual-gas-submit-btn');
    const urlInput = document.getElementById('manual-gas-url-input');
    if (errorEl) {
      errorEl.textContent = errorMessage;
      errorEl.hidden = false;
    }
    if (submitBtn) submitBtn.disabled = false;
    if (urlInput) urlInput.disabled = false;
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
              '<p class="completion-note">📄 納品カードPDFは後から発行できます（ダッシュボードの各店舗から再発行可）。' +
              (Step7Progress.deliveryCardError ? '<br><span class="completion-warn">生成エラー：' + escapeHtml(Step7Progress.deliveryCardError) + '</span>' : '') +
              '</p>' +
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

      // ---- 3. uploadUserAsset × 6（選択時のみ）----
      step7SetStatus('assets', 'running', 'アップロード中...');
      const assets = [
        { type: 'store-logo',        file: s4.logoFile,        label: 'ロゴ'           },
        { type: 'icon-192',          file: s4.icon192File,     label: 'アイコン192'    },
        { type: 'icon-512',          file: s4.icon512File,     label: 'アイコン512'    },
        { type: 'icon-192-maskable', file: s4.icon192maskFile, label: 'マスカブル192'  },
        { type: 'icon-512-maskable', file: s4.icon512maskFile, label: 'マスカブル512'  },
        { type: 'apple-touch-icon',  file: s4.appletouchFile,  label: 'AppleTouch'     }
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

      // ---- 6. ユーザーGAS デプロイ（7-D ハイブリッド方式・手動操作） ----
      //   6-a〜6-c：マスタGAS が prepareUserGasCode でテンプレGASコードに
      //            SPREADSHEET_ID を差し込んで返却
      //   6-d〜6-g：運営担当が Apps Script エディタで約2分の手動操作
      //            （新規プロジェクト・コード貼付・デプロイ・URL取得）
      //   6-h〜6-i：URL を運営ポータルに貼付 → registerUserGasUrl で疎通テスト
      step7SetStatus('gas', 'running', '運営担当の手動操作を待機中...');
      const r6prep = await callGasAction('prepareUserGasCode', {
        clientId:      Step7Progress.clientId,
        spreadsheetId: Step7Progress.spreadsheetId
      });
      // 手動運用パネルを展開し、運営担当が URL を確定するまで待つ
      let manualGasUrl = '';
      let urlValidated = false;
      while (!urlValidated) {
        manualGasUrl = await waitForManualGasUrl(r6prep);
        // 疎通テスト（registerUserGasUrl）
        let pingRes;
        try {
          pingRes = await window.uzAdmin.callMasterGas('registerUserGasUrl', {
            clientId: Step7Progress.clientId,
            gasUrl:   manualGasUrl
          });
        } catch (pingErr) {
          showManualGasErrorAndRetry('疎通テストの呼出でエラー：' + String(pingErr.message || pingErr));
          continue;
        }
        if (window.uzAdmin.handleAuthError && window.uzAdmin.handleAuthError(pingRes)) {
          throw new Error('セッション失効');
        }
        if (!pingRes || pingRes.ok !== true) {
          const msg = (pingRes && (pingRes.message || pingRes.code))
            ? pingRes.message || pingRes.code
            : 'URL の疎通テストに失敗しました';
          showManualGasErrorAndRetry('疎通テスト失敗：' + msg + '。URL を再確認してください。');
          continue;
        }
        // 検証成功
        urlValidated = true;
      }
      Step7Progress.gasUrl = manualGasUrl;
      closeManualGasPanel();
      step7SetStatus('gas', 'done', '手動デプロイ＋疎通確認 完了');

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
          contractorName:      s1.contractorName,
          representativeName:  s1.representativeName,
          address:             s1.address,
          phone:               s1.phone,
          email:               s1.email,
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

      // ---- 登録はここで成功確定（納品カードは登録工程に含めない）----
      Step7Progress.completed = true;
      Step7Progress.running = false;

      // ---- 納品カード PDF（best-effort・登録成功とは独立）----
      //   生成に失敗しても登録成功は揺るがない。完了画面のボタン／dashboard から
      //   後から何度でも再発行できる（04_運営ポータル.md §9）。
      try {
        const r8 = await callGasAction('generateDeliveryCard', {
          clientId:   Step7Progress.clientId,
          displayPin: s5.pin
        });
        Step7Progress.deliveryCardBase64 = String(r8.pdfBase64 || '');
      } catch (cardErr) {
        Step7Progress.deliveryCardBase64 = '';
        Step7Progress.deliveryCardError = String((cardErr && cardErr.message) || cardErr);
      }

      // ---- 完了表示 ----
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
        '・GitHubリポジトリ生成（自動）\n' +
        '・Googleスプレッドシート生成（自動）\n' +
        '・ユーザーGAS 作成（手動操作 約2分・運営担当）\n' +
        '・clients / auth / change_log 投入（自動）\n' +
        '・納品カードPDF 生成（自動）\n\n' +
        'を順次実行します。所要時間 約3〜5分。よろしいですか？'
      );
      if (!okToProceed) return;
      executeStep7();
    });

    // ステッパー円クリック
    document.querySelectorAll('.step-item').forEach(function (li) {
      li.addEventListener('click', function () {
        // Step7 実行開始後・完了後はステッパー移動を禁止（処理破壊防止）
        if (Step7Progress.running || Step7Progress.completed) return;
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

    // Step 1：営業時間の翌日跨ぎ自動判定バッジ更新
    $('f1-business-open').addEventListener('change', updateNextDayBadge);
    $('f1-business-close').addEventListener('change', updateNextDayBadge);

    // Step 2：ラジオ変更でグレード更新
    document.querySelectorAll('input[name="f2-timecard"]').forEach(function (r) {
      r.addEventListener('change', updateGradeDerivation);
    });

    // Step 3：販管費マスタテーブルのイベント委譲（税率・名称・アプリ表示）
    const cmBody = $('register-cost-tbody');
    if (cmBody) {
      cmBody.addEventListener('input', function (e) {
        if (e.target.dataset.cmIdx !== undefined) syncCostTableToState();
      });
      cmBody.addEventListener('change', function (e) {
        if (e.target.dataset.cmIdx !== undefined) syncCostTableToState();
      });
    }

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
    $('btn-pick-icon-192-maskable').addEventListener('click', function () {
      pickFile('f4-icon192mask-file', { field: 'icon192maskFile', previewId: 'preview-icon-192-maskable', filenameId: 'f4-icon192mask-filename' });
    });
    $('btn-pick-icon-512-maskable').addEventListener('click', function () {
      pickFile('f4-icon512mask-file', { field: 'icon512maskFile', previewId: 'preview-icon-512-maskable', filenameId: 'f4-icon512mask-filename' });
    });
    $('btn-pick-apple-touch-icon').addEventListener('click', function () {
      pickFile('f4-appletouch-file', { field: 'appletouchFile', previewId: 'preview-apple-touch-icon', filenameId: 'f4-appletouch-filename' });
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
