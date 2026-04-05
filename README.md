# 家計簿アプリ

HTML と JavaScript だけで動く家計簿アプリです。

## 主な機能

- 収入・支出の記録
- 月別集計と繰越残高
- カテゴリ別集計
- 固定費テンプレート
- 予算設定
- CSV の書き出しと読み込み
- ホーム画面追加向け PWA 対応

## ローカル起動

`start-kakeibo-app.command` を実行するか、任意の HTTP サーバーで公開してください。

## 公開

GitHub Pages で公開できます。

## 端末間同期

Supabase を使ったクラウド同期に対応しています。

1. Supabase でプロジェクトを作成する
2. `supabase/schema.sql` を SQL Editor で実行する
3. `supabase-config.js` の `enabled`, `url`, `anonKey` を設定する
4. GitHub Pages へ push する

同じメールアドレスでログインすれば、PC とスマホで同じデータを使えます。
