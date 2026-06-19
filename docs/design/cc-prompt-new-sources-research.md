# 収集サイト追加調査: EU/US プレスリリース・画像配信元

作成: 2026-06-12

---

## 背景

先のPR TIMES相当サイト調査で挙がった候補（EurekAlert!, ESA Newsroom, EUSPA, Business Wire, PR Newswire/GlobeNewswire）について、
`config/sources.json` への追加可否を利用規約・画像ライセンス込みで調査した。

---

## 追加推奨: ESA Newsroom

- RSS: `https://www.esa.int/rssfeed/TopNews`
- コンテンツ利用: 編集・報道目的の利用は無償・許諾不要（[ESA Multimedia terms](https://www.esa.int/ESA_Multimedia/Terms_and_conditions_of_use_of_images_and_videos_available_on_the_esa_website)）
- 画像: 多くが **CC BY-SA 3.0 IGO**（クレジット表記＋ライセンスへのリンクで再配布可、商用可）。一部は「ESA標準ライセンス」で商用利用除外。混在しているため**画像ごとにライセンス表記の確認が必要**。
- 「ESAの推奨・支持を示唆する用途」は禁止（CC BY-SA・標準どちらも共通）。

```json
{
  "source_id": "rss_esa_newsroom",
  "lane": "rss",
  "name": "ESA Newsroom",
  "domain": "esa.int",
  "url": "https://www.esa.int/rssfeed/TopNews",
  "enabled": true,
  "priority": 65,
  "max_items": 25,
  "notes": "",
  "image_policy": {
    "og_image_usage": "embed",
    "attribution": "ESA",
    "license": "CC BY-SA 3.0 IGO (画像によりESA Standard Licenseの場合あり)",
    "notes": "編集目的利用は無償可。CC BY-SA画像とESA標準ライセンス画像が混在し後者は商用利用除外のためembed前に個別確認が必要。ESAの推奨/支持を示唆する用途は不可。"
  }
}
```

JAXA (`rss_jp_jaxa_en`) と同等の優先度65を想定。

---

## 条件付き追加: EurekAlert! (AAAS)

- RSS: 公式一覧 `https://www.eurekalert.org/rss.php`（カテゴリ別フィードあり、Space/Astronomyカテゴリの正確なURLは要確認）
- コンテンツ利用: 全文転載・再配布は許諾なしに不可。**RSSフィード経由のタイトル+要約+リンクバックのみは利用規約上想定された使い方**（既存ソース群も全文転載ではなくタイトル/要約+リンクの使い方なので運用上は既存パターンと同じ）。
- 追加制約: フィード内容の改変禁止、広告併用禁止 — pipeline側でRSS本文を加工・要約モデルに通す場合は出力に「EurekAlert! (a service of AAAS)」のクレジットを残すこと。
- 画像: 二次利用許諾は確認できず → `og_image_usage: "none"`

```json
{
  "source_id": "rss_eurekalert_space",
  "lane": "rss",
  "name": "EurekAlert! - Space & Planetary Science",
  "domain": "eurekalert.org",
  "url": "https://www.eurekalert.org/rss.php （要: Space/Astronomyカテゴリの個別URL確認）",
  "enabled": true,
  "priority": 50,
  "max_items": 25,
  "notes": "AAAS運営の学術プレスリリース集約。タイトル+要約+リンクバックのみ使用、全文転載・改変・広告併用は禁止。出力にAAASクレジットを残す。",
  "image_policy": {
    "og_image_usage": "none",
    "attribution": "EurekAlert! (a service of AAAS)",
    "notes": "画像の二次利用許諾は確認できず。og:image embedしない。"
  }
}
```

---

## 保留: EUSPA (EU Agency for the Space Programme)

- RSS フィードは見つからず（ニュースレター講読のみ）。
- 画像: 「すべての素材は著作権保護下にあり、利用前にEUSPAの承認が必要」(`com@euspa.europa.eu`への申請制)。
- 現行 `config/sources.json` は `lane: "rss"` 前提の自動収集設計のため、EUSPAは**現状の仕組みに乗らない**。RSS提供開始または事前許諾済み画像セットの公開があれば再検討。

---

## 保留: Business Wire / PR Newswire / GlobeNewswire

- RSS自体は存在するが、業種キーワード横断のフィードで**Space/Aerospace以外の大量のノイズ**を含む（航空＋防衛＋宇宙が混在するカテゴリもあり、現行pipelineにキーワードフィルタ層がない）。
- 画像の二次利用条件は明記なし（要個別確認、おそらく自社サイト掲載前提）。
- 商業プレスワイヤは「企業が報道目的で配信した文章」という性質上コンテンツ利用自体は問題になりにくいが、SPACiANの宇宙特化という方向性に対してフィルタリングコストが見合うか要検討。優先度は低いと判断。

---

## まとめ・お願い

- **ESA Newsroom**: 上記JSONをそのまま追加で良さそう（既存JAXAパターンと同等）。
- **EurekAlert! Space**: 追加前にCategory別RSS URLを `eurekalert.org/rss.php` で確認してほしい。フィード内容の改変禁止・広告併用禁止の制約をpipeline側の処理（要約生成等）に影響しないか確認をお願いしたい。
- EUSPA・Business Wire系は現時点で見送り。

実際のenabled/priorityの最終判断や、EurekAlertのフィードURL確定後の実データでの動作確認（"本番ベース検証"）はCCにお任せします。
