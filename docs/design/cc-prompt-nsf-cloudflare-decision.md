# 判断: NSFフォーラムのCloudflare対策はB（保留、Reddit先行）

作成: 2026-07-20
種別: 判断・指示

---

## 決定

Cloudflare対策の3案（A: Playwright導入、B: NSF保留・Reddit先行、C: 有料スクレイピングサービス）のうち、**B**を採用する。

理由: LightsailサーバーはNODE_OPTIONSでメモリ上限を絞っている小規模インスタンスであり、Playwright（ヘッドレスChromium常駐）はリソース負荷の懸念が大きい。有料サービス（C）も検討価値はあるが、まずは追加コスト・複雑さなしで動くRedditで運用を始める。

## お願いしたいこと

- NSF監視対象7件（スレッド6件＋Space Policy Discussionボード）は`active: false`のまま維持
- Redditの監視対象（中国・北朝鮮・ロシア関連のsubreddit）を、今回のテーマに沿って追加登録してほしい。具体的なsubreddit選定はCCの判断で良い（実在確認は必要）
- NSF対応（Playwright導入 or 有料サービス）は将来の検討事項として`spacian_ideas.md`等に記録しておいてもらえると助かる

急ぎではない。完了報告をCoworkに返してほしい。
