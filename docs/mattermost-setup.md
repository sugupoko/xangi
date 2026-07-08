# Mattermost セットアップ

xangi を Mattermost で動かすための手順。Slack/Telegram と同じく、Bot アカウントの
アクセストークン 1 本とサーバ URL があれば動きます（公開エンドポイント不要・WebSocket 接続）。

## 1. Bot アカウントを作る

1. Mattermost に管理者でログインし、**System Console → Integrations → Bot Accounts** を開く。
2. **Bot Accounts** が `true` になっていることを確認（無効なら有効化）。
3. **Add Bot Account** で Bot を作成（例: `aichan`）。
4. 発行される **Access Token** を控える（これが `MATTERMOST_BOT_TOKEN`）。トークンは一度しか表示されないので注意。

> 補足: System Console を触れない場合、`System Console → Integrations → Integration Management` で
> 「Enable Personal Access Tokens」を有効化し、対象ユーザーのアカウント設定 → セキュリティ →
> パーソナルアクセストークンで発行する方法でも可。

## 2. Bot をチャンネルに追加する

Bot は追加されたチャンネルの投稿しか受け取れません。使いたいチャンネルで
`/invite @aichan`（Bot のユーザー名）を実行して参加させます。DM はそのまま送れます。

## 3. 反応させるユーザーの User ID を調べる

`MATTERMOST_ALLOWED_USER` には **ユーザー名ではなく User ID** を入れます（全員許可なら `*`）。

- 相手のプロフィール → **Copy User ID**、または
- API: `GET {SERVER_URL}/api/v4/users/username/{username}`（`Authorization: Bearer {token}`）の `id`

## 4. 環境変数を設定する

`.env` に以下を設定します（`.env.example` の Mattermost 節も参照）。

```bash
MATTERMOST_SERVER_URL=https://mattermost.example.com   # 末尾スラッシュ不要
MATTERMOST_BOT_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxx
MATTERMOST_ALLOWED_USER=your_user_id                   # "*" で全員許可
# 任意
MATTERMOST_AUTO_REPLY_CHANNELS=channel_id_1,channel_id_2  # メンション無しでも反応するチャンネル
MATTERMOST_STREAMING=true        # 応答を逐次編集で表示（default: true）
MATTERMOST_SHOW_THINKING=true    # 「考え中...」表示（default: true）
MATTERMOST_RESET_TEXT_PATTERNS=/reset,/new,/clear
```

`MATTERMOST_SERVER_URL` と `MATTERMOST_BOT_TOKEN` の両方が揃うと Mattermost 連携が有効化されます。

## 5. 起動と使い方

`npm start`（または pm2 / Docker）で起動すると、ログに次のように出ます。

```
[xangi-mattermost] Ready! Logged in as @aichan (xxxx) on https://mattermost.example.com
[xangi-mattermost] WebSocket connected
```

- **DM**: そのまま話しかければ応答します。
- **チャンネル**: `@aichan` とメンションすると応答します（`MATTERMOST_AUTO_REPLY_CHANNELS`
  指定チャンネルはメンション不要）。
- **停止**: 実行中に `stop` または `/stop` を送ると現在のタスクを中断します。
- **セッションリセット**: `/new` `/reset` `/clear` で会話を最初から始めます。
- **ファイル**: 応答に `MEDIA:/絶対パス` が含まれると、そのファイルを添付として投稿します。
  ユーザーが添付したファイルもダウンロードしてエージェントに渡されます。

## 制限事項（現状）

- インタラクティブボタン（Stop/延長ボタン）は未対応。停止はテキストコマンドで行います。
- スラッシュコマンド登録（Mattermost の `/` コマンド）は未対応。
