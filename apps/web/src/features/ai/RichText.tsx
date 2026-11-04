import { Fragment } from 'react';
import { parseBlocks, parseInline } from './markdown';

function Inline({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((run, i) =>
        run.bold ? <strong key={i}>{run.text}</strong> : <Fragment key={i}>{run.text}</Fragment>,
      )}
    </>
  );
}

/** An answer from the assistant or a summary, rendered from structure rather than as HTML. */
export function RichText({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2 break-words">
      {parseBlocks(text).map((block, i) => {
        if (block.type === 'heading') {
          return (
            <p key={i} className="font-semibold">
              <Inline text={block.text} />
            </p>
          );
        }
        if (block.type === 'list') {
          const List = block.ordered ? 'ol' : 'ul';
          return (
            <List key={i} className={`flex flex-col gap-1 pl-5 ${block.ordered ? 'list-decimal' : 'list-disc'}`}>
              {block.items.map((item, j) => (
                <li key={j}>
                  <Inline text={item} />
                </li>
              ))}
            </List>
          );
        }
        return (
          <p key={i} className="whitespace-pre-line">
            <Inline text={block.text} />
          </p>
        );
      })}
    </div>
  );
}
