import { ApiError, FinishReason, type GenerateContentParameters, type GenerateContentResponse } from '@google/genai';
import { DEFAULT_ROLE_PERMISSIONS } from '@yap/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { tx } from '../src/core/context';
import { schema } from '../src/db/client';
import { chooseProvider, setProvider, transcribeAudio, type LlmMessage, type LlmProvider, type LlmTool } from '../src/modules/ai/provider';
import { ClaudeProvider } from '../src/modules/ai/provider/claude';
import { DEFAULT_GEMINI_MODEL, GeminiProvider, type GeminiClient } from '../src/modules/ai/provider/gemini';
import { createFixture } from './helpers';

type Reply = Partial<GenerateContentResponse> | Error;

/** Stands in for Google: records what was sent and plays back scripted replies. */
function stub(...replies: Reply[]) {
  const sent: GenerateContentParameters[] = [];
  const client: GeminiClient = {
    models: {
      async generateContent(params) {
        // A snapshot: the caller keeps appending to its message list between rounds.
        sent.push(structuredClone(params));
        const reply = replies.shift();
        if (!reply) throw new Error('no scripted reply left');
        if (reply instanceof Error) throw reply;
        return reply as GenerateContentResponse;
      },
    },
  };
  return { client, sent, provider: new GeminiProvider({ client }) };
}

const textReply = (text: string): Reply => ({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: FinishReason.STOP }],
});
const callReply = (name: string, args: Record<string, unknown>, extra: object = {}): Reply => ({
  candidates: [{ content: { role: 'model', parts: [{ functionCall: { name, args }, ...extra }] }, finishReason: FinishReason.STOP }],
});

const TOOL: LlmTool = { name: 'herd_summary', description: 'Herd', inputSchema: { type: 'object', properties: {} } };
const ask = (text: string): LlmMessage[] => [{ role: 'user', content: [{ type: 'text', text }] }];

describe('Gemini request', () => {
  it('sends the instructions, tools and limits in Gemini form', async () => {
    const { provider, sent } = stub(textReply('Salom'));
    await provider.complete({ system: 'Stable rules', context: 'Today is 2026-11-04', messages: ask('Salom'), tools: [TOOL], maxTokens: 8000 });
    const [request] = sent;
    expect(request.model).toBe(DEFAULT_GEMINI_MODEL);
    expect(request.config?.systemInstruction).toBe('Stable rules\n\nToday is 2026-11-04');
    expect(request.contents).toEqual([{ role: 'user', parts: [{ text: 'Salom' }] }]);
    expect(request.config?.tools).toEqual([
      { functionDeclarations: [{ name: 'herd_summary', description: 'Herd', parametersJsonSchema: TOOL.inputSchema }] },
    ]);
  });

  it('leaves room for thinking, which counts against the output limit', async () => {
    const { provider, sent } = stub(textReply('ok'));
    await provider.complete({ system: 's', messages: ask('q'), maxTokens: 2000 });
    // 2 000 for the answer plus 3 × the 1 024 thinking budget.
    expect(sent[0].config?.maxOutputTokens).toBe(5072);
    expect(sent[0].config?.thinkingConfig).toEqual({ thinkingBudget: 1024 });
  });

  it('asks for JSON when a schema is given', async () => {
    const { provider, sent } = stub(textReply('{}'));
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    await provider.complete({ system: 's', messages: ask('q'), responseSchema: schema });
    expect(sent[0].config?.responseMimeType).toBe('application/json');
    expect(sent[0].config?.responseJsonSchema).toEqual(schema);
    expect(sent[0].config?.tools).toBeUndefined();
  });

  it('sends images and PDFs inline', async () => {
    const { provider, sent } = stub(textReply('ok'));
    await provider.complete({
      system: 's',
      messages: [{ role: 'user', content: [
        { type: 'image', mediaType: 'image/png', dataBase64: 'AAA' },
        { type: 'document', mediaType: 'application/pdf', dataBase64: 'BBB' },
      ] }],
    });
    expect((sent[0].contents as any)[0].parts).toEqual([
      { inlineData: { mimeType: 'image/png', data: 'AAA' } },
      { inlineData: { mimeType: 'application/pdf', data: 'BBB' } },
    ]);
  });
});

