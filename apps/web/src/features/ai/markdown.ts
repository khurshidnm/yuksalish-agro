export type Block =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] };

const BULLET = /^\s*[-*•]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;
const HEADING = /^\s*#{1,4}\s+/;

/**
 * The small part of Markdown the assistant uses, turned into structure. Text is rendered as text,
 * never as HTML, so nothing in an answer can inject markup.
 */
export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  for (const line of text.split('\n')) {
    const last = blocks[blocks.length - 1];
    if (line.trim() === '') {
      blocks.push({ type: 'paragraph', text: '' });
    } else if (HEADING.test(line)) {
      blocks.push({ type: 'heading', text: line.replace(HEADING, '') });
    } else if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = NUMBERED.test(line);
      const item = line.replace(ordered ? NUMBERED : BULLET, '');
      if (last?.type === 'list' && last.ordered === ordered) last.items.push(item);
      else blocks.push({ type: 'list', ordered, items: [item] });
    } else if (last?.type === 'paragraph' && last.text !== '') {
      last.text += `\n${line}`;
    } else {
      blocks.push({ type: 'paragraph', text: line });
    }
  }
  return blocks.filter((block) => block.type !== 'paragraph' || block.text !== '');
}

/** "**bold** rest" becomes [{ text: 'bold', bold: true }, { text: ' rest', bold: false }]. */
export function parseInline(text: string): { text: string; bold: boolean }[] {
  return text
    .split(/(\*\*[^*]+\*\*)/)
    .filter(Boolean)
    .map((part) =>
      part.startsWith('**') && part.endsWith('**') && part.length > 4
        ? { text: part.slice(2, -2), bold: true }
        : { text: part, bold: false },
    );
}
