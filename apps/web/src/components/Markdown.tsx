import type { ReactNode } from 'react';
import { cx } from './ui';

/**
 * Renders the small subset of markdown the guide actually uses: headings, ordered and unordered
 * lists, quotes, bold, inline code and paragraphs. A full parser would be a dependency for five
 * constructs. Each block takes its direction from its own text, so the Persian guide reads right to
 * left — a Latin word inside a Persian sentence («QC», «SLA») included — and the English one left to
 * right.
 */
export function Markdown({ source }: { source: string }) {
  const blocks = source.split(/\n{2,}/);
  return (
    <div className="space-y-3 text-start text-[14px] leading-7 text-ink-700">
      {blocks.map((block, i) => {
        const lines = block.split('\n');

        if (block.startsWith('### ')) {
          return <h4 key={i} dir="auto" className="pt-1 text-[14px] font-semibold text-ink-800">{inline(block.slice(4))}</h4>;
        }
        if (/^\d+\.\s/.test(block)) {
          return (
            <ol key={i} dir="auto" className="list-decimal space-y-1.5 ps-5">
              {splitItems(lines, /^\d+\.\s/).map((item, j) => <li key={j}>{inline(item)}</li>)}
            </ol>
          );
        }
        if (block.startsWith('- ')) {
          return (
            <ul key={i} dir="auto" className="list-disc space-y-1.5 ps-5">
              {splitItems(lines, /^-\s/).map((item, j) => <li key={j}>{inline(item)}</li>)}
            </ul>
          );
        }
        if (block.startsWith('> ')) {
          return (
            <blockquote key={i} dir="auto" className="border-s-4 border-ink-200 bg-ink-50 px-3 py-2 text-ink-700">
              {lines.map((l, j) => <p key={j}>{inline(l.replace(/^>\s?/, ''))}</p>)}
            </blockquote>
          );
        }
        return <p key={i} dir="auto">{inline(block.replace(/\n/g, ' '))}</p>;
      })}
    </div>
  );
}

/** Joins continuation lines back onto their list item — the guide wraps at 100 columns. */
function splitItems(lines: string[], marker: RegExp): string[] {
  const items: string[] = [];
  for (const line of lines) {
    if (marker.test(line.trim())) items.push(line.trim().replace(marker, ''));
    else if (items.length) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items;
}

export function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} className="font-semibold text-ink-800">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={i} className="rounded bg-ink-100 px-1 py-0.5 text-[12.5px]">{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

/**
 * An assistant's reply (Hivamis task 5): the same constructs, read line by line — a model rarely
 * leaves the blank lines the guide does — in the direction of its own text.
 */
export function ChatText({ source, className }: { source: string; className?: string }) {
  const out: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  const flushPara = () => { if (para.length) { out.push(<p key={out.length}>{para.map((l, i) => <span key={i}>{i > 0 && <br />}{inline(l)}</span>)}</p>); para = []; } };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it, j) => <li key={j}>{inline(it)}</li>);
    out.push(list.ordered ? <ol key={out.length} className="list-decimal space-y-1 ps-5">{items}</ol> : <ul key={out.length} className="list-disc space-y-1 ps-5">{items}</ul>);
    list = null;
  };
  // A link the model writes is only its words: what the assistant offers to open comes as a button.
  for (const raw of source.replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, '$1').split('\n')) {
    const line = raw.trim();
    const bullet = /^[-*•]\s+/.exec(line);
    const number = /^\d+[.)]\s+/.exec(line);
    if (!line) { flushPara(); flushList(); continue; }
    if (/^#{1,4}\s/.test(line)) { flushPara(); flushList(); out.push(<p key={out.length} className="font-semibold text-ink-800">{inline(line.replace(/^#{1,4}\s/, ''))}</p>); continue; }
    if (bullet || number) {
      flushPara();
      const ordered = !!number;
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] }; }
      list.items.push(line.slice((bullet ?? number)![0].length));
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara(); flushList();
  return <div dir="auto" className={cx('space-y-2 text-sm leading-7', className)}>{out}</div>;
}
