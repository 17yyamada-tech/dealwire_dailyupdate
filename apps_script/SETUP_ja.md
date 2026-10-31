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

## アカウント同期を有効にする（同じメールでログインした端末どうしで☆・企業・×を共有）

PC と iPad など、同じメールアドレスで Cloudflare Access にログインしている端末の間で、☆（フォロー）、Companies の企業リスト（キーワードと Fund / Corporate の切り替えを含む）、× で消した記事が共有されます。表示や言語・絞り込み・学習・既読・メール設定は端末ごとのままです。
設定が済むまでは今までどおり（端末ごとの登録）で動くので、順番どおりに進めれば途中で壊れることはありません。

### 0. SYNC_SECRET を作る
PowerShell で次の1行を実行し、出た64文字（英数字）をコピーしておきます。これを手順2と手順3の2か所に同じ値で登録します。他人に見せたり、チャットやファイルに書いたりしないでください。
```
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ($b | ForEach-Object { $_.ToString('x2') }) -join ''
```

### 1. Code.gs を貼り替えて新バージョンを公開する
1. https://script.google.com で `Deal Wire mailer` を開き、エディタの `コード.gs` を全部消して、このフォルダの `Code.gs` を丸ごと貼り付けて保存（Ctrl+S）
2. 右上の「デプロイ」→「デプロイを管理」→ 鉛筆アイコン →「バージョン」を「新バージョン」にして「デプロイ」（/exec の URL は変わりません）

### 2. Apps Script のスクリプトプロパティに SYNC_SECRET を入れる
1. 左の歯車「プロジェクトの設定」→ 下の「スクリプト プロパティ」→「スクリプト プロパティを追加」
2. プロパティ `SYNC_SECRET`、値は手順0で作った文字列。「スクリプト プロパティを保存」

### 3. Cloudflare Pages に4つの値を登録する
1. Cloudflare ダッシュボード →「Workers & Pages」→ `dealwire` →「Settings」→「Variables and Secrets」→「Add」
2. 次の4つを、**Production と Preview の両方**に登録します（画面の切り替えで2回ずつ）

| 名前 | 種類 | 値 |
|---|---|---|
| `CF_ACCESS_TEAM_DOMAIN` | Text | チーム名。Access のログイン画面の URL `https://○○○.cloudflareaccess.com/...` の `○○○` の部分（`○○○.cloudflareaccess.com` と書いても通ります） |
| `CF_ACCESS_AUD` | Text | Zero Trust →「Access」→「Applications」で `dealwire.pages.dev` のアプリを開き、「Additional settings」付近（または Overview）にある「Application Audience (AUD) Tag」。**`*.dealwire.pages.dev`（プレビュー）のアプリにも別の AUD があるので、2つをカンマで区切って**入れる（例 `aaaa...,bbbb...`）。どちらか1つだけでも本番は動きます |
| `APPS_SCRIPT_URL` | Text | Apps Script の `/exec` で終わる URL（`app.js` の `MAIL_ENDPOINT` と同じもの） |
| `SYNC_SECRET` | Secret | 手順0で作った文字列（手順2と同じ値） |

### 4. Pages を再デプロイする
環境変数は「次のデプロイから」反映されます。「Deployments」→ 一番上のデプロイの「…」→「Retry deployment」を押します（効かない場合は Claude に「何か1つ commit して push して」と頼めば再デプロイされます）。`functions/` の中継プログラムは、このリポジトリを push した時点で一緒にデプロイされています。

### 5. 動作確認
1. ブラウザで `https://dealwire.pages.dev/api/me` を開く（ログイン済みの状態で）。`{"ok":true,"email":"あなたのアドレス","sync":true}` と出れば成功。`not_configured`（503）なら手順3・4が未完了、`bad_aud` なら AUD の値の取り違えです
2. サイトの右上 ⚙（Settings）に `Synced as あなたのアドレス` と1行出ることを確認
3. PC で好きな記事に ☆ を付け、iPad でサイトを開く（または開いたままタブに戻る）。数秒以内に iPad の Deals に同じ記事が出れば共有されています。PC で☆を外すと iPad からも消え、他の端末の古いリストから復活することはありません
4. 初めて同じアカウントで入った端末は、その端末にあった☆と企業がアカウント側のものと合わさります（重複は除かれ、☆20件・企業15社を超える分は新しいものが優先）

### うまくいかないとき
- Settings に `Synced as` が出ない → `/api/me` の応答を確認（上の1）。サイト自体は端末ごとの登録のまま動き続けます
- `(offline, will retry)` と出る → Apps Script への中継に失敗しています。`SYNC_SECRET` の値が手順2と手順3で一致しているか、Code.gs を「新バージョン」で公開したかを確認
- スプレッドシートに `Accounts` シートが自動で作られ、1アカウント1行で保存されます（同期の履歴確認に使えます）

