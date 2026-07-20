# 修正依頼: NSFフォーラムのmsg ID抽出バグ

作成: 2026-07-20
種別: バグ修正依頼

---

## 経緯

Oracles Phase 2完了報告を受け、Cowork側でChromeを使い実際のNSFフォーラムスレッド（`https://forum.nasaspaceflight.com/index.php?topic=63390.0`）を開いてDOM構造を検証した。セレクタ自体（`.post_wrapper`・`.poster h4 a`・`.inner`）は正しく機能することを確認できたが、1件バグを見つけた。

## 確認できたこと

1つの投稿（`.post_wrapper`）内には、`id`が`msg_`で始まる要素が複数存在する。

```
msg_2709552_extra_info
msg_2709552_quick_mod
msg_2709552
msg_2709552_signature
```

DOM順で最初に来るのは`msg_2709552_extra_info`であり、これはメタ情報用の要素で本体の投稿IDではない。`src/oracle-extract.ts`の

```ts
const msgDiv = $(el).find("[id^='msg_']").first();
const msgId = msgDiv.attr("id")?.replace("msg_", "") ?? "";
```

は`.first()`でこの`msg_2709552_extra_info`を拾ってしまい、`msgId`が`"2709552_extra_info"`になる。これにより、

- `WatchTarget.lastItemId`との比較（差分取得）が正しく機能しない
- 生成される投稿URLが`?topic=X.msg2709552_extra_info#msg2709552_extra_info`のような不正な形になる

## お願いしたいこと

`id`が`/^msg_\d+$/`に完全一致する要素だけを選ぶよう修正してほしい（例: `$(el).find("[id^='msg_']").filter((_, e) => /^msg_\d+$/.test(e.attribs.id))`のような形）。実装方法はCCの判断で良い。

修正後、実際に候補が生成される際のsourceUrlが正しい形式になっていることを確認してほしい。
