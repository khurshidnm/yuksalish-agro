import { describe, expect, it } from 'vitest';
import { parseSse } from './chat-stream';
import { parseBlocks, parseInline } from './markdown';

describe('parseBlocks', () => {
  it('reads paragraphs, headings and lists', () => {
    expect(parseBlocks('Salom\nyana\n\n## Sarlavha\n- bir\n- ikki\n\n1. uch\n2) tort')).toEqual([
      { type: 'paragraph', text: 'Salom\nyana' },
      { type: 'heading', text: 'Sarlavha' },
      { type: 'list', ordered: false, items: ['bir', 'ikki'] },
      { type: 'list', ordered: true, items: ['uch', 'tort'] },
    ]);
  });

  it('accepts the bullet used in summaries', () => {
    expect(parseBlocks('• bir')).toEqual([{ type: 'list', ordered: false, items: ['bir'] }]);
  });

  it('treats markup as plain text', () => {
    expect(parseBlocks('<img src=x onerror=alert(1)>')).toEqual([{ type: 'paragraph', text: '<img src=x onerror=alert(1)>' }]);
  });
});

describe('parseInline', () => {
  it('finds bold runs', () => {
    expect(parseInline('oldin **muhim** keyin')).toEqual([
      { text: 'oldin ', bold: false },
      { text: 'muhim', bold: true },
      { text: ' keyin', bold: false },
    ]);
  });

  it('leaves unmatched stars alone', () => {
    expect(parseInline('2 * 3 **')).toEqual([{ text: '2 * 3 **', bold: false }]);
  });
});

describe('parseSse', () => {
  it('returns complete messages and keeps the unfinished part', () => {
    const { messages, rest } = parseSse('event: tool_start\ndata: {"name":"a"}\n\nevent: do');
    expect(messages).toEqual([{ event: 'tool_start', data: { name: 'a' } }]);
    expect(rest).toBe('event: do');
  });

  it('survives a message split across chunks', () => {
    const first = parseSse('event: done\ndata: {"ok"');
    expect(first.messages).toEqual([]);
    const second = parseSse(`${first.rest}:true}\n\n`);
    expect(second.messages).toEqual([{ event: 'done', data: { ok: true } }]);
  });
});
