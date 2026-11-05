/**
 * Proves the configured LLM works for real: `pnpm --filter @yap/api ai:check`.
 * Sends made-up data only, never anything from the database.
 * With a path, it also transcribes that audio file: `ai:check /path/to/sample.ogg`.
 */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { getProvider, transcribeAudio, type LlmBlock, type LlmMessage } from './index';

const AUDIO_TYPES: Record<string, string> = { '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav' };

const TOOL = {
  name: 'get_head_count',
  description: 'Returns how many sheep are in a herd.',
  inputSchema: { type: 'object', properties: { herd: { type: 'string' } }, required: ['herd'] },
};

async function main() {
  const provider = getProvider();
  console.log(`Provider: ${provider.name}, model: ${provider.model ?? '(none)'}`);
  if (!provider.configured) {
    console.log('Not configured. Set GEMINI_API_KEY or ANTHROPIC_API_KEY in .env.');
    process.exit(1);
  }

  const system = 'You answer questions about a farm. Use the tools for numbers. Answer in one short sentence.';
  const messages: LlmMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'How many sheep are in the herd called Test?' }] },
  ];

  const first = await provider.complete({ system, messages, tools: [TOOL], maxTokens: 500 });
  const call = first.content.find((b): b is Extract<LlmBlock, { type: 'tool_use' }> => b.type === 'tool_use');
  if (!call) throw new Error(`Expected a tool call, got ${first.stopReason}: ${JSON.stringify(first.content)}`);
  console.log(`1. Tool call: ${call.name}(${JSON.stringify(call.input)})`);

  messages.push({ role: 'assistant', content: first.content, raw: first.raw });
  messages.push({ role: 'user', content: [{ type: 'tool_result', toolUseId: call.id, content: '{"head":4321}' }] });
  const second = await provider.complete({ system, messages, tools: [TOOL], maxTokens: 500 });
  const answer = second.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  if (!answer.replace(/\D/g, '').includes('4321')) throw new Error(`The tool result did not reach the answer: ${answer}`);
  console.log(`2. Answer using the tool result: ${answer.trim()}`);

  const third = await provider.complete({
    system: 'Reply with JSON only.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Name one breed of sheep.' }] }],
    responseSchema: { type: 'object', properties: { breed: { type: 'string' } }, required: ['breed'] },
    maxTokens: 200,
  });
  const json = third.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  console.log(`3. Structured output: ${JSON.stringify(JSON.parse(json))}`);

  const sample = process.argv[2];
  if (sample) {
    const mediaType = AUDIO_TYPES[extname(sample).toLowerCase()] ?? 'audio/ogg';
    const dataBase64 = (await readFile(sample)).toString('base64');
    console.log(`4. Transcript of ${mediaType}: ${await transcribeAudio({ type: 'audio', mediaType, dataBase64 })}`);
  }

  console.log(`\nOK. ${second.model}, last call ${second.usage.inputTokens} in, ${second.usage.outputTokens} out.`);
}

main().catch((error) => {
  // The mapped message is safe but vague, so also show what actually went wrong underneath.
  const cause = error?.cause;
  const detail = cause?.cause?.code ?? cause?.code ?? cause?.message;
  console.error(`FAILED: ${error instanceof Error ? error.message : error}${detail ? ` (${detail})` : ''}`);
  process.exit(1);
});
