# CC実装依頼: Roscosmos RSS追加 + Andrew Jones Substack RSS追加 + tokenize() Unicode対応

作成: 2026-06-10（追記: Andrew Jones Substack RSSを追加）

---

## 合意事項

cc-prompt-multilingual-sources.md / cc-prompt-china-coverage.md でのCCの見解を踏まえ、以下の方針で進める。

| 優先度 | 内容 |
|---|---|
| **今回** | Roscosmos RSS追加 + Andrew Jones Substack RSS追加 + tokenize() Unicode修正 |
| 保留 | TASS（フィルタリング要）、UAE Space Agency |
| 別途設計相談 | Launch Library 2 API（打上げイベント検知→速報生成） |
| 将来課題 | 中国語WeChat系ソース（RSSHub/sitemap）、Google News RSS、SNS由来情報、NOTAM/衛星カタログ差分 |
| 見送り | ヒンディー語 |

CC提案の実装順（tokenize修正 → sources.jsonにRoscosmos+Andrew Jones追加 → 疎通確認）でまとめて1回のハンドオフとして進める。

---

## Step 1: tokenize() のUnicode対応

CC提案の修正をそのまま採用:

```typescript
function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/[\s\p{P}\p{Z}\p{S}]+/u).filter((w) => w.length > 2)
  );
}
```

`score.ts` と `generate.ts` で重複定義されているはずなので、共通化できる場合は共通化してほしい
（無理に大きなリファクタにはしなくてよい）。

---

## Step 2: `config/sources.json` にエントリ追加

### Roscosmos（CC提案の設定をベースに）

```json
{
  "source_id": "rss_roscosmos",
  "lane": "rss",
  "name": "Roscosmos",
  "domain": "roscosmos.ru",
  "url": "https://www.roscosmos.ru/rss/",
  "enabled": true,
  "priority": 55,
  "max_items": 25,
  "notes": "Russian space agency official feed. Cyrillic titles — tokenize() Unicode fix required.",
  "image_policy": {
    "og_image_usage": "none",
    "attribution": "Роскосмос",
    "license": "Government Press",
    "notes": "og:image embed not explicitly permitted; consider Flickr CC BY 2.0 images via press-kits in future"
  }
}
```

実際にcurlでフィード形式を確認してから追加してほしい:

```bash
curl -s https://www.roscosmos.ru/rss/ | head -40
```

`<item>` に `<link>` `<title>` `<pubDate>` があればOK。`<description>` がなくても既存コードは `snippet: null` を許容済み。
フィード形式が想定と異なる場合（標準RSS 2.0でない、HTTPエラー等）は、無理に進めず一旦報告してほしい。

### Andrew Jones「China Space News Roundup」（Substack、CC確認済み）

```json
{
  "source_id": "rss_china_space_news_roundup",
  "lane": "rss",
  "name": "China Space News Roundup (Andrew Jones)",
  "domain": "chinaspacenewsroundup.substack.com",
  "url": "https://chinaspacenewsroundup.substack.com/feed",
  "enabled": true,
  "priority": 55,
  "max_items": 25,
  "notes": "English-language China space specialist newsletter (Substack). Weekly roundup format, multiple topics per issue.",
  "image_policy": {
    "og_image_usage": "none",
    "notes": "Substack newsletter; image origins are mixed, do not embed"
  }
}
```

priorityは両方とも既存ソース（55〜65）を参考にCCの判断で調整してよい。

---

## Step 3: 動作確認

`npm run collect` を実行し、Roscosmos / Andrew Jonesの両方からcandidateが取得できるか確認。
ロシア語タイトルのcandidateが生成されたら、tokenize()修正が効いているか
（重複検知やsuggested_referencesでクラッシュしないか）も合わせて確認してほしい。

---

## 完了条件

- [ ] tokenize() Unicode対応
- [ ] Roscosmos RSS疎通確認（curl結果を報告）＋sources.jsonにエントリ追加
- [ ] sources.jsonにAndrew Jones (China Space News Roundup) エントリ追加
- [ ] `npm run build` 通過
- [ ] `npm run collect` でロシア語candidate・China Space News Roundup候補の取得確認

---

## 補足

この実装で気づいた点・懸念点があれば、完了報告で教えてほしい
（特にロシア語タイトルのGemini要約品質や、candidateの表示まわりで何か想定外の挙動があれば）。

Launch Library 2 API（打上げイベント検知→速報生成）は規模が大きいため、別途設計相談として
改めてハンドオフする予定（cc-prompt-china-coverage.md Q2参照）。今回のスコープには含まない。