describe('audio', () => {
  const voice = { type: 'audio' as const, mediaType: 'audio/ogg', dataBase64: 'T2dnUw==' };

  afterEach(() => setProvider(undefined));

  it('Gemini receives audio inline, next to the text', async () => {
    const { provider, sent } = stub(textReply('ok'));
    await provider.complete({ system: 's', messages: [{ role: 'user', content: [voice, { type: 'text', text: 'Yozib ol' }] }] });
    expect((sent[0].contents as any)[0].parts).toEqual([
      { inlineData: { mimeType: 'audio/ogg', data: 'T2dnUw==' } },
      { text: 'Yozib ol' },
    ]);
  });

  it('Claude says plainly that it cannot read audio, and never calls the API', async () => {
    let calls = 0;
    const provider = new ClaudeProvider({
      client: { beta: { messages: { create: async () => { calls++; return {}; } } } },
    });
    await expect(
      provider.complete({ system: 's', messages: [{ role: 'user', content: [voice] }] }),
    ).rejects.toMatchObject({ status: 501, code: 'AI_AUDIO_NOT_SUPPORTED' });
    expect(calls).toBe(0);
  });

  it('transcribes through whichever provider is set, asking for JSON', async () => {
    const { provider, sent } = stub(textReply('{"speechHeard":true,"transcript":"  yoqilg\'iga 3 mln naqd to\'ladim  "}'));
    setProvider(provider);
    expect(await transcribeAudio(voice)).toBe("yoqilg'iga 3 mln naqd to'ladim");
    expect(sent[0].config?.responseMimeType).toBe('application/json');
    expect((sent[0].contents as any)[0].parts[0]).toEqual({ inlineData: { mimeType: 'audio/ogg', data: 'T2dnUw==' } });
  });

  it('an empty transcript means nothing was heard, not a failure', async () => {
    setProvider(stub(textReply('{"speechHeard":true,"transcript":""}')).provider);
    expect(await transcribeAudio(voice)).toBe('');
  });

  it('words alongside "no speech heard" are dropped: Gemini was seen inventing them for silence', async () => {
    setProvider(stub(textReply('{"speechHeard":false,"transcript":"shularni bir ko\'rib chiqing."}')).provider);
    expect(await transcribeAudio(voice)).toBe('');
  });

  it.each([
    ['a cut-off transcript, which could lose part of an amount', { candidates: [{ content: { role: 'model', parts: [{ text: '{"transcript":"3"}' }] }, finishReason: FinishReason.MAX_TOKENS }] }],
    ['a refusal', { promptFeedback: { blockReason: 'SAFETY' } as never }],
    ['anything but the agreed JSON', textReply('Here is the transcript: 3 mln')],
    ['JSON without a transcript', textReply('{"text":"3 mln"}')],
  ])('%s is an error, never a shorter message', async (_name, reply) => {
    setProvider(stub(reply as Reply).provider);
    await expect(transcribeAudio(voice)).rejects.toMatchObject({ code: 'AI_TRANSCRIPTION_FAILED' });
  });

  it('with no provider configured it reports that', async () => {
    const off: LlmProvider = { name: 'none', model: null, configured: false, complete: async () => { throw new Error('unreachable'); } };
    setProvider(off);
    await expect(transcribeAudio(voice)).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' });
  });
});

