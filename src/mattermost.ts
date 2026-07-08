// @mattermost/client は CommonJS。named export (Client4/WebSocketClient) は
// Node ESM 実行時に undefined になる (cjs-module-lexer が Object.defineProperty ゲッターを
// 検出できない) ため、default import (= module.exports) から取り出す。ビルドだけでは
// 気づけない実行時クラッシュになるので必ず default 経由にする。
import mattermostClient from '@mattermost/client';
const { Client4, WebSocketClient } = mattermostClient;
type Client4Instance = InstanceType<typeof Client4>;
import type { Post } from '@mattermost/types/posts';
import { readFileSync } from 'fs';
import { basename } from 'path';
import type { Config } from './config.js';
import type { AgentRunner } from './agent-runner.js';
import type { Scheduler } from './scheduler.js';
import { runWithBubbleEvents } from './bubble-events-runner.js';
import { StreamSession, type StreamView } from './stream-session.js';
import {
  ensureSession,
  archiveSession,
  getActiveSessionId,
  getProviderSessionId,
} from './sessions.js';
import { threadIdFor, turnIdFor } from './events-emitter.js';
import { splitMessage } from './message-split.js';
import { formatAgentErrorForUser } from './errors.js';
import { registerStreamFinalizer } from './stream-finalizer.js';
import {
  buildAttachmentResult,
  buildPromptWithAttachments,
  downloadFile,
} from './file-utils.js';

/** Mattermost メッセージの最大文字数 (サーバ既定 16383)。安全マージンを取る。 */
const MATTERMOST_MAX_MESSAGE = 16_000;

/** 処理済み post id (WebSocket の再送・重複配信対策)。上限で古いものから間引く。 */
const processedPostIds = new Set<string>();

/** チャンネル単位の直列実行キュー。別チャンネルの発話が Agent 完了を待たないようにする。 */
const chatQueues = new Map<string, Promise<unknown>>();

/**
 * contextKey 単位でタスクを直列化する。先発タスクの完了後に後発を実行するため、
 * 同一チャンネルで Agent が二重起動しない。別チャンネルは並行に進む。
 */
export function enqueueForChat<T = void>(contextKey: string, task: () => Promise<T>): Promise<T> {
  const prev = chatQueues.get(contextKey) ?? Promise.resolve();
  const next = prev.then(task, task);
  // キューの鎖が reject で切れないよう、保持用は握りつぶす
  chatQueues.set(
    contextKey,
    next.then(
      () => undefined,
      () => undefined
    )
  );
  return next;
}

/**
 * Bot トークンをログ・エラーメッセージから伏字化する。
 * トークン片が外部に漏れないよう、adapter が出す文字列は必ずこれを通す。
 */
export function redactMattermostSecrets(text: string, token?: string): string {
  if (!token) return text;
  return text.split(token).join('***');
}

/**
 * contextKey を決める。会話の直列/並列とセッション（メモリ）の境界がこれで決まる。
 * - DM: チャンネル単位（トップレベル発言でも 1 会話として継続する）。
 * - チャンネル: スレッド(root_id)単位。別スレッドは別 contextKey になり、
 *   キューが分かれる＝**並列実行**され、セッション（会話メモリ）も独立する。
 *   トップレベル発言は自分の post.id を root にした新スレッド扱い。
 */
export function mattermostContextKey(
  channelId: string,
  opts?: { channelType?: string; rootId?: string }
): string {
  if (opts?.channelType === 'D' || !opts?.rootId) {
    return `mattermost:channel:${channelId}`;
  }
  return `mattermost:thread:${channelId}:${opts.rootId}`;
}

/** `wss://.../api/v4/websocket` を得る。Client4.getWebSocketUrl は http(s) スキームで返すため変換する。 */
export function toWebsocketUrl(httpWebsocketUrl: string): string {
  return httpWebsocketUrl.replace(/^http/, 'ws');
}

/** 先頭の @botname メンションを取り除く。 */
export function stripBotMention(text: string, botUsername: string): string {
  const re = new RegExp(`@${botUsername}\\b`, 'gi');
  return text.replace(re, '').replace(/\s{2,}/g, ' ').trim();
}

