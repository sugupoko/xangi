/**
 * Mattermost 固有の xangi ルール。
 *
 * Mattermost は Markdown 対応・ファイル添付対応なので、Discord/Slack と同様に
 * MEDIA: での添付送信が使える。停止・リセットはテキストコマンドで行う
 * (インタラクティブボタンは未対応)。
 */
export const XANGI_COMMANDS_MATTERMOST = `## Mattermost 固有ルール

- 応答は Markdown が使える（見出し・コードブロック・リスト等）。
- 画像・音声・ファイルを送るときは応答テキストに \`MEDIA:/絶対パス\` を書くと添付として送信される（拡張子制限なし）。
- 実行中のタスクを止めたいときユーザーは \`stop\` と送れる（Mattermost は "/" 始まりを横取りするため \`/stop\` は届かない）。
- \`リセット\` \`reset\` \`clear\` \`newchat\` で会話セッションをリセットできる（"/" 始まりは使えない）。
- チャンネルでは @メンションされたときに反応する（DM は常に反応）。`;
