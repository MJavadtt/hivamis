import type { ChatConversationSummary, ChatMemberRole, ChatMessageView, ChatNotify } from '@hiva/contracts';
import { RECORD_CODE, RECORD_PAGES } from '@hiva/contracts';

/**
 * Team chat (audit F-5), the page's side: the shapes the API answers with, and how a message's text
 * becomes pieces — plain words, a record it names (a link, if this reader may open it), a person.
 */

export type ConversationSummary = ChatConversationSummary;
export type MessageView = ChatMessageView;
export interface ConversationDetail {
  id: string; kind: ChatConversationSummary['kind']; title: string; topic: string | null; archived: boolean; createdAt: string;
  peer: { id: string; fullName: string } | null;
  me: { role: ChatMemberRole; muted: boolean; notify: ChatNotify; lastReadAt: string | null };
  members: { id: string; fullName: string; jobTitle: string | null; avatarUrl?: string | null; role: ChatMemberRole; joinedAt: string }[];
}
export interface RecordRef { type: string; id: string; title: string }
export interface MessagePage { items: MessageView[]; hasMore: boolean; records: Record<string, RecordRef> }

export type Piece =
  | { kind: 'text'; text: string }
  | { kind: 'record'; text: string; path: string; title: string }
  | { kind: 'person'; text: string };

/** A message's text in pieces: codes the reader may open become links; the people it names stand out. */
export function pieces(body: string, records: Record<string, RecordRef>, names: string[]): Piece[] {
  const marks: { at: number; end: number; piece: Piece }[] = [];
  for (const m of body.matchAll(RECORD_CODE)) {
    const r = records[m[0]];
    const page = r && RECORD_PAGES[r.type];
    if (r && page) marks.push({ at: m.index!, end: m.index! + m[0].length, piece: { kind: 'record', text: m[0], path: `${page}/${r.id}`, title: r.title } });
  }
  for (const name of names.filter(Boolean)) {
    const token = `@${name}`;
    for (let i = body.indexOf(token); i >= 0; i = body.indexOf(token, i + token.length)) {
      if (!marks.some((x) => i < x.end && i + token.length > x.at)) marks.push({ at: i, end: i + token.length, piece: { kind: 'person', text: token } });
    }
  }
  marks.sort((a, b) => a.at - b.at);
  const out: Piece[] = [];
  let at = 0;
  for (const m of marks) {
    if (m.at > at) out.push({ kind: 'text', text: body.slice(at, m.at) });
    out.push(m.piece);
    at = m.end;
  }
  if (at < body.length) out.push({ kind: 'text', text: body.slice(at) });
  return out;
}

/** A name's first letter, for the round mark beside it. */
export const initial = (name: string) => name.trim().replace(/^(سید|سیده)\s+/, '').charAt(0) || '؟';