/** @botname を含むか。 */
export function hasBotMention(text: string, botUsername: string): boolean {
  return new RegExp(`@${botUsername}\\b`, 'i').test(text);
}

/** リセット系コマンドか。 */
export function isResetCommand(text: string, patterns: readonly string[]): boolean {
  const t = text.trim().toLowerCase();
  return patterns.some((p) => t === p.toLowerCase());
}

/**
 * この post に応答すべきか判定する (純粋関数・テスト対象)。
 * - 自分自身 / 他 Bot の投稿は無視
 * - allowlist ('*' で全員) を満たす人間のみ
 * - DM は常に応答。チャンネルは @メンション or auto-reply 指定 or セッション継続中のみ
 */
export function shouldProcessMattermostPost(params: {
  senderUserId: string;
  botUserId: string;
  isBot: boolean;
  channelType: string; // 'D'|'O'|'P'|'G'
  channelId: string;
  text: string;
  botUsername: string;
  allowedUsers?: string[];
  autoReplyChannels?: string[];
  isSessionActive?: boolean;
}): boolean {
  const {
    senderUserId,
    botUserId,
    isBot,
    channelType,
    channelId,
    text,
    botUsername,
    allowedUsers = [],
    autoReplyChannels = [],
    isSessionActive = false,
  } = params;

  // 1. 自分自身・Bot の投稿は無視 (Bot 同士のループ防止)
  if (senderUserId === botUserId) return false;
  if (isBot) return false;

  // 2. allowlist 検証
  const allowAll = allowedUsers.includes('*');
  if (!allowAll && !allowedUsers.includes(senderUserId)) return false;

  // 3. DM ('D') は常に応答
  if (channelType === 'D') return true;

  // 4. チャンネル: メンション / auto-reply / セッション継続中
  if (hasBotMention(text, botUsername)) return true;
  if (autoReplyChannels.includes(channelId)) return true;
  if (isSessionActive) return true;

  return false;
}

/** WebSocket メッセージの最低限の形 (巨大な union を避けて緩く扱う)。 */
interface RawWsMessage {
  event?: string;
  data?: Record<string, unknown>;
  broadcast?: { channel_id?: string };
}

/**
 * 生成物ファイルを Mattermost にアップロードして投稿する。
 * uploadFile → file_id を得て createPost({file_ids}) の 2 段構え。
 */
async function uploadAndPostFile(
  client: Client4Instance,
  channelId: string,
  filePath: string,
  rootId: string,
  logSecret?: string
): Promise<void> {
  const buf = readFileSync(filePath);
  const filename = basename(filePath);
  const form = new FormData();
  form.append('channel_id', channelId);
  form.append('files', new Blob([new Uint8Array(buf)]), filename);
  // uploadFile は FormData を受ける (型は any)
  const res = await client.uploadFile(form);
  const fileId = res.file_infos?.[0]?.id;
  if (!fileId) {
    console.warn('[xangi-mattermost] uploadFile returned no file id for', filename);
    return;
  }
  await client.createPost({
    channel_id: channelId,
    message: '',
    root_id: rootId,
    file_ids: [fileId],
  } as Parameters<Client4Instance['createPost']>[0]);
  console.log(
    redactMattermostSecrets(`[xangi-mattermost] Uploaded file: ${filename}`, logSecret)
  );
}

/**
 * 受信 post の添付ファイルをローカルに落とし、パス一覧を返す (best-effort)。
 * 失敗したファイルはスキップして続行する。
 */