describe('Gemini tool loop', () => {
  async function roundTrip(first: Reply) {
    const { provider, sent } = stub(first, textReply('500 bosh'));
    const messages = ask('Nechta qo\'y bor?');
    const response = await provider.complete({ system: 's', messages, tools: [TOOL] });
    expect(response.stopReason).toBe('tool_use');
    const call = response.content[0] as { type: 'tool_use'; id: string; name: string };
    messages.push({ role: 'assistant', content: response.content, raw: response.raw });
    messages.push({ role: 'user', content: [{ type: 'tool_result', toolUseId: call.id, content: '{"head":500}' }] });
    await provider.complete({ system: 's', messages, tools: [TOOL] });
    return (sent[1].contents as any[]);
  }

  it('replays the model turn untouched, so its thought signature survives', async () => {
    const contents = await roundTrip(callReply('herd_summary', { herd: 'A' }, { thoughtSignature: 'SIGNATURE-123' }));
    expect(contents[1]).toEqual({
      role: 'model',
      parts: [{ functionCall: { name: 'herd_summary', args: { herd: 'A' } }, thoughtSignature: 'SIGNATURE-123' }],
    });
  });

  it('names the function in its result, and keeps our own ids to ourselves', async () => {
    const contents = await roundTrip(callReply('herd_summary', {}));
    expect(contents[2].role).toBe('user');
    expect(contents[2].parts).toEqual([{ functionResponse: { name: 'herd_summary', response: { output: '{"head":500}' } } }]);
  });

  it('echoes an id Gemini did give', async () => {
    const reply: Reply = {
      candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'call-7', name: 'herd_summary', args: {} } }] }, finishReason: FinishReason.STOP }],
    };
    const contents = await roundTrip(reply);
    expect(contents[2].parts[0].functionResponse.id).toBe('call-7');
  });

  it('marks a failed tool as an error, and keeps parallel calls apart', async () => {
    const reply: Reply = {
      candidates: [{ content: { role: 'model', parts: [
        { functionCall: { name: 'one', args: {} } },
        { functionCall: { name: 'two', args: {} } },
      ] }, finishReason: FinishReason.STOP }],
    };
    const { provider, sent } = stub(reply, textReply('ok'));
    const messages = ask('q');
    const response = await provider.complete({ system: 's', messages });
    const [a, b] = response.content as { id: string }[];
    expect(a.id).not.toBe(b.id);
    messages.push({ role: 'assistant', content: response.content, raw: response.raw });
    messages.push({ role: 'user', content: [
      { type: 'tool_result', toolUseId: a.id, content: 'first' },
      { type: 'tool_result', toolUseId: b.id, content: 'boom', isError: true },
    ] });
    await provider.complete({ system: 's', messages });
    expect((sent[1].contents as any[])[2].parts.map((p: any) => p.functionResponse)).toEqual([
      { name: 'one', response: { output: 'first' } },
      { name: 'two', response: { error: 'boom' } },
    ]);
  });
});

describe('Gemini response', () => {
  it('hides thinking from the answer', async () => {
    const { provider } = stub({
      candidates: [{ content: { role: 'model', parts: [{ text: 'secret reasoning', thought: true }, { text: 'Javob' }] }, finishReason: FinishReason.STOP }],
    });
    const response = await provider.complete({ system: 's', messages: ask('q') });
    expect(response.content).toEqual([{ type: 'text', text: 'Javob' }]);
  });

  it.each([
    [FinishReason.STOP, 'end'],
    [FinishReason.MAX_TOKENS, 'max_tokens'],
    [FinishReason.SAFETY, 'refusal'],
    [FinishReason.PROHIBITED_CONTENT, 'refusal'],
    [FinishReason.RECITATION, 'refusal'],
    [FinishReason.MALFORMED_FUNCTION_CALL, 'other'],
  ])('%s is reported as %s', async (finishReason, expected) => {
    const { provider } = stub({ candidates: [{ content: { role: 'model', parts: [{ text: 'x' }] }, finishReason }] });
    expect((await provider.complete({ system: 's', messages: ask('q') })).stopReason).toBe(expected);
  });

  it('a cut-off turn never counts as a tool call', async () => {
    const { provider } = stub({
      candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'herd_summary', args: {} } }] }, finishReason: FinishReason.MAX_TOKENS }],
    });
    expect((await provider.complete({ system: 's', messages: ask('q') })).stopReason).toBe('max_tokens');
  });

  it('a blocked prompt with no answer is a refusal, not a crash', async () => {
    const { provider } = stub({ promptFeedback: { blockReason: 'SAFETY' } as never });
    const response = await provider.complete({ system: 's', messages: ask('q') });
    expect(response.stopReason).toBe('refusal');
    expect(response.content).toEqual([]);
  });

  it('counts thinking as output and cached tokens separately', async () => {
    const { provider } = stub({
      candidates: [{ content: { role: 'model', parts: [{ text: 'x' }] }, finishReason: FinishReason.STOP }],
      modelVersion: 'gemini-3.5-flash-001',
      usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 400, candidatesTokenCount: 50, thoughtsTokenCount: 200 },
    });
    const response = await provider.complete({ system: 's', messages: ask('q') });
    expect(response.usage).toEqual({ inputTokens: 600, outputTokens: 250, cacheReadTokens: 400 });
    expect(response.model).toBe('gemini-3.5-flash-001');
  });
});

