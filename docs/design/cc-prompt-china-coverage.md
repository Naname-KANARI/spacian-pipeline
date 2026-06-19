# CC設計相談: 中国宇宙ニュースのカバレッジ拡大

作成: 2026-06-10

---

## 背景

「中国の宇宙ニュースを見過ごせない」という課題に対し、Gemini・ChatGPT両方から
WeChat直接収集を避けたアイデアが出た。両者で一致した方向性:

- WeChatは凍結リスク・更新遅延（平均6時間）が割に合わない → 引き続き見送り
- 英語圏の「中国宇宙ウォッチャー」を経由するのが最も品質が高い
- Google News RSS検索式は無料・標準RSSだが中国語ノイズ除去が必要
- 打上げイベント自体は構造化データAPI（Launch Library 2等）から拾う方が確実
- より大きな方向性として「ニュース収集」ではなく「中国宇宙活動検知」（NOTAM・衛星カタログ差分等）への
  reframeも提案された → これはSPECTRUM/Launch Analysis軸との連携になりそうで、規模が大きい

---

## 検証済み候補

### 1. Andrew Jones「China Space News Roundup」(Substack)
- フリーランスジャーナリスト Andrew Jones（SpaceNews等にも寄稿）が中国宇宙開発専門で配信
- RSS URL確認済み: `https://chinaspacenewsroundup.substack.com/feed`（XML応答を確認）
- **英語**、中国語一次情報の翻訳・解説を含む
- 既存のRSS収集アーキテクチャにそのまま乗りそう（標準Substack RSS）

### 2. Launch Library 2 API (TheSpaceDevs)
- 打上げスケジュール・結果を構造化JSONで提供（ペイロード・軌道・ロケット種別等）
- 無料枠: 15 calls/hour（APIキー不要、IPベース）
- 中国の打上げも含め全世界をカバー
- ニュース記事ではなく「打上げイベント」をトリガーにした速報記事生成に使える可能性

---

## 将来検討（今回はスコープ外、メモのみ）

- Google News RSS検索式（中国語キーワード/サイト指定）— ノイズ除去の仕組みが必要
- NSFフォーラム特定ボードのRSS — OSINTコミュニティの中国宇宙監視を活用
- NOTAM/NAVAREA・衛星カタログ差分による活動検知 — SPECTRUM/Launch Analysis軸との連携、規模大

---

## CCへの質問

### Q1: Andrew Jones Substack RSSの追加
`https://chinaspacenewsroundup.substack.com/feed` を `config/sources.json` に追加する場合、
Roscosmos追加と同様の手順で乗りそうか。image_policy（Substack記事の画像転載可否）はどう扱うべきか
（一旦 `"none"` でよさそうか）。

### Q2: Launch Library 2 APIの統合
「打上げイベント検知 → 定型速報記事生成」は既存の collect→score→generate フローとは
別の新しい仕組みになりそうだが、規模感としてどの程度か。今回は提案メモに留め、
別途設計相談として切り出すべきか、CCの感触を聞きたい。

### Q3: その他
優先順位や懸念点があれば。

---

## 暫定方針（たたき台）

- **今回**: Andrew Jones Substack RSS追加（Roscosmos対応と合わせて、または次の小さなハンドオフで）
- **別途相談**: Launch Library 2 APIによる打上げ速報生成（新機能として規模を見積もってから）
- **将来/SPECTRUM連携**: Google News RSS、NOTAM/衛星カタログ差分による活動検知
