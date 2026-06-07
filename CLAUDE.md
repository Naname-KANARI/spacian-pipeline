# spacian-pipeline — CLAUDE.md

## 概要

SPACiAN（spacian.news）の記事生成パイプライン。  
宇宙ニュースをRSSから自動収集し、Gemini でスコアリング・記事生成を行い、
Nanameの承認を経て spacian-web に公開する。

**設計書**: `C:\Users\SPACi\Projects\spacian-web\docs\pipeline-design.md`  
（実装前に必ずこの設計書を参照すること）

---

## 3者協働モデル

| 役割 | 担当 |
|---|---|
| **Cowork**（Claude） | 戦略・設計レビュー・判断サポート |
| **CC**（Claude Code） | 実装・git操作 |
| **Naname** | 最終承認・公開判断 |

CCは設計書の範囲内で実装する。設計外の変更はCoworkと要確認。

---

## パイプライン構成

```
① 収集（AIゼロ） → data/items.jsonl
② 選定・スコアリング（Gemini） → data/candidates/
   【Naname判断①】
③ 記事生成（Gemini） → data/pending/
   【Naname判断②】
④ 自動公開 → ../spacian-web/src/data/dispatch/
   【Naname判断③】
```

---

## ディレクトリ

```
spacian-pipeline/
├── config/sources.json       ← RSS入口マスター（MVP: 5本）
├── config/settings.json      ← 閾値・保持期間等
├── src/
│   ├── collect.ts            ← ① 収集
│   ├── score.ts              ← ② スコアリング
│   ├── generate.ts           ← ③ 記事生成
│   ├── publish.ts            ← ④ 自動公開
│   ├── cli.ts                ← 編集長操作CLI
│   └── lib/
│       ├── normalizer.ts     ← URL正規化・NormalizedItem生成
│       ├── health.ts         ← SOURCE_HEALTH管理
│       └── gemini.ts         ← Gemini APIクライアント
├── data/                     ← .gitignore対象（ローカルのみ）
└── logs/                     ← 実行ログ
```

---

## 重要ルール

- `data/` は .gitignore 対象。収集・生成データはリポジトリに含めない
- `.env` は .gitignore 対象。`GEMINI_API_KEY` はローカルのみ
- ソース1本の失敗は全体に影響しない（設計書§3.4）
- 公開前に必ず Naname の承認を経る
- spacian-web との連携は単純コピー + git push（submodule不使用）

---

## 実装ステップ（設計書§13）

- [x] B1: プロジェクト初期化
- [ ] B2: RSS収集モジュール（src/collect.ts）
- [ ] B3: スコアリング（src/score.ts）
- [ ] B4: 記事生成（src/generate.ts）
- [ ] B5: 承認CLI（src/cli.ts）
- [ ] B6: 自動公開（src/publish.ts）
