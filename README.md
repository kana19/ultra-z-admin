# ultra-z-admin

**ウルトラZAIMUくん レオ・アストラ 運営ポータル**
／ 株式会社ターゲット社 専用管理画面（PC専用PWA・秘匿URL前提）

> 仕様の正本は持たない。運営ポータル仕様は `資料/知識MD/04_運営ポータル.md` を参照する（重複回避）。

## repo固有情報

- 公開URL：<https://kana19.github.io/ultra-z-admin/>
- 認証基盤：マスタスプレッドシート `ultra-z-master`（k@tgx.jp 所有）＋ マスタGAS（`gas/master_v0_6_6.gs`）
- 対象端末：PC専用（最低幅 1280px・`@media` 不使用・viewport `width=1280` 固定）
- 基調色：宇宙色 `#0B1842`

## デプロイ

- フロント（PWA）：`git add -A && git commit -m "…" && git push` → GitHub Pages 反映1〜2分。
- マスタGAS：Apps Script エディタで `gas/master_v0_6_6.gs` を全文置換 → 既存デプロイの新バージョン化（**WebアプリURL不変**）。git push とは別作業。
