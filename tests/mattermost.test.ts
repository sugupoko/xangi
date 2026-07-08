import { describe, it, expect } from 'vitest';
import {
  hasBotMention,
  isResetCommand,
  mattermostContextKey,
  redactMattermostSecrets,
  shouldProcessMattermostPost,
  stripBotMention,
  toWebsocketUrl,
} from '../src/mattermost.js';

describe('toWebsocketUrl', () => {
  it('converts https to wss', () => {
    expect(toWebsocketUrl('https://mm.example.com/api/v4/websocket')).toBe(
      'wss://mm.example.com/api/v4/websocket'
    );
  });
  it('converts http to ws', () => {
    expect(toWebsocketUrl('http://localhost:8065/api/v4/websocket')).toBe(
      'ws://localhost:8065/api/v4/websocket'
    );
  });
});

describe('mattermostContextKey', () => {
  it('keys by channel id', () => {
    expect(mattermostContextKey('abc123')).toBe('mattermost:channel:abc123');
  });
});

describe('redactMattermostSecrets', () => {
  it('masks the bot token', () => {
    expect(redactMattermostSecrets('failed with token=secretxyz here', 'secretxyz')).toBe(
      'failed with token=*** here'
    );
  });
  it('is a no-op without a token', () => {
    expect(redactMattermostSecrets('plain text')).toBe('plain text');
  });
});

describe('bot mention helpers', () => {
  it('detects @botname', () => {
    expect(hasBotMention('hey @aichan can you help', 'aichan')).toBe(true);
    expect(hasBotMention('no mention here', 'aichan')).toBe(false);
  });
  it('strips the mention and collapses spaces', () => {
    expect(stripBotMention('@aichan  hello there', 'aichan')).toBe('hello there');
  });
});

describe('isResetCommand', () => {
  const patterns = ['/reset', '/new', '/clear'];
  it('matches known reset patterns case-insensitively', () => {
    expect(isResetCommand('/new', patterns)).toBe(true);
    expect(isResetCommand('/RESET', patterns)).toBe(true);
    expect(isResetCommand('hello', patterns)).toBe(false);
  });
});

describe('shouldProcessMattermostPost', () => {
  const base = {
    senderUserId: 'user1',
    botUserId: 'bot1',
    isBot: false,
    channelId: 'chan1',
    botUsername: 'aichan',
    allowedUsers: ['user1'],
    autoReplyChannels: [] as string[],
  };

  it('ignores the bot itself', () => {
    expect(
      shouldProcessMattermostPost({ ...base, senderUserId: 'bot1', channelType: 'D', text: 'hi' })
    ).toBe(false);
  });

  it('ignores other bots', () => {
    expect(
      shouldProcessMattermostPost({ ...base, isBot: true, channelType: 'D', text: 'hi' })
    ).toBe(false);
  });

  it('ignores users not in the allowlist', () => {
    expect(
      shouldProcessMattermostPost({
        ...base,
        senderUserId: 'stranger',
        channelType: 'D',
        text: 'hi',
      })
    ).toBe(false);
  });

  it('allows any user when allowlist contains *', () => {
    expect(
      shouldProcessMattermostPost({
        ...base,
        senderUserId: 'stranger',
        allowedUsers: ['*'],
        channelType: 'D',
        text: 'hi',
      })
    ).toBe(true);
  });

  it('always responds in DMs', () => {
    expect(shouldProcessMattermostPost({ ...base, channelType: 'D', text: 'hi' })).toBe(true);
  });

  it('responds in a channel only when mentioned', () => {
    expect(shouldProcessMattermostPost({ ...base, channelType: 'O', text: 'random chatter' })).toBe(
      false
    );
    expect(
      shouldProcessMattermostPost({ ...base, channelType: 'O', text: 'hey @aichan help' })
    ).toBe(true);
  });

  it('responds in auto-reply channels without a mention', () => {
    expect(
      shouldProcessMattermostPost({
        ...base,
        channelType: 'O',
        text: 'no mention',
        autoReplyChannels: ['chan1'],
      })
    ).toBe(true);
  });

  it('continues an active channel session without a mention', () => {
    expect(
      shouldProcessMattermostPost({
        ...base,
        channelType: 'O',
        text: 'follow up',
        isSessionActive: true,
      })
    ).toBe(true);
  });
});
