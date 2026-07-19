# 依頼: healthcheck-images.tsのLightsail crontab登録

作成: 2026-07-19
種別: 実施依頼

---

## 経緯

`cc-prompt-hero-image-fix-and-healthcheck-go.md`で実装された`healthcheck-images.ts`（heroImage URLの週次死活監視）が、Lightsailサーバー側のcrontabにまだ登録されていない。Cowork側にはサーバーへのSSH手段がなく、実施できない。

## お願いしたいこと

Lightsail本番サーバーのcrontabに、週次実行のエントリを追加してほしい。実行タイミング・ログの残し方・通知周りの細部はCCの判断で良い（以前のGOで想定していたのは週次月曜9時だが、他のcronジョブとの兼ね合いや運用上の都合があれば変更して構わない）。

登録後、実際に一度手動実行して正常終了すること、mailer経由の通知が意図通り飛ぶことを確認してほしい。

## 完了条件

- [ ] crontabに登録
- [ ] 手動実行で正常終了確認
- [ ] 通知動作確認

完了報告をCoworkに返してほしい。
