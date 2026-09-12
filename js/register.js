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
        // 2026-08-28：発行モード（'new'=新規発行／'update'=アップデート発行＝既存SS紐付け）
        // update時は Step2 の reuseSpreadsheetId 必須化＋Step7で reuse 分岐が発火する。
        issueMode: 'new',
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
        monthlyFee: 4980,
        clientCode: '',
        // v0.13.0（2026-09-08）：顧客要望メモ（update mode 必須・→ 00_原則.md §4-6-2 ②）
        requestedBy: ''
      },
      // v0.9.14（2026-09-04）：nextGenClientId・readinessOk を追加。
      //   nextGenClientId = validateReuseSource が返す自動採番 clientId（例：uz-osafune-2）
      //   readinessOk = 3層 preflight（ss_ok+gas_ok+authorized）が全 true か
      //   readinessDetail = readiness UI レンダリング用の生 result（{ss_ok, gas_ok, authorized, ...}）
      step2: { timecardCount: 5, qrProofEnabled: false, shiftScheduleEnabled: false, reuseSpreadsheetId: '', reuseClientId: '', reuseStoreName: '', nextGenClientId: '', readinessOk: false, readinessDetail: null },
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
        costMasterList: [],
        // 大分類マスタ（2026-08-27・→ 03§1-1-2 / §1-3-2・任意設定）
        serviceChannelList: [],
        purchaseCategoryList: []
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
    // 契約開始は手動入力。既定は「翌月1日」（当月途中契約の起算を翌月頭に揃える運用）。
    const today = new Date();
    const nextMonth1 = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const startIso = isoDate(nextMonth1);
    $('f1-contract-start').value = startIso;
    RegisterState.data.step1.contractStart = startIso;
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
      // v0.12.0（2026-09-07）：#update-mode-authorize-notice は常時非表示に強制。
      //   v0.9.17 期の ⑤-b editor 手作業案内は v0.10.0 一元 GAS ルーティング化で構造消滅済。
      //   HTML 側の要素は残置（表示制御のみで塞ぐ・削除は別セッションで整理）。
      var authNotice = $('update-mode-authorize-notice');
      if (authNotice) authNotice.hidden = true;
    }
    renderStepper();
    // 上部にスクロール
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ============ Step 別読込（state → form） ============
  // 主に state.dataの内容を form input に反映する（戻る時に値を保持）
  function paintStep1() {
    const s = RegisterState.data.step1;
    // 発行モードラジオ復元（state → form）
    const mode = s.issueMode || 'new';
    document.querySelectorAll('input[name="f1-issue-mode"]').forEach(function (r) {
      r.checked = (r.value === mode);
    });
    updateIssueModeVisibility();
    $('f1-contractor-name').value = s.contractorName;
    $('f1-representative-name').value = s.representativeName;
    $('f1-address').value = s.address;
    $('f1-phone').value = s.phone;
    $('f1-email').value = s.email;
    $('f1-store-name').value = s.storeName;
    $('f1-client-code').value = s.clientCode || '';
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
    const qr = $('f2-qr-proof'); if (qr) qr.checked = !!RegisterState.data.step2.qrProofEnabled;
    const sh = $('f2-shift-schedule'); if (sh) sh.checked = !!RegisterState.data.step2.shiftScheduleEnabled;
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
  //   2026-08-30：発行モードで分岐。update=基本情報は Step 2 で選ぶ更新元から自動引継ぎのため
  //   Step 1 では入力・検証不要（発行モード＋店舗コード＋任意「変更後の店名」のみ）。
  //   店舗コード＝命名規則07 の根治で新規/アプデ両方で必須（ランダムハッシュ発番の廃止）。
  function readStep1AndValidate() {
    const s = RegisterState.data.step1;
    // 発行モード（新規/アップデート）
    const modeEl = document.querySelector('input[name="f1-issue-mode"]:checked');
    s.issueMode = modeEl ? String(modeEl.value) : 'new';

    // 店舗コード（新規/アプデ共通・必須）＝命名規則07 の根治
    s.clientCode = $('f1-client-code').value.trim().toLowerCase();
    const clientCodeErrors = [];
    if (!s.clientCode) {
      clientCodeErrors.push('店舗コード（意味のある可読名を必ず入力・例：osafune・aiyouhouen・kana01）');
    } else {
      var cc = s.clientCode.indexOf('uz-') === 0 ? s.clientCode.slice(3) : s.clientCode;
      if (cc.length < 2 || cc.length > 20 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(cc)) {
        clientCodeErrors.push('店舗コード（半角英数字と - ・2〜20字）');
      }
    }

    // 発行モード＝アップデート（v0.13.0 体制構築 4 層・2026-09-08）：③発行 = 新 clientId
    //   発行＋列マップ転記（対応列のみ・新テンプレの列拡張を保持）＋新テンプレ注入＋旧 deprecated 化
    //   ＋ 顧客要望メモ記録。→ 00_原則.md §4-6-3。update モードでも clientCode（新 clientId 用の
    //   raw code）は必須＝ 新規と同じ検証を通す。基本情報（contractorName/address/etc）は Step 2 で
    //   更新元 clients 行から流し込むため入力不要。updateStoreName（旧 v0.11.0）は撤廃＝ 旧 SS の
    //   settings key/value が新 SS へ照合転記され店名は旧のまま持ち込まれる（変更は ③発行後 updateClient）。
    if (s.issueMode === 'update') {
      s.updateStoreName = '';  // v0.13.0：撤廃・後方互換のため空セット
      // v0.13.1（2026-09-09）：顧客要望メモは任意化・空でも通す（記入時は change_log 記録）
      const reqEl = $('f1-requested-by');
      s.requestedBy = reqEl ? String(reqEl.value || '').trim() : '';
      // v0.13.1：update mode では clientCode を Step 2 の reuseClientId から base 自動継承
      //   （Step 7 の generateClientId 呼出時に抽出・`uz-osafune-a3f7` → base=`osafune`）＝
      //   Step 1 での clientCode 入力は不要＝ clientCodeErrors（未入力エラー）を無視。
      s.clientCode = '';  // update mode では空（Step 7 で自動継承）
      hideStepError('step1-error');
      return true;
    }
    // 発行モード＝新規：requestedBy は空でよい（改修対象＝ 実顧客資産のみ・→ 00 §4-6-2 ①）
    s.requestedBy = '';
    // 新規発行では clientCode は必須（下流 L464 の [].concat(clientCodeErrors) で errors 集約 check）

    // 発行モード＝新規：従来通り全項目入力＋検証
    s.updateStoreName = '';
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

    const errors = [].concat(clientCodeErrors);
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
    // 段2/段3トグル（アストラ=TC0 では強制OFF）
    const isLeo = RegisterState.data.step2.timecardCount >= 5;
    const qr = $('f2-qr-proof'), sh = $('f2-shift-schedule');
    RegisterState.data.step2.qrProofEnabled       = isLeo && !!(qr && qr.checked);
    RegisterState.data.step2.shiftScheduleEnabled = isLeo && !!(sh && sh.checked);
    // 既存SS 再利用モード（2026-08-29：dropdown 単独運用へ整理）
    // 発行モード=update のとき、dropdown で選択された既存店の sheetId＋店名＋clientId を state へ。
    // Step 6 確認画面で「更新元：カナミツ事務所（uz-kanamitsu01）」と店名を並記して視認できるようにする。
    // 2026-08-30：加えて、選択された既存店の基本情報（契約者名・住所・電話・メール・営業時間・契約情報）を
    //   Step 1 state に流し込み＝Step 1 入力欄を省略できる。名簿 clients 行が真実の所在地。
    const isUpdateMode = RegisterState.data.step1.issueMode === 'update';
    if (isUpdateMode) {
      const select = $('f2-reuse-select');
      const opt = select ? select.options[select.selectedIndex] : null;
      const ssid = (opt && opt.dataset && opt.dataset.ssid) ? String(opt.dataset.ssid).trim() : '';
      if (!ssid) {
        showStepError('step2-error', 'アップデート発行モードでは「更新元の既存店」の選択が必須です');
        return false;
      }
      // v0.9.14（2026-09-04）：3層 preflight（validateReuseSource）が全通過しているかを確認。
      //   readinessOk=false のまま「次へ」を押すと出来損ない PWA を更新元にした事故が起きる＝弾く。
      if (!RegisterState.data.step2.readinessOk) {
        showStepError('step2-error', '更新元の前提検証（SS 実体・GAS 疎通・認可）が未通過です。上部の readiness 表示を確認し、全て ✅ になるまで進めません。');
        return false;
      }
      // v0.11.0（2026-09-06・自動採番廃止）：clientCode は Step 1 で運営が手動命名する。
      //   Step 2 では nextGenClientId を流し込まない（識別性の要件・金光判断 2026-09-06）。
      //   最終 clientId は master GAS 側 _finalizeNewClientId_ が 'uz-<code>-<4桁ランダム>' を確定。
      //   Step 1 で clientCode が未入力の場合は Step 1 バリデーションで既に弾かれている。
      RegisterState.data.step2.reuseSpreadsheetId = ssid;
      // 選択された option の value=clientId・text=「店名（clientId）」から店名を抽出
      RegisterState.data.step2.reuseClientId = String((opt && opt.value) || '').trim();
      const label = String((opt && opt.textContent) || '').trim();
      const m = label.match(/^(.*?)（[^）]*）$/);
      const parsedStoreName = m ? m[1] : label;
      RegisterState.data.step2.reuseStoreName = parsedStoreName;
      // 2026-08-30：更新元の完全な client 行を _reuseClientsCache から引いて Step 1 state に流し込む。
      //   これで Step 7 の writeUserRepositoryFiles / registerNewClient が更新元の値を継承する。
      const src = (Array.isArray(_reuseClientsCache) ? _reuseClientsCache : [])
        .find(function (c) { return c && String(c.clientId || '') === RegisterState.data.step2.reuseClientId; });
      const s1 = RegisterState.data.step1;
      const updStoreName = String(s1.updateStoreName || '').trim();
      // 店名：ユーザーが「変更後の店名」を入力していればそれ、なければ更新元の店名。
      s1.storeName = updStoreName || parsedStoreName || (src ? String(src.storeName || '') : '');
      if (src) {
        // 契約者・代表者・住所・連絡先・営業時間・契約情報＝更新元の値をそのまま継承
        s1.contractorName = String(src.contractorName || s1.contractorName || '');
        s1.representativeName = String(src.representativeName || s1.representativeName || '');
        s1.address = String(src.address || s1.address || '');
        s1.phone = String(src.phone || s1.phone || '');
        s1.email = String(src.email || s1.email || '');
        if (src.businessHours && typeof src.businessHours === 'object') {
          s1.businessHours = {
            open: String(src.businessHours.open || s1.businessHours.open),
            close: String(src.businessHours.close || s1.businessHours.close),
            closeNextDay: !!src.businessHours.closeNextDay
          };
        }
        s1.contractStart = String(src.contractStart || s1.contractStart || '');
        s1.contractEnd = String(src.contractEnd || s1.contractEnd || '');
        s1.monthlyFee = parseInt(String(src.monthlyFee || s1.monthlyFee || 0), 10) || 0;
      }
    } else {
      RegisterState.data.step2.reuseSpreadsheetId = '';
      RegisterState.data.step2.reuseClientId = '';
      RegisterState.data.step2.reuseStoreName = '';
    }
    hideStepError('step2-error');
    return true;
  }

  function readStep3AndValidate() {
    // 2026-08-30 金光指示：アプデ発行時は更新元の枠数・大分類・販管費マスタをそのまま引き継ぐ
    //   ため Step 3 の入力・検証はスキップ（_reuseSsMigrateNewMasters_ が既存値を尊重するので、
    //   state に残っている既定値を渡しても既存店の値が上書きされない構造で担保済み）。
    if (RegisterState.data.step1.issueMode === 'update') {
      hideStepError('step3-error');
      return true;
    }
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
    // 大分類マスタを textarea から state へ（2026-08-27・任意設定・空配列で無害運転）
    const scEl = $('f3-service-channel-list');
    if (scEl) {
      s3.serviceChannelList = String(scEl.value || '').split(/\r?\n/)
        .map(function (line) {
          const parts = line.split(',').map(function (x) { return String(x).trim(); });
          if (!parts[0]) return null;
          const rate = parseInt(parts[1], 10);
          return {
            id: '', // サーバ側で sc001〜採番（createUserSpreadsheet は配列をそのまま入れるだけ・追番は運用開始後）
            name: parts[0],
            taxRate: [0, 8, 10].indexOf(rate) >= 0 ? rate : 10
          };
        })
        .filter(function (x) { return !!x; })
        .map(function (it, i) { it.id = 'sc' + ('000' + (i + 1)).slice(-3); return it; });
    }
    const pcEl = $('f3-purchase-category-list');
    if (pcEl) {
      s3.purchaseCategoryList = String(pcEl.value || '').split(/\r?\n/)
        .map(function (line) { return String(line).trim(); })
        .filter(function (x) { return !!x; })
        .map(function (name, i) { return { id: 'pc' + ('000' + (i + 1)).slice(-3), name: name }; });
    }
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
  // 2026-08-28：Step1発行モード連動＝Step2「既存SS 紐付け」パネルの表示制御
  //   update：パネル表示＋必須／new：パネル非表示＋入力値クリア＝埋め忘れ・誤埋めを構造で防ぐ
  // 2026-08-30：加えて Step1 の基本情報ブロック（f1-basic-info-block）の表示切替＋
  //   アップデート時のみ「変更後の店名」欄（f1-update-storename-row）を表示。
  //   アプデ時は基本情報を Step 2 で選ぶ更新元から自動引継ぎ＝入力欄は非表示・任意で店名だけ上書き可。
  function updateIssueModeVisibility() {
    const modeEl = document.querySelector('input[name="f1-issue-mode"]:checked');
    const mode = modeEl ? String(modeEl.value) : 'new';
    const panel = $('f2-reuse-panel');
    const select = $('f2-reuse-select');
    if (panel) panel.hidden = (mode !== 'update');
    if (mode !== 'update' && select) select.value = '';
    RegisterState.data.step1.issueMode = mode;
    // Step1 基本情報ブロックの表示切替（アプデ時は Step 2 で更新元から流し込むため非表示）
    const basicBlock = $('f1-basic-info-block');
    if (basicBlock) basicBlock.hidden = (mode === 'update');
    // v0.13.0（2026-09-08・体制構築 4 層＋技術動作 5 段）：撤廃された UI 要素は常時非表示に据える。
    //   - #f1-update-storename-row（v0.11.0 「変更後の店名」欄）：列マップ転記で settings が
    //     key/value 照合により旧のまま持ち込まれる＝ 変更は ③発行後 updateClient で対応。
    //   - #f1-client-code-auto-preview（v0.9.14 -N 自動採番プレビュー）：clientCode は
    //     新規/アプデ共通で手入力＋4桁ランダム自動付加（_finalizeNewClientId_）。
    //   - #update-mode-authorize-notice（v0.9.17 ⑤-b editor 手作業案内）：v0.10.0 で一元
    //     GAS ルーティング化＝ 手作業消滅・案内不要（後述 paintStep6 でも常時非表示に強制）。
    const updateStoreNameRow = $('f1-update-storename-row');
    if (updateStoreNameRow) updateStoreNameRow.hidden = true;
    // v0.13.0：顧客要望メモ欄（f1-requested-by-row）は update mode のみ表示・required
    //   → 00_原則.md §4-6-2 ② アプデ発行の発火根拠。change_log 永続記録用。
    const requestedByRow = $('f1-requested-by-row');
    if (requestedByRow) requestedByRow.hidden = (mode !== 'update');
    // 店舗コード欄は新規/アプデ共通で表示＋必須（v0.13.0 体制構築 4 層）
    //   新規発行/アプデ発行 両モードで master GAS が 'uz-<code>-<4桁ランダム>' を確定する。
    // v0.13.1（2026-09-09）：update mode では clientCode を Step 2 の reuseClientId から
    //   base 自動継承（Step 7 の generateClientId で抽出）＝ Step 1 の clientCode 入力欄は隠す。
    //   新規発行時のみ clientCode 手入力（意味のある可読名）を要求する。
    const clientCodeRow = $('f1-client-code-row');
    const clientCodeAutoPreview = $('f1-client-code-auto-preview');
    if (clientCodeRow) clientCodeRow.hidden = (mode === 'update');
    if (clientCodeAutoPreview) clientCodeAutoPreview.hidden = true;
    // アプデから新規へ戻したら readiness を初期化
    if (mode !== 'update') {
      const rd = $('f2-reuse-readiness');
      if (rd) rd.hidden = true;
      RegisterState.data.step2.nextGenClientId = '';
      RegisterState.data.step2.readinessOk = false;
      RegisterState.data.step2.readinessDetail = null;
    }
    // Step3 の切替：アプデ時は「更新元から自動引継ぎ」の1行notice のみ表示、本体は非表示
    //   （2026-08-30 金光指示＝運用者の枠数設定を上書きしない）
    const f3New = $('f3-new-content');
    const f3UpdNotice = $('f3-update-notice');
    const f3HelpNew = $('f3-help-new');
    if (f3New) f3New.hidden = (mode === 'update');
    if (f3UpdNotice) f3UpdNotice.hidden = (mode !== 'update');
    if (f3HelpNew) f3HelpNew.hidden = (mode === 'update');
    // 2026-08-29：アップデート発行選択時に既存店 dropdown を populate（唯一の入力手段）
    if (mode === 'update') { populateReuseSelect(); }
  }

  // v0.9.14（2026-09-04）：更新元選択時に validateReuseSource を呼び 3層 preflight 検証。
  //   結果を state.step2 に格納＋readiness UI を描画＋Step 1 のプレビュー欄を更新する。
  //   ここで readinessOk=false のまま Step 2「次へ」を押すと readStep2AndValidate で弾かれる。
  async function validateAndRenderReuseSource(clientId) {
    const readiness = $('f2-reuse-readiness');
    const body = $('f2-reuse-readiness-body');
    const previewVal = $('f1-client-code-auto-value');
    if (!readiness || !body) return;
    // 選択解除時（value=''）は readiness 非表示＋プレビュー初期化
    if (!clientId) {
      readiness.hidden = true;
      RegisterState.data.step2.nextGenClientId = '';
      RegisterState.data.step2.readinessOk = false;
      RegisterState.data.step2.readinessDetail = null;
      if (previewVal) previewVal.innerHTML = '<span style="color:#888;">Step 2 で「更新元の既存店」を選択すると自動生成されます</span>';
      return;
    }
    // 検証中表示
    readiness.hidden = false;
    readiness.style.background = '#f6f8fc';
    readiness.style.border = '1px solid #d9dee8';
    body.innerHTML = '<span style="color:#556;">更新元の前提を検証中… (SS 実体・GAS 疎通・認可 の3層)</span>';
    if (previewVal) previewVal.innerHTML = '<span style="color:#888;">検証中…</span>';
    try {
      const res = await window.uzAdmin.callMasterGas('validateReuseSource', { reuseClientId: clientId });
      RegisterState.data.step2.readinessDetail = res;
      const ssOk = !!(res && res.ss_ok);
      const gasOk = !!(res && res.gas_ok);
      const authOk = !!(res && res.authorized);
      const allOk = !!(res && res.ok);
      RegisterState.data.step2.readinessOk = allOk;
      RegisterState.data.step2.nextGenClientId = String((res && res.nextGenClientId) || '');
      // 見た目：全 ✅ なら緑・欠陥ありなら赤・部分成功で auth のみ NG は黄色
      if (allOk) {
        readiness.style.background = '#eaf6ec';
        readiness.style.border = '1px solid #4caf50';
      } else if (ssOk && gasOk && !authOk) {
        readiness.style.background = '#fff8ec';
        readiness.style.border = '1px solid #b8860b';
      } else {
        readiness.style.background = '#fdecea';
        readiness.style.border = '1px solid #d93025';
      }
      const rows = [];
      const mark = (ok) => ok ? '<span style="color:#2e7d32;font-weight:700;">✅</span>' : '<span style="color:#c62828;font-weight:700;">❌</span>';
      rows.push('<div>' + mark(ssOk) + ' <b>SS 実体</b>：' + (ssOk ? '取得成功' : escapeHtml(String(res.ss_error || '不明'))) + '</div>');
      rows.push('<div>' + mark(gasOk) + ' <b>GAS 疎通</b>：' + (gasOk ? '応答あり' : escapeHtml(String(res.gas_error || '不明'))) + '</div>');
      rows.push('<div>' + mark(authOk) + ' <b>認可</b>：' + (authOk ? 'consent 完了' : escapeHtml(String(res.auth_error || '不明'))) + '</div>');
      // Layer 3 のみ NG の場合、authUrl ボタンを inline 提示（v0.9.12 の 1クリック承認）
      if (ssOk && gasOk && !authOk && res.authUrl) {
        rows.push('<div style="margin-top:8px;"><a href="' + escapeHtml(res.authUrl) + '" target="_blank" rel="noopener" style="display:inline-block;padding:6px 14px;background:#f57c00;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:12px;">認可ページを新タブで開く（k@tgx.jp）</a> <span style="color:#665;font-size:11px;">→ 承認後、更新元を再選択して再検証</span></div>');
      }
      // 全 OK 時：自動採番された新clientId を Step 1 プレビューへ反映
      if (allOk && res.nextGenClientId) {
        rows.push('<div style="margin-top:10px;padding-top:8px;border-top:1px dashed #4caf50;font-size:13px;"><b>新clientId（自動採番）</b>：<code style="font-size:14px;color:#0B1842;background:#fff;padding:2px 8px;border-radius:4px;">' + escapeHtml(res.nextGenClientId) + '</code></div>');
        if (previewVal) previewVal.innerHTML = '<code>' + escapeHtml(res.nextGenClientId) + '</code>';
      } else {
        if (previewVal) previewVal.innerHTML = '<span style="color:#c62828;">更新元の前提が未通過のため生成できません</span>';
      }
      body.innerHTML = rows.join('');
    } catch (e) {
      readiness.style.background = '#fdecea';
      readiness.style.border = '1px solid #d93025';
      body.innerHTML = '<span style="color:#c62828;">検証呼び出し失敗: ' + escapeHtml(String(e && e.message || e)) + '</span>';
      RegisterState.data.step2.readinessOk = false;
      RegisterState.data.step2.readinessDetail = null;
      RegisterState.data.step2.nextGenClientId = '';
      if (previewVal) previewVal.innerHTML = '<span style="color:#c62828;">検証エラー</span>';
    }
  }

  // 2026-08-29：既存店 dropdown populate＝listClients で稼働中の店を全部拾って select に流し込む。
  //   dropdown で選ぶと spreadsheetId が自動で入る＝手動貼付の入力事故（¥0 表示の原因）を構造で防ぐ。
  //   fetch は初回のみ。以後は cache から即描画。change イベントで input へ反映。
  let _reuseClientsCache = null;
  async function populateReuseSelect() {
    const select = $('f2-reuse-select');
    if (!select) return;
    if (_reuseClientsCache) { _renderReuseOptions(_reuseClientsCache); return; }
    select.innerHTML = '<option value="">— 既存店を取得中… —</option>';
    try {
      // fetchClientsList は AdminApp 側に公開されている（uzAdmin ではない・app.js L309）。
      const res = await window.AdminApp.fetchClientsList();
      if (!res || res.ok !== true || !Array.isArray(res.clients)) {
        select.innerHTML = '<option value="">— 取得失敗（ページを再読み込みしてください）—</option>';
        return;
      }
      _reuseClientsCache = res.clients;
      _renderReuseOptions(_reuseClientsCache);
    } catch (e) {
      select.innerHTML = '<option value="">— 通信エラー（ページを再読み込みしてください）—</option>';
    }
  }
  function _renderReuseOptions(clients) {
    const select = $('f2-reuse-select');
    if (!select) return;
    // v0.13.3（2026-09-10 hotfix・金光の芯）：候補絞り込みは validateReuseSource に任せる。
    //   populateReuseSelect は管理行（clientId='target' の運営自身の行）のみ除外し、他は全て
    //   候補として表示する。失敗ゴミ PWA を選んだ場合は選択時に validateReuseSource が
    //   SS + GAS の 2 層検証で弾く＝ 症状が構造で起きない実装（§◎ R2 準拠）。事前絞り込み
    //   （contractStatus フィルタ・sheetId フィルタ）は症状対処の継ぎはぎ実装＝ 排除する
    //   （§◎ R7・「〜の事前絞り込み／継ぎはぎ実装」抑制）。アプデ元判定は SS + GAS の
    //   2 成果物のみ＝ 納品カード -card は発行時の付随成果物で判定に無関係。
    //   位置ずれ経緯：v0.13.2 で active のみ→ failed/purged/terminated のみ除外に変更したが、
    //   それも継ぎはぎ（6 度目の位置ずれ）＝ 金光激怒「目先だけ余計物まで拾い継ぎはぎを
    //   繰り返す実装はいい加減止めろ」で本 v0.13.3 で完全に最小化に是正。
    const rows = clients.filter(c => c && c.clientId && c.clientId !== 'target');
    if (rows.length === 0) {
      select.innerHTML = '<option value="">— 既存店がありません（新規発行モードをご利用ください）—</option>';
      return;
    }
    // 登録が新しい順（createdAt 降順）で並べる
    rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    select.innerHTML = '<option value="">— 既存店を選択してください —</option>' +
      rows.map(c => `<option value="${escapeHtml(c.clientId)}" data-ssid="${escapeHtml(c.sheetId)}">${escapeHtml(c.storeName || '')}（${escapeHtml(c.clientId)}）</option>`).join('');
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
    // 段2/段3オプションはレオ（TC≧5）のときのみ表示。アストラではOFF固定で隠す。
    const stageOpts = $('f2-stage-options');
    if (stageOpts) {
      const isLeo = (n >= 5);
      stageOpts.style.display = isLeo ? '' : 'none';
      if (!isLeo) {
        const qr = $('f2-qr-proof'); if (qr) qr.checked = false;
        const sh = $('f2-shift-schedule'); if (sh) sh.checked = false;
      }
    }
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
        ['発行モード', s1.issueMode === 'update' ? 'アップデート発行（顧客要望起点・新 clientId 発行＋列マップ転記＋新テンプレ注入＋旧 deprecated 化・目安 30 日程度で運営判断 trash）' : '新規発行（新規SS作成・一式生成）'],
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
        ['グレード派生', grade],
        ['段2 QR現地証明', (s2.timecardCount >= 5 && s2.qrProofEnabled) ? '✅ ON（qrProofEnabled）' : '— OFF'],
        ['段3 シフト登録', (s2.timecardCount >= 5 && s2.shiftScheduleEnabled) ? '✅ ON（shiftScheduleEnabled）' : '— OFF'],
        // 2026-08-27：アストラのUI改修＝勤怠系メニュー撤廃の初期化結果
        ['勤怠系メニュー（初期化）', s2.timecardCount >= 5 ? '✅ ON（attendance/clockin/payroll 全て true）' : '— OFF（アストラ想定＝勤怠系メニュー撤廃）'],
        // 2026-08-29 UX改修：更新元の店名・clientId を明示（spreadsheetId だけでは何店か視認できない）
        ['SS 方式', s2.reuseSpreadsheetId
          ? ('🔗 既存SS 再利用＝アップデート発行'
              + (s2.reuseStoreName || s2.reuseClientId
                  ? '<br>更新元：<strong>' + escapeHtml(s2.reuseStoreName || '') + '</strong>（' + escapeHtml(s2.reuseClientId || '') + '）'
                  : '')
              + '<br><span style="color:#889;font-size:11px;">spreadsheetId: ' + escapeHtml(s2.reuseSpreadsheetId) + '</span>')
          : '新規SS 作成＝新規発行']
      ]) +
      section('Step 3：マスタ件数枠＋販管費設定', 3, [
        ['サービスマスタ枠数', s3.serviceMasterQuota + ' 件'],
        ['仕入マスタ枠数', s3.purchaseMasterQuota + ' 件'],
        ['販管費マスタ任意枠', '5件固定（税務署様式準拠・編集不可）'],
        // 2026-08-27：大分類マスタ（→ 03§1-1-2 / §1-3-2・任意設定）
        ['サービス販売チャネル大分類', (s3.serviceChannelList || []).length ? (s3.serviceChannelList.map(function (c) { return c.name + '(' + c.taxRate + '%)'; }).join(' / ')) : '未設定（入力モーダルにチャネル選択が出ない＝後方互換）'],
        ['仕入原価大分類', (s3.purchaseCategoryList || []).length ? (s3.purchaseCategoryList.map(function (c) { return c.name; }).join(' / ')) : '未設定（品目マスタで categoryId 紐付けのみ）'],
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
    errorMessage: '',
    reuseSpreadsheetId: ''   // 2026-08-27：既存SS 再利用モード
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
    // v0.13.0：3 成果物セット（-data / -gas.url / -card）の -gas を担保。全 clientId 共通で
    //   master GAS URL を指す .url ショートカット。新規発行・アプデ発行 共通で実行。
    { id: 'gasShortcut',  label: '4.5 -gas.url ショートカット生成（3 成果物セット -gas 担保）' },
    { id: 'spreadsheet',  label: '5. ユーザーSS 生成・settings 初期化' },
    // v0.13.0：アプデ発行時のみ実行。旧 SS の運用データを新 SS へ列マップ転記（対応列のみ・
    //   新のみ列は空欄・旧のみ列は破棄）＝ 新テンプレの列拡張を保持しつつ運用データ承継。
    //   settings は key/value 照合。→ 00_原則.md §4-6-3 Step 3。
    { id: 'migrateData',  label: '5.5 旧 SS データ列マップ転記（アプデ発行のみ・対応列のみ）' },
    { id: 'gas',          label: '6. ユーザーGAS ルーティング設定（v0.10.0 一元化・手作業なし）' },
    { id: 'client',       label: '7. clients/auth/change_log 投入' },
    // v0.14.0（§4-6-4 明示違反是正）：アプデ発行時のみ実行。承継関係（predecessorClientId →
    //   successorClientId + requestedBy）を change_log に独立記録する（recordSuccession action）。
    //   更新元 clients 行の contractStatus・deprecatedAt には一切書込しない（§4-6-1 ①③・
    //   更新元は読取専用として維持）。旧 PWA は稼働継続。旧 clientId の状態変更や運用停止判断は
    //   金光の独立した管理操作領域（§4-6-1 ④・05 §5-5）。
    { id: 'succession',   label: '8. 承継関係を change_log に記録（アプデ発行のみ・顧客要望メモ記録）' }
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
    manifestCode: '',      // v0.9.4：appsscript.json（oauthScopes 事前宣言・認可の二度手間根治）
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
            '<div class="manual-gas-step-title">④-a appsscript.json を貼り付け（★認可を発行フロー内で完結させる要）</div>' +
            '<p class="manual-gas-note">' +
              '左メニュー「<strong>プロジェクトの設定⚙</strong>」→「<strong>「appsscript.json」マニフェスト ファイルをエディタで表示する</strong>」に <strong>✓</strong> →<br>' +
              '左メニューの<strong>エディタ</strong>に戻ると <code>appsscript.json</code> が出現 → クリック → <code>Ctrl+A</code> → <code>Delete</code> → 下のボタンでコピー → <code>Ctrl+V</code> → <code>Ctrl+S</code> で保存。' +
            '</p>' +
            '<button type="button" class="btn-primary manual-gas-btn" id="manual-gas-manifest-copy-btn">' +
              '📋 appsscript.json をコピー' +
            '</button>' +
            '<p class="manual-gas-note" style="font-size:11px;color:#667;margin-top:6px;">' +
              '※ oauthScopes（SpreadsheetApp／Drive／Gmail 等）を事前宣言することで、次の⑤「デプロイ」時「アクセスを承認」で script owner の editor 実行 scope が一括 consent される。ただし web app 外部呼出しに対する Sensitive scope の活性化は別レイヤーで、⑤-b の editor 1 回実行が Google Apps Script の仕様上必要になる可能性がある（v0.9.15 field test の初回観察で URL 登録が通らず＝v0.9.16 で⑤-b を復活・実測は継続中）。⑥ URL 登録は先に authorize_check（backend v0.9.15）で自動判定するため、consent 完了済なら⑤-b は不要になる。' +
            '</p>' +
          '</li>' +
          '<li class="manual-gas-step">' +
            '<div class="manual-gas-step-title">⑤ ウェブアプリとしてデプロイ＋アクセスを承認</div>' +
            '<p class="manual-gas-note">' +
              '右上「<strong>デプロイ</strong>」→「<strong>新しいデプロイ</strong>」→ 歯車⚙ →「<strong>ウェブアプリ</strong>」を選択。<br>' +
              '「次のユーザーとして実行：<strong>自分</strong>」「アクセスできるユーザー：<strong>全員</strong>」を確認し、「<strong>デプロイ</strong>」を押下。<br>' +
              '★ 承認フロー：「<strong>アクセスを承認</strong>」 → アカウント選択（<code>k@tgx.jp</code>） →「詳細」→「<strong>{プロジェクト名}（安全ではないページ）に移動</strong>」→「<strong>許可</strong>」→ デプロイ完了画面へ。' +
            '</p>' +
          '</li>' +
          '<li class="manual-gas-step" style="background:#fff8ec;border:1px dashed #b8860b;padding:12px;border-radius:6px;">' +
            '<div class="manual-gas-step-title">⑤-b <code>authorizeScopes</code> を実行して全 Sensitive scope を一括活性化（★ editor 1 回実行）</div>' +
            '<p class="manual-gas-note">' +
              'Apps Script エディタ上部の <strong>関数プルダウン</strong>から <strong><code>authorizeScopes</code></strong> を選択 → <strong>▶実行</strong>。<br>' +
              '承認ダイアログが出たら：「<strong>権限を確認</strong>」→ アカウント選択（<code>k@tgx.jp</code>）→「詳細」→「<strong>{プロジェクト名}（安全ではないページ）に移動</strong>」→「<strong>許可</strong>」→ 実行ログに <code>{ spreadsheet: "…", drive: "…", gmail: "unread=N", scriptapp: "…" }</code> が出れば完了。' +
            '</p>' +
            '<p class="manual-gas-note" style="font-size:11px;color:#667;margin-top:6px;">' +
              '※ authorizeScopes は SpreadsheetApp／DriveApp／GmailApp／ScriptApp を 1 関数で叩く＝ 4 scope を 1 回で一括活性化。旧⑤-b（getSettings）は SpreadsheetApp scope 単発ゆえ他 scope 使用時に再手作業が発生したが、本手順は 1 回で完結する。⑥ URL登録時に master.gs（v0.9.15）が authorize_check で全 scope を検査するため、本手順を飛ばすと <code>gas_unauthorized</code> エラーで弾かれる。' +
            '</p>' +
          '</li>' +
          '<li class="manual-gas-step">' +
            '<div class="manual-gas-step-title">⑥ ウェブアプリURL を貼り付けて登録</div>' +
            '<p class="manual-gas-note">' +
              'デプロイ完了画面の「ウェブアプリ URL」（<code>https://script.google.com/macros/s/.../exec</code>）をコピーして下に貼付：' +
            '</p>' +
            '<div class="manual-gas-url-form" style="display:flex;flex-direction:column;gap:8px;">' +
              '<input type="text" id="manual-gas-url-input" class="manual-gas-url-input" ' +
                'placeholder="ウェブアプリ URL（https://script.google.com/macros/s/AKfycb.../exec）">' +
              '<button type="button" class="btn-primary" id="manual-gas-submit-btn">URL を登録</button>' +
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
    const manifestCopyBtn = document.getElementById('manual-gas-manifest-copy-btn');
    if (manifestCopyBtn) {
      manifestCopyBtn.addEventListener('click', function () {
        copyToClipboard(ManualGasState.manifestCode).then(function (ok) {
          if (ok) {
            showToast('appsscript.json をコピーしました', 'success');
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
        // 2026-08-29：projectId 廃止＝scriptId は常に空文字（GAS は運営のマイドライブに残置＝shared drive への自動移動なし）。
        if (typeof ManualGasState.onUrlConfirmed === 'function') {
          ManualGasState.onUrlConfirmed({ url: url, scriptId: '' });
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
      ManualGasState.manifestCode = prepResult.manifestCode || '';
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

      ManualGasState.onUrlConfirmed = function (payload) {
        ManualGasState.waiting = false;
        ManualGasState.onUrlConfirmed = null;
        // 2026-08-28：payload はオブジェクト {url, scriptId} または後方互換の文字列
        if (typeof payload === 'string') resolve({ url: payload, scriptId: '' });
        else resolve(payload || { url: '', scriptId: '' });
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
  // v0.9.12：authUrl が渡されたら 1クリック承認ブートストラップの導線を挿入（⑤-b 手作業消去）
  function showManualGasErrorAndRetry(errorMessage, authUrl) {
    const errorEl = document.getElementById('manual-gas-error');
    const submitBtn = document.getElementById('manual-gas-submit-btn');
    const urlInput = document.getElementById('manual-gas-url-input');
    if (errorEl) {
      if (authUrl) {
        // 認可未完＝1クリック承認ブートストラップを提示（editor での関数選択・実行が不要になる）
        errorEl.innerHTML =
          '<div style="margin-bottom:8px">' + escapeHtml(errorMessage) + '</div>' +
          '<div style="background:#fef3c7;padding:12px;border-radius:6px;border:1px solid #f59e0b">' +
          '<div style="font-weight:600;color:#92400e;margin-bottom:8px">🔗 1クリック承認で完了</div>' +
          '<a href="' + escapeHtml(authUrl) + '" target="_blank" rel="noopener" ' +
          'style="display:inline-block;padding:10px 16px;background:#f59e0b;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">' +
          '認可ページを新タブで開く</a>' +
          '<div style="font-size:12px;color:#78350f;margin-top:8px;line-height:1.5">' +
          '① 上のボタンで新タブを開く → ② k@tgx.jp を選択 → ③「詳細 → 安全ではないページに移動 → 許可」→ ④ タブを閉じてこのパネルの「再検証」を押す' +
          '</div></div>';
      } else {
        errorEl.textContent = errorMessage;
      }
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
    const s2 = RegisterState.data.step2;
    const isUpd = (s1.issueMode === 'update');
    const ownerUrl = 'https://app.ultra7.pw/' + Step7Progress.clientId + '/';
    const staffUrl = ownerUrl + 'staff-clockin.html';
    const pdfBase64 = Step7Progress.deliveryCardBase64;
    const pdfHref = pdfBase64
      ? 'data:application/pdf;base64,' + pdfBase64
      : '#';
    const pdfFilename = Step7Progress.clientId + '-card.pdf';

    // v0.14.0（2026-09-11・§4-6-4 明示違反是正）：アプデ発行完了時に「新 clientId 発行済・
    //   承継関係を change_log に記録済・旧 clientId は稼働継続・状態変更なし」を明示する。
    //   運営は新 URL 案内・併存確認までを担い、旧 clientId の運用停止判断・削除は
    //   金光の独立した管理操作領域（§4-6-1 ④）として本フローから切り離す。
    const updateBanner = isUpd
      ? ('<div style="margin:0 0 16px;padding:14px 16px;background:#eaf6ec;border:2px solid #4caf50;border-radius:8px;">' +
           '<div style="font-weight:700;color:#2e7d32;margin-bottom:6px;">アップデート版発行完了（§4-6-3 技術動作 5 段）</div>' +
           '<div style="font-size:13px;line-height:1.6;color:#334;">' +
             '旧 clientId: <code>' + escapeHtml(String(s2.reuseClientId || '')) + '</code>' +
             (s2.reuseStoreName ? '（' + escapeHtml(String(s2.reuseStoreName)) + '）' : '') +
             ' → 新 clientId: <code>' + escapeHtml(Step7Progress.clientId) + '</code><br>' +
             '旧 SS の運用データを列マップ転記で新 SS に承継済（対応列のみ・新テンプレの列拡張を保持）。<br>' +
             '承継関係を change_log に記録済（<code>issueNewVersion</code>）＝ 旧 clientId は稼働継続・contractStatus 等の状態変更なし（§4-6-1 ①③ 更新元は読取のみ）。旧 clientId の運用停止判断・削除は金光の独立した管理操作領域（§4-6-1 ④）。' +
           '</div>' +
         '</div>')
      : '';

    return (
      '<div class="completion-card">' +
        updateBanner +
        '<div class="completion-header">' +
          '<span class="completion-icon">🎉</span>' +
          '<h3>' + (isUpd ? 'アップデート発行が完了しました' : '新規登録が完了しました') + '</h3>' +
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
    // 2026-08-27：既存SS 再利用モード（step2 で指定されていれば Step7Progress へ引き継ぐ）
    Step7Progress.reuseSpreadsheetId = String(RegisterState.data.step2.reuseSpreadsheetId || '');

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

      // ---- v0.14.0（2026-09-11・§4-6-4 明示違反是正）----
      //   update mode は「新 clientId 発行＋列マップ転記＋新テンプレ注入＋承継関係の独立記録＋
      //   顧客要望メモ記録」で完結する（→ 00_原則.md §4-6 リリース原則）。更新元 clients 行の
      //   contractStatus・deprecatedAt には一切書込しない（§4-6-1 ①③）。新規と同じ 7 段プロセス＋
      //   Step 4.5 (writeGasUrlShortcutForClient・新規/update 共通) を走らせ、update mode の時のみ
      //   Step 5.5 (migrateSsDataByColumnMap) と Step 8 (recordSuccession) を挟む。
      //   v0.13.0 で Step 8 が markClientAsDeprecated を呼び更新元 clients 行を書換していた
      //   （§4-6-4 明示違反）動線は v0.14.0 で撤去し、承継関係は recordSuccession action で
      //   change_log に独立記録する形へ振替。markClientAsDeprecated 関数は撤去せず維持（§4-6-1 ④・
      //   金光の独立管理操作＝ Apps Script Editor 直接実行等で引き続き利用可能）。
      //   copySsAllSheets（v0.12.0 違反 A）は v0.13.0 で撤回削除・以降維持。
      const isUpdateMode = (s1.issueMode === 'update');
      const oldClientIdForUpdate = isUpdateMode ? String(s2.reuseClientId || '').trim() : '';
      const oldSpreadsheetIdForUpdate = isUpdateMode ? String(s2.reuseSpreadsheetId || '').trim() : '';
      if (isUpdateMode) {
        if (!oldClientIdForUpdate) {
          throw new Error('update mode で reuseClientId が空です（Step 2 で更新元を選択してください）');
        }
        if (!oldSpreadsheetIdForUpdate) {
          throw new Error('update mode で reuseSpreadsheetId が空です（Step 2 で更新元 SS を確定してください）');
        }
        // v0.13.1（2026-09-09）：顧客要望メモは任意化・空でも実行可（記入時のみ change_log 記録）
      } else {
        // 新規発行では update 専用ステージを「対象外」で done 表示
        step7SetStatus('migrateData', 'done', '新規発行では対象外');
        step7SetStatus('succession', 'done', '新規発行では対象外');
      }

      // ---- 1. generateClientId ----
      // v0.13.1（2026-09-09）：update mode では Step 2 の reuseClientId から base 部分を
      //   抽出して新 clientCode として渡す（`uz-osafune-a3f7` → base=`osafune` → 新 `uz-osafune-XXXX`）。
      //   Step 1 での clientCode 手入力を求めない＝ 運用者の手数を減らす（金光判断・field test 後）。
      step7SetStatus('clientId', 'running', '採番中...');
      let codeForGen = String(RegisterState.data.step1.clientCode || '').trim();
      if (isUpdateMode) {
        const oldId = String(RegisterState.data.step2.reuseClientId || '');
        const m = oldId.match(/^uz-(.+)-[a-z0-9]{4}$/);
        codeForGen = m ? m[1] : oldId.replace(/^uz-/, '');
      }
      const r1 = await callGasAction('generateClientId', { code: codeForGen });
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
      // v0.11.1（2026-09-06 根治）：業界標準（tenant row create → API key issue → resource
      //   provisioning）に沿って実行順を組替＝ 5（SS）→ 6（GAS）→ 7（clients 投入・apiToken 確定）
      //   → 4（リポファイル・clients から apiToken read-only 参照）。従来（v0.11.0 まで）は
      //   5→6→4→7 で、v0.11.0 で writeUserRepositoryFiles が clients シートを引くように
      //   なった瞬間 Step 4 で client_not_found が発生する順序破綻（field test で判明）。
      //   UI 上は「4. リポファイル書込」と表示しつつ、実行順序は clients 投入後とする。
      step7SetStatus('repoFiles', 'pending', '（SS・GAS・clients 投入後に実行）');

      // ---- 5. createUserSpreadsheet ----
      // v0.13.0（2026-09-08・体制構築 4 層＋技術動作 5 段）：reuseSpreadsheetId 経路は v0.12.0 で撤回済
      //   （v0.11.0 URL 不変案の一部＝ 鉄則違反）。update mode でも新 SS を新規生成し、直後の
      //   Step 5.5 (migrateSsDataByColumnMap) で旧 SS の運用データを列マップ転記する（対応列のみ・
      //   新テンプレの列拡張を保持しつつ運用データ承継・→ 00 §4-6-3 Step 3）。
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
        costOptionalQuota:    s3.costOptionalQuota,
        // 大分類マスタ（2026-08-27・→ 03§1-1-2 / §1-3-2・任意設定・空配列で無害運転）
        serviceChannelList:   s3.serviceChannelList || [],
        purchaseCategoryList: s3.purchaseCategoryList || [],
        serviceChannelQuota:  5,
        purchaseCategoryQuota: 3,
        // 機能ON/OFF（settings B16・段2/段3は納品時トグル・→ 03_データ仕様.md §6）
        // アストラ（timecardCount=0）は勤怠系メニュー撤廃（attendance/clockin/payroll 全て false）
        featureVisibility: {
          attendance_menu:      s2.timecardCount >= 5,
          clockin_menu:         s2.timecardCount >= 5,
          payroll_menu:         s2.timecardCount >= 5,
          qrProofEnabled:       s2.timecardCount >= 5 && !!s2.qrProofEnabled,
          shiftScheduleEnabled: s2.timecardCount >= 5 && !!s2.shiftScheduleEnabled
        }
        // v0.13.0：reuseSpreadsheetId は削除（v0.11.0 で in-place reuse は deprecated_reuse_path
        //   throw に置換済＝ 送っても弾かれる）。update mode の SS 承継は migrateSsDataByColumnMap で行う。
      });
      Step7Progress.spreadsheetId = String(r5.spreadsheetId || '');
      Step7Progress.spreadsheetUrl = String(r5.spreadsheetUrl || '');
      if (!Step7Progress.spreadsheetId) {
        throw new Error('createUserSpreadsheet 応答に spreadsheetId が含まれていません');
      }
      step7SetStatus('spreadsheet', 'done', Step7Progress.spreadsheetId);

      // ---- 5.5. migrateSsDataByColumnMap（update mode のみ・v0.13.0 技術動作 5 段 Step 3）----
      //   旧 SS の運用データを新 SS へ列マップ転記（対応列のみ・新のみ列は空欄・旧のみ列は破棄・
      //   settings は key/value 照合）。新テンプレの列拡張を保持しつつ運用データ承継。
      //   → 00_原則.md §4-6-3。新規発行時は「新規発行では対象外」で skip（STEP7_STAGES 明示）。
      if (isUpdateMode) {
        step7SetStatus('migrateData', 'running',
          '旧 SS データを列マップ転記中（' + oldClientIdForUpdate + ' → ' + Step7Progress.clientId + '）...');
        const rMig = await callGasAction('migrateSsDataByColumnMap', {
          fromSpreadsheetId: oldSpreadsheetIdForUpdate,
          toSpreadsheetId:   Step7Progress.spreadsheetId,
          clientId:          Step7Progress.clientId
        });
        Step7Progress.migrateDataResult = rMig;
        const migratedCount = (rMig && Array.isArray(rMig.migrated)) ? rMig.migrated.length : 0;
        const errCount = (rMig && Array.isArray(rMig.errors)) ? rMig.errors.length : 0;
        if (errCount > 0) {
          throw new Error('migrateSsDataByColumnMap で ' + errCount + ' シートの列マップ転記に失敗しました（詳細: '
            + JSON.stringify(rMig.errors).slice(0, 300) + '）');
        }
        const migratedNames = (rMig && rMig.migrated || []).map(function(m){ return m.sheet; }).join(', ');
        step7SetStatus('migrateData', 'done',
          migratedCount + ' シート列マップ転記済（' + migratedNames + '）');
      }

      // ---- 6. ユーザーGAS デプロイ（v0.10.0 一元 GAS ルーティング化・手作業廃止） ----
      //   v0.10.0：店舗別 GAS プロジェクト作成・手動 deploy・authorize 手作業を全廃。
      //   master GAS URL を全店舗共通で使い、PWA 側の callGAS が user_call 経由で
      //   dispatch する。詳細は 資料/知識MD/04_運営ポータル.md §11。
      //   editor 手作業（⑤-b authorizeScopes ▶実行）は本経路で構造消滅。
      step7SetStatus('gas', 'running', 'v0.10.0 一元 GAS ルーティング（master 経由・手作業なし）...');
      Step7Progress.gasUrl = window.AdminApp.MASTER_GAS_URL;
      step7SetStatus('gas', 'done', 'master GAS ルーティング設定完了（手作業ゼロ）');

      // ---- 7. registerNewClient（v0.11.1 根治：clients シート先行投入）----
      //   apiToken と currentVersion=1 が clients シートに appendRow される。以降の Step 4
      //   (writeUserRepositoryFiles) は clients から apiToken を read-only 参照して PWA
      //   テンプレの __API_TOKEN__ に埋め込む＝ 真実の源から決定論的判定（§◎ 再現性ルール）。
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
          costOptionalQuota:   s3.costOptionalQuota,
          // 段2/段3フラグ（dashboard 一覧表示用に master clients へ複製・正本はユーザーSS B16）
          qrProofEnabled:       s2.timecardCount >= 5 && !!s2.qrProofEnabled,
          shiftScheduleEnabled: s2.timecardCount >= 5 && !!s2.shiftScheduleEnabled
        }
      });
      step7SetStatus('client', 'done', '投入完了');

      // ---- 4 実行（v0.11.1 根治：clients 投入後・apiToken read-only 参照可能）----
      step7SetStatus('repoFiles', 'running', 'manifest / theme.css / app.js 書込中...');
      await callGasAction('writeUserRepositoryFiles', {
        clientId:    Step7Progress.clientId,
        gasUrl:      Step7Progress.gasUrl,
        storeName:   s1.storeName,
        themeColor:  s4.themeColor,
        logoBgColor: s4.logoBgColor
      });
      step7SetStatus('repoFiles', 'done', '4ファイル書込済');

      // ---- 4.5. writeGasUrlShortcutForClient（v0.13.0 技術動作 5 段 Step 4）----
      //   3 成果物セット（-data / -gas.url / -card）の -gas を担保。全 clientId 共通で
      //   master GAS URL を指す .url ショートカット。新規・アプデ 共通で実行。
      //   → 00_原則.md §4-6-3 / 07_命名・保存規則.md §2-8。
      step7SetStatus('gasShortcut', 'running', '-gas.url ショートカット生成中...');
      const rShortcut = await callGasAction('writeGasUrlShortcutForClient', {
        clientId: Step7Progress.clientId
      });
      Step7Progress.gasShortcutResult = rShortcut;
      step7SetStatus('gasShortcut', 'done',
        (rShortcut && rShortcut.replaced ? '更新済（' : '生成済（') + (rShortcut && rShortcut.fileName || (Step7Progress.clientId + '-gas.url')) + '）');

      // ---- 8. recordSuccession（update mode のみ・v0.14.0 §4-6-4 明示違反是正）----
      //   承継関係（predecessorClientId → successorClientId + requestedBy）を change_log に
      //   独立記録する。更新元 clients 行の contractStatus・deprecatedAt には一切書込しない
      //   （§4-6-1 ①③・更新元は読取専用として維持）。旧 PWA は稼働継続（apiToken 生きたまま）。
      //   旧 clientId の状態変更や運用停止判断は金光の独立した管理操作領域（§4-6-1 ④・
      //   05 §5-5・Apps Script Editor 直接実行の markClientAsDeprecated / admin UI 手動発火）。
      //   → 00_原則.md §4-6-3 Step 5 / §4-6-1 ①③④。
      //   idempotent＝ 同一 predecessor+successor の記録が既にあれば changed:false で no-op。
      //   新規発行時は「新規発行では対象外」で skip（STEP7_STAGES 明示）。
      if (isUpdateMode) {
        step7SetStatus('succession', 'running',
          '承継関係を change_log に記録中（' + oldClientIdForUpdate + ' → ' + Step7Progress.clientId + '・顧客要望メモ記録）...');
        const rSucc = await callGasAction('recordSuccession', {
          predecessorClientId: oldClientIdForUpdate,
          successorClientId:   Step7Progress.clientId,
          requestedBy:         String(s1.requestedBy || '').trim()
        });
        Step7Progress.successionResult = rSucc;
        const succNote = (rSucc && rSucc.changed === false)
          ? '既に change_log に承継関係記録あり（idempotent no-op）'
          : ('承継関係を change_log に記録済（旧: ' + oldClientIdForUpdate + ' → 新: ' + Step7Progress.clientId + '・旧 clientId は稼働継続・状態変更なし）');
        step7SetStatus('succession', 'done', succNote);
      }

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
      showToast(isUpdateMode ? 'アップデート発行が完了しました（新 clientId 発行＋列マップ転記＋旧 deprecated 化）' : '新規登録が完了しました', 'success');

    } catch (err) {
      // ---- エラー停止（v0.11.4 atomic rollback）----
      Step7Progress.running = false;
      Step7Progress.errorMessage = String((err && err.message) || err);

      // v0.11.4（2026-09-07）：発行途中の失敗で作られた実体を全 rollback する。
      //   Step 1 (generateClientId) より後で失敗した場合、Step7Progress.clientId が設定済み。
      //   master GAS の rollbackClient action が GitHub repo・Drive folder・マイドライブ orphan・
      //   clients row・auth row を idempotent に削除。これで orphan が生まれず、同じ clientCode で
      //   すぐ再試行できる（金光の芯：情報の乖離・重複による繰り返し作業の根絶）。
      if (Step7Progress.clientId) {
        try {
          const rb = await callGasAction('rollbackClient', { clientId: Step7Progress.clientId });
          Step7Progress.rollbackReport = rb;
        } catch (rbErr) {
          Step7Progress.rollbackError = String((rbErr && rbErr.message) || rbErr);
        }
      }

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
      const rollbackNote = Step7Progress.rollbackReport
        ? '（発行途中実体は全 rollback 済・同じ code で再試行可）'
        : (Step7Progress.rollbackError ? '（rollback 失敗：手動 cleanup 要）' : '');
      showToast('登録処理が中断しました' + rollbackNote, 'error');
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
      const s2 = RegisterState.data.step2;
      const isUpd = (s1.issueMode === 'update');
      const modeTitle = isUpd
        ? 'アップデート発行（顧客要望起点・新 clientId 発行＋列マップ転記＋新テンプレ注入＋旧 deprecated 化）'
        : '新規登録';
      const updHeader = isUpd
        ? ('更新元: ' + (s2.reuseStoreName || '(不明)') + '（' + (s2.reuseClientId || '?') + '）\n' +
           '顧客要望メモ: ' + (String(s1.requestedBy || '').trim() || '(未入力)') + '\n')
        : '';
      const updSteps = isUpd
        ? ('・旧 SS データ列マップ転記（対応列のみ・新テンプレの列拡張を保持・settings は key/value 照合）\n' +
           '・旧 clientId を deprecated 化（deprecatedAt+requestedBy 記録・アプデ元/アプデ版 併存管理・目安 30 日程度で運営判断 trash）\n')
        : '';
      const okToProceed = confirm(
        '以下の内容で' + modeTitle + 'を実行します。\n\n' +
        updHeader +
        '店舗名：' + s1.storeName + '\n' +
        'タイムカード数：' + s2.timecardCount + '\n' +
        '月額:¥' + Number(s1.monthlyFee).toLocaleString('ja-JP') + '\n\n' +
        '・GitHubリポジトリ生成（自動）\n' +
        '・Googleスプレッドシート生成（自動）\n' +
        updSteps +
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

    // Step 1：発行モード（新規/アップデート）変更で Step 2 の既存SS紐付けパネル表示を切替
    document.querySelectorAll('input[name="f1-issue-mode"]').forEach(function (r) {
      r.addEventListener('change', updateIssueModeVisibility);
    });

    // v0.9.14（2026-09-04）：Step 2 更新元 dropdown 変更で 3層 preflight 検証＋readiness UI 更新。
    //   全 ✅ で新clientId が自動採番され Step 1 プレビューへ反映される。
    //   readiness が未通過（❌ or ⚠️）の間は readStep2AndValidate() で「次へ」が弾かれる。
    const reuseSel = $('f2-reuse-select');
    if (reuseSel) {
      reuseSel.addEventListener('change', function () {
        validateAndRenderReuseSource(String(reuseSel.value || ''));
      });
    }
    updateIssueModeVisibility();

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