async function downloadIncomingFiles(
  serverUrl: string,
  token: string,
  post: Post
): Promise<string[]> {
  const fileIds = post.file_ids ?? [];
  if (fileIds.length === 0) return [];
  const metaFiles =
    (post.metadata as { files?: Array<{ id: string; name?: string }> } | undefined)?.files ?? [];
  const paths: string[] = [];
  for (const id of fileIds) {
    try {
      const name = metaFiles.find((f) => f.id === id)?.name ?? `attachment_${id}`;
      const url = `${serverUrl.replace(/\/$/, '')}/api/v4/files/${id}`;
      const p = await downloadFile(url, name, { Authorization: `Bearer ${token}` });
      paths.push(p);
    } catch (err) {
      console.warn(`[xangi-mattermost] Failed to download file ${id}:`, (err as Error).message);
    }
  }
  return paths;
}

/**
 * Mattermost Bot を起動する。
 * - REST は Client4、リアルタイムは WebSocketClient (自動再接続あり)。
 * - post 受信 → allowlist 判定 → チャンネル単位キューで Agent 実行 → post 編集でストリーミング。
 */
export async function startMattermostBot(opts: {
  config: Config;
  agentRunner: AgentRunner;
  scheduler: Scheduler;
}): Promise<void> {
  const { config, agentRunner, scheduler } = opts;
  const mcfg = config.mattermost;

  if (!mcfg.enabled || !mcfg.serverUrl || !mcfg.botToken) {
    return;
  }
  const serverUrl = mcfg.serverUrl.replace(/\/$/, '');
  const token = mcfg.botToken;

  const client = new Client4();
  client.setUrl(serverUrl);
  client.setToken(token);

  const me = await client.getMe();
  const botUserId = me.id;
  const botUsername = me.username;
  console.log(
    `[xangi-mattermost] Ready! Logged in as @${botUsername} (${botUserId}) on ${serverUrl}`
  );
  console.log(
    `[xangi-mattermost] Auto-reply channels: ${mcfg.autoReplyChannels?.join(', ') || '(none)'}`
  );

  // スケジューラ: 定期投稿の送信口を登録
  scheduler.registerSender('mattermost', async (channelId, msg) => {
    const chunks = splitMessage(msg, MATTERMOST_MAX_MESSAGE);
    for (const chunk of chunks) {
      await client.createPost({ channel_id: channelId, message: chunk } as Parameters<
        Client4Instance['createPost']
      >[0]);
    }
  });

  const streaming = mcfg.streaming !== false;
  const showThinking = mcfg.showThinking !== false;
  const resetPatterns = mcfg.resetTextPatterns ?? ['/reset', '/new', '/clear'];

  // ── メッセージ処理 ─────────────────────────────────────────────
  const handlePost = async (
    post: Post,
    channelType: string,
    senderName: string
  ): Promise<void> => {
    const postKey = post.id;
    if (processedPostIds.has(postKey)) return;
    processedPostIds.add(postKey);
    if (processedPostIds.size > 10_000) {
      const it = processedPostIds.values();
      for (let i = 0; i < 2_000; i++) {
        const v = it.next().value;
        if (v !== undefined) processedPostIds.delete(v);
      }
    }

    const channelId = post.channel_id;
    // スレッド内発言はそのスレッドに、トップレベルは発言 post を root にして返信する。
    // この rootId が contextKey（＝直列/並列・セッション境界）を決める。
    const rootId = post.root_id || post.id;
    const contextKey = mattermostContextKey(channelId, { channelType, rootId });
    const isBot = (post.props?.from_bot === 'true' || post.props?.from_bot === true) ?? false;
    const rawText = (post.message ?? '').trim();

    const isSessionActive = channelType !== 'D' && !!getActiveSessionId(contextKey);

    const shouldRespond = shouldProcessMattermostPost({
      senderUserId: post.user_id,
      botUserId,
      isBot,
      channelType,
      channelId,
      text: rawText,
      botUsername,
      allowedUsers: mcfg.allowedUsers,
      autoReplyChannels: mcfg.autoReplyChannels,
      isSessionActive,
    });
    if (!shouldRespond) return;

    const mentioned = hasBotMention(rawText, botUsername);
    const cleanText = mentioned ? stripBotMention(rawText, botUsername) : rawText;

    // リセットコマンド
    if (isResetCommand(cleanText, resetPatterns)) {
      const activeId = getActiveSessionId(contextKey);
      if (activeId) archiveSession(activeId);
      ensureSession(contextKey, { platform: 'mattermost' });
      await client
        .createPost({
          channel_id: channelId,
          message: '新しく会話を始めます。',
          root_id: rootId,
        } as Parameters<Client4Instance['createPost']>[0])
        .catch(() => {});
      return;
    }

    // 停止コマンド (キューを経由せず即時キャンセル)
    if (cleanText.toLowerCase() === '/stop' || cleanText.toLowerCase() === 'stop') {
      agentRunner.cancel?.(contextKey);
      await client
        .createPost({
          channel_id: channelId,
          message: '実行を停止しました。',
          root_id: rootId,
        } as Parameters<Client4Instance['createPost']>[0])
        .catch(() => {});
      return;
    }

    // 受信添付を取り込み、プロンプトに付与
    const attachmentPaths = await downloadIncomingFiles(serverUrl, token, post);
    let promptBody = cleanText;
    if (!promptBody && attachmentPaths.length === 0) return;
    if (attachmentPaths.length > 0) {
      promptBody = buildPromptWithAttachments(promptBody || '(添付ファイル)', attachmentPaths);
    }

    const threadLabel =
      channelType === 'D' ? `Mattermost DM (${senderName})` : `Mattermost #${channelId}`;
    const promptText = `[プラットフォーム: Mattermost]\n[チャンネル: ${channelId}]${
      post.root_id ? `\n[スレッド: ${post.root_id}]` : ''
    }\n[発言者: ${senderName}]\n${promptBody}`;

    const appSessionId = ensureSession(contextKey, { platform: 'mattermost' });

    // 初期メッセージ (考え中...) を投稿してから編集していく
    let thinkingPostId = '';
    if (showThinking) {
      try {
        const created = await client.createPost({
          channel_id: channelId,
          message: '考え中...',
          root_id: rootId,
        } as Parameters<Client4Instance['createPost']>[0]);
        thinkingPostId = created.id;
      } catch (err) {
        console.error(
          redactMattermostSecrets(
            `[xangi-mattermost] Failed to post thinking message: ${(err as Error).message}`,
            token
          )
        );
        return;
      }
    }

    let streamSession: StreamSession | null = null;
    let streamFinished = false;
    let editsPaused = false;
    const finishStream = () => {
      if (streamSession && !streamFinished) {
        streamSession.finish();
        streamFinished = true;
      }
    };

    let unregisterFinalizer = () => {};
    if (thinkingPostId) {
      unregisterFinalizer = registerStreamFinalizer(async () => {
        finishStream();
        const note = '⏸ プロセス再起動により中断されました';
        const body = streamSession?.lastText
          ? `${streamSession.lastText.trimEnd()}\n\n${note}`
          : note;
        await client
          .patchPost({ id: thinkingPostId, message: body.slice(0, MATTERMOST_MAX_MESSAGE) })
          .catch(() => {});
      });
    }

    await enqueueForChat(contextKey, async () => {
      try {
        const render = async (view: StreamView) => {
          if (!thinkingPostId || editsPaused) return;
          const toolPart = view.toolLines.length > 0 ? '\n' + view.toolLines.join('\n') : '';
          let display: string;
          if (view.phase === 'thinking') {
            display = view.statusLine + toolPart;
          } else {
            display = (view.text ? `${view.text} ▌` : '▌') + toolPart;
          }
          if (!display.trim()) display = '考え中...';
          try {
            await client.patchPost({
              id: thinkingPostId,
              message: display.slice(0, MATTERMOST_MAX_MESSAGE),
            });
          } catch (err) {
            editsPaused = true;
            console.warn(
              '[xangi-mattermost] Streaming edits paused after API error; final edit will still be attempted:',
              (err as Error).message
            );
          }
        };

        if (streaming && showThinking) {
          streamSession = new StreamSession({
            render,
            tickMs: 1000,
            streamUpdateIntervalMs: 1000,
            formatToolLine: (toolName) => `▸ ${toolName}`,
          });
          streamSession.start();
        }

        let runResult: { result?: string; attachments?: string[] } | null = null;
        let runError: unknown = null;
        try {
          runResult = await runWithBubbleEvents(
            agentRunner,
            promptText,
            {
              threadId: threadIdFor('mattermost', contextKey),
              turnId: turnIdFor('mattermost', post.id),
              threadLabel,
              platform: 'mattermost',
              userText: promptBody,
            },
            streamSession ? streamSession.callbacks() : {},
            {
              channelId: contextKey,
              appSessionId,
              sessionId: getProviderSessionId(contextKey),
              skipPermissions: config.agent.config.skipPermissions ?? false,
            }
          );
        } catch (err) {
          runError = err;
          console.error('[xangi-mattermost] Run error:', err);
        } finally {
          finishStream();
        }

        const rawAnswer = runError
          ? formatAgentErrorForUser(runError)
          : runResult?.result || '✅';

        // 生成物ファイルを本文から分離
        const { filePaths, displayText } = runError
          ? { filePaths: [] as string[], displayText: rawAnswer }
          : buildAttachmentResult(rawAnswer, runResult?.attachments);

        const chunks = splitMessage(displayText || '✅', MATTERMOST_MAX_MESSAGE);

        // 最終回答: 考え中メッセージを編集 (冪等)、残りは新規 post
        if (thinkingPostId) {
          await client
            .patchPost({ id: thinkingPostId, message: chunks[0] || '✅' })
            .catch((err) =>
              console.error('[xangi-mattermost] Failed to edit final answer:', (err as Error).message)
            );
          for (let i = 1; i < chunks.length; i++) {
            await client
              .createPost({
                channel_id: channelId,
                message: chunks[i],
                root_id: rootId,
              } as Parameters<Client4Instance['createPost']>[0])
              .catch(() => {});
          }
        } else {
          for (const chunk of chunks) {
            await client
              .createPost({
                channel_id: channelId,
                message: chunk,
                root_id: rootId,
              } as Parameters<Client4Instance['createPost']>[0])
              .catch(() => {});
          }
        }

        // 添付ファイルを送信
        for (const fp of filePaths) {
          try {
            await uploadAndPostFile(client, channelId, fp, rootId, token);
          } catch (err) {
            console.error('[xangi-mattermost] Failed to upload file:', (err as Error).message);
          }
        }
      } finally {
        finishStream();
        unregisterFinalizer();
      }
    });
  };

  // ── WebSocket 接続 ─────────────────────────────────────────────
  const ws = new WebSocketClient({
    // Node 22 のグローバル WebSocket を使う (ブラウザ WebSocket 互換 API)。
    // Node と DOM の WebSocket 型差を吸収するため設定オブジェクトごとキャストする。
    newWebSocketFn: (url: string) => new WebSocket(url),
  } as unknown as ConstructorParameters<typeof WebSocketClient>[0]);

  ws.addFirstConnectListener(() => console.log('[xangi-mattermost] WebSocket connected'));
  ws.addReconnectListener(() => console.log('[xangi-mattermost] WebSocket reconnected'));
  ws.addCloseListener((failCount) =>
    console.warn(`[xangi-mattermost] WebSocket closed (failCount=${failCount})`)
  );

  ws.addMessageListener((raw) => {
    const msg = raw as unknown as RawWsMessage;
    if (msg.event !== 'posted' || !msg.data) return;
    let post: Post;
    try {
      post = JSON.parse(String(msg.data.post)) as Post;
    } catch {
      return;
    }
    const channelType = String(msg.data.channel_type ?? '');
    const senderName = String(msg.data.sender_name ?? '');
    void handlePost(post, channelType, senderName).catch((err) =>
      console.error(
        redactMattermostSecrets(`[xangi-mattermost] handlePost error: ${err}`, token)
      )
    );
  });

  ws.initialize(toWebsocketUrl(client.getWebSocketUrl()), token);
}

/** テスト用に内部状態をリセットする。 */
export function _resetMattermostStateForTest(): void {
  processedPostIds.clear();
  chatQueues.clear();
}