describe('Gemini errors', () => {
  it.each([
    [new ApiError({ status: 429, message: 'quota' }), 429, 'AI_PROVIDER_BUSY'],
    [new ApiError({ status: 403, message: 'denied' }), 503, 'AI_PROVIDER_AUTH'],
    [new ApiError({ status: 400, message: 'API key not valid. Please pass a valid API key.' }), 503, 'AI_PROVIDER_AUTH'],
    [new ApiError({ status: 500, message: 'internal' }), 502, 'AI_PROVIDER_ERROR'],
    [new TypeError('fetch failed'), 503, 'AI_PROVIDER_UNREACHABLE'],
  ])('%s', async (error, status, code) => {
    const { provider } = stub(error);
    await expect(provider.complete({ system: 's', messages: ask('q') })).rejects.toMatchObject({ status, code });
  });
});

describe('Gemini error mapping', () => {
  it('a bug is not disguised as the provider being down', async () => {
    const { provider } = stub(new TypeError("Cannot read properties of undefined (reading 'parts')"));
    await expect(provider.complete({ system: 's', messages: ask('q') })).rejects.toBeInstanceOf(TypeError);
  });
});

describe('choosing a provider', () => {
  it('follows the key that is set', () => {
    expect(chooseProvider({ GEMINI_API_KEY: 'g' }, false)).toBe('gemini');
    expect(chooseProvider({ ANTHROPIC_API_KEY: 'a' }, false)).toBe('claude');
    expect(chooseProvider({}, false)).toBeNull();
    expect(chooseProvider({ GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '' }, false)).toBeNull();
  });

  it('with both keys, AI_PROVIDER decides, and Gemini is the default', () => {
    const both = { GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' };
    expect(chooseProvider(both, false)).toBe('gemini');
    expect(chooseProvider({ ...both, AI_PROVIDER: 'claude' }, false)).toBe('claude');
  });

  it('a provider asked for without its key is off, not silently swapped', () => {
    expect(chooseProvider({ AI_PROVIDER: 'gemini', ANTHROPIC_API_KEY: 'a' }, false)).toBeNull();
    expect(chooseProvider({ AI_PROVIDER: 'claude', GEMINI_API_KEY: 'g' }, false)).toBeNull();
    expect(chooseProvider({ AI_PROVIDER: 'typo', GEMINI_API_KEY: 'g' }, false)).toBeNull();
  });

  it('production refuses Gemini until the key is declared paid (spec 15.2)', () => {
    expect(chooseProvider({ GEMINI_API_KEY: 'g' }, true)).toBeNull();
    expect(chooseProvider({ GEMINI_API_KEY: 'g', GEMINI_PAID_TIER: 'yes' }, true)).toBeNull();
    expect(chooseProvider({ GEMINI_API_KEY: 'g', GEMINI_PAID_TIER: 'true' }, true)).toBe('gemini');
    expect(chooseProvider({ ANTHROPIC_API_KEY: 'a' }, true)).toBe('claude');
  });
});

describe('the assistant running on Gemini', () => {
  afterEach(() => setProvider(undefined));

  it('completes a tool loop end to end, and offers a shepherd no money tools', async () => {
    const f = await createFixture();
    const { provider, sent } = stub(callReply('herd_summary', {}, { thoughtSignature: 'SIG' }), textReply('Fermada 0 bosh bor.'));
    setProvider(provider);
    await f.run(() =>
      tx()
        .update(schema.roles)
        .set({ permissions: [...DEFAULT_ROLE_PERMISSIONS.shepherd, 'ai.view'] })
        .where(eq(schema.roles.id, f.roleIds.shepherd)),
    );
    const shepherd = await f.as('shepherd');
    const res = await shepherd.post('/ai/chat', { message: 'Nechta qo\'y bor?' });
    expect(res.status).toBe(200);
    expect(res.data.message.text).toBe('Fermada 0 bosh bor.');
    expect(res.data.message.toolCalls.map((c: any) => c.name ?? c.tool)).toEqual(['herd_summary']);

    const offered = (sent[0].config?.tools as any)[0].functionDeclarations.map((d: any) => d.name);
    expect(offered).toContain('herd_summary');
    expect(offered).not.toContain('cash_position');
    // Every tool schema must be what Gemini accepts: an object at the top level.
    for (const declaration of (sent[0].config?.tools as any)[0].functionDeclarations) {
      expect(declaration.parametersJsonSchema.type).toBe('object');
    }
    // The second round replays the signature and returns the tool output as a function response.
    const [, modelTurn, toolTurn] = sent[1].contents as any[];
    expect(modelTurn.parts[0].thoughtSignature).toBe('SIG');
    expect(toolTurn.parts[0].functionResponse.name).toBe('herd_summary');
  });
});
