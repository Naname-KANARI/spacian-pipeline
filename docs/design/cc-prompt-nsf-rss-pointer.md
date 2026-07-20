# 共有: NSFフォーラムのRSS案（案C）調査の手がかり

作成: 2026-07-20
種別: 共有（急ぎではない）

---

## 経緯

`spacian_ideas.md`セクションLで、NSF Cloudflare対策の案Cとして「NSFのRSS存在確認」が「要確認」になっていた。以前の別調査（Oracles設計相談の初期段階）で、NSFフォーラム自身に"RSS Feeds"という説明スレッド（`https://forum.nasaspaceflight.com/index.php?topic=5090.0`）があるのを見つけていたので共有する。

SMFフォーラムソフトウェア自体は一般に`?action=.xml;type=rss`形式のRSSを提供する機能を持っている（wiki.simplemachines.org/smf/XML_feedsで確認済み）。

## 未確認の点

RSSエンドポイント自体がCloudflareのManaged Challengeの対象外になっているかどうかは分からない。サイト全体がCloudflareの背後にある場合、RSSも同じ壁に当たる可能性はある。フィードリーダー向けにCloudflare側で例外設定されているケースもあるので、実際に試してみる価値はありそう。

## お願いしたいこと

急ぎではない。次にNSF対応（案A/B/C）に着手するタイミングで、案Cの選択肢としてこの情報を参考にしてほしい。
