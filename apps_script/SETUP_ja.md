# メール配信のセットアップ手順（初回のみ・約10分）

登録されたメールアドレスは、あなたのGoogleドライブに作られる非公開のスプレッドシートにだけ保存されます。GitHub（公開リポジトリ）には一切入りません。
メールの送信元は、このスクリプトを設置したGoogleアカウントになります。

## 1. スクリプトを作る
1. 送信元にしたいGoogleアカウントで https://script.google.com を開き、「新しいプロジェクト」を押す
2. 左上の「無題のプロジェクト」を押して、名前を `Deal Wire mailer` に変える
3. エディタの `コード.gs` の中身を全部消して、このフォルダの `Code.gs` の中身を丸ごと貼り付け、保存する（Ctrl+S）

## 2. 初期設定を1回だけ実行する
1. 上部の関数の選択欄で `setup` を選び、「実行」を押す
2. 「承認が必要です」と出たら、自分のアカウントを選ぶ
   - 「このアプリは Google で確認されていません」と出たら、「詳細」→「Deal Wire mailer（安全ではないページ）に移動」→「許可」を押す（自分で作ったスクリプトなので問題ありません）
3. 実行ログに `Subscribers sheet: https://docs.google.com/...` と出れば完了。購読者一覧のシートが自分のドライブに作られ、30分ごとの更新設定が入ります（配信トリガーは自動では作りません。下の「閲覧申請と配信」を参照）

## 3. Webアプリとして公開する
1. 右上の「デプロイ」→「新しいデプロイ」を押す
2. 歯車アイコンの「種類の選択」で「ウェブアプリ」を選ぶ
3. 次のように設定して「デプロイ」を押す
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員**
4. 表示される「ウェブアプリのURL」（`https://script.google.com/macros/s/.../exec`）をコピーして、Claudeに渡す

最後の手順は、渡されたURLを使ってClaudeが行います。URLを `docs/app.js` の `MAIL_ENDPOINT` に入れて公開すると、サイトに「✉」ボタンと、初めて開いた人向けの登録画面が出るようになります。

## 運用メモ
- 送信数の上限: 無料のGmailアカウントからは1日100通までです。1日3回配信する場合、購読者は約30人までが目安です
- 購読者の確認・削除: 作られたスプレッドシートを直接見れば分かります。status列が `active` の人にだけ送られます
- 配信の開始: 関数 `setupMailTrigger` を1回実行すると、`sendNewEdition` の10分トリガーが重複なく作られます
- 配信の停止: スクリプトエディタの「トリガー」（時計のアイコン）で `sendNewEdition` を削除すると止まります

## 閲覧申請と配信（2026-10-30〜、1つの流れ）
- 友人は申請ページ `（/exec のURL）?action=request` でメールアドレスを送ります。オーナーに Approve / Decline のメールが届き、リンク先の確認ページでボタンを押すと実行されます
- Approve すると、Apps Script が Cloudflare API で Access ポリシー `Approved readers` の Emails に追加し、本人に案内メールを送ります。失敗したときは status が `error` になり、オーナーにメールが届きます
- メール配信は、`Approved readers` に入っている人だけがサイト内のフォームから申し込めます。配信時にも「今も入っているか」を確認するので、Cloudflare で外すと配信も止まります
- Script Properties に `CF_API_TOKEN`（Access ポリシーを編集できるAPIトークン）と `CF_ACCOUNT_ID` を入れます
- 以前からの購読者は `pauseExistingSubscribers` を1回実行して `paused` にし、戻す人は `approveReader('アドレス')` のあと `approveExisting('アドレス')`。まとめては `requestApprovalForPaused`
- 外す人: `revokeReader('アドレス')`（ポリシーから外し、配信を paused に）

## Contact / Inquiry ボックスを有効にする

サイト下部の「Contact / Inquiry」は `Code.gs` の `action=contact` に投げています。
**Code.gs を更新したら、Apps Script で「デプロイを管理」→ 鉛筆アイコン →「バージョン」を
「新バージョン」にして「デプロイ」**を押してください。/exec の URL は変わりません。

送信先は `Session.getEffectiveUser().getEmail()`、つまりこのスクリプトの所有者です。
公開リポジトリにメールアドレスは書かれていません。

- 返信用のアドレスが入力されていれば Reply-To に入ります
- 1日40通を上限にしています（`CONTACT_MAX_PER_DAY`）
- 画面に見えない `website` 欄はボット除けで、埋まっていたら送信しません
