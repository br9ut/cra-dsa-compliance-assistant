'use client';

import { Fragment, type ReactNode } from 'react';
import { useChat } from '@ai-sdk/react';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const SEARCH_TOOLS = ['searchRegulations', 'getInformation'];

const SUGGESTED_QUESTIONS = [
  'When must a manufacturer report an actively exploited vulnerability under the CRA?',
  'Who does the Norwegian Digital Security Act apply to?',
  'What must a risk assessment include under digitalsikkerhetsforskriften?',
  'Compare incident reporting in the CRA and the Norwegian Digital Security Regulation.',
];

const CORPUS = [
  {
    name: 'Cyber Resilience Act',
    detail: 'Regulation (EU) 2024/2847 · English',
    url: 'https://eur-lex.europa.eu/eli/reg/2024/2847/oj',
  },
  {
    name: 'Digitalsikkerhetsloven',
    detail: 'Norwegian Digital Security Act · Norwegian',
    url: 'https://lovdata.no/dokument/NL/lov/2023-12-20-108?q=digitalsikkerhetsloven',
  },
  {
    name: 'Digitalsikkerhetsforskriften',
    detail: 'Norwegian Digital Security Regulation · Norwegian',
    url: 'https://lovdata.no/dokument/SF/forskrift/2025-06-20-1131?q=digitalsikkerhetsforskriften',
  },
];

type Source = {
  text?: string;
  doc?: string;
  section?: string;
  sectionTitle?: string;
  page?: number | null;
  url?: string;
  score?: number;
};

type ToolInvocationLike = {
  state: string;
  toolName: string;
  toolCallId: string;
  result?: unknown;
};

// ---------------------------------------------------------------------------
// Lightweight, safe formatting (no HTML injection, no extra dependency)
// Supports: **bold**, ### headings, bullet and numbered lists, [citations]
// ---------------------------------------------------------------------------
const CITATION = /^\[[^\]]*(CRA|Digitalsikkerhets|Article|Recital|Annex|§)[^\]]*\]$/;

function renderInline(text: string): ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*|\[[^\]]+\])/g)
    .filter(Boolean)
    .map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={i}>{part.slice(2, -2)}</strong>;
      }
      if (CITATION.test(part)) {
        return (
          <span
            key={i}
            className="mx-0.5 inline-block whitespace-nowrap rounded bg-cyan-50 px-1.5 py-0.5 text-xs font-medium text-cyan-800"
          >
            {part.slice(1, -1)}
          </span>
        );
      }
      return <Fragment key={i}>{part}</Fragment>;
    });
}

type ListItem = { text: string; sub: string[] };
type ListBlock = { ordered: boolean; start: number; items: ListItem[] };

function FormattedText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: ListBlock | null = null;

  const flush = () => {
    if (!list) return;
    const items = list.items.map((item, i) => (
      <li key={i}>
        {renderInline(item.text)}
        {item.sub.length > 0 && (
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {item.sub.map((s, j) => (
              <li key={j}>{renderInline(s)}</li>
            ))}
          </ul>
        )}
      </li>
    ));
    blocks.push(
      list.ordered ? (
        <ol key={blocks.length} start={list.start} className="list-decimal space-y-1 pl-5">
          {items}
        </ol>
      ) : (
        <ul key={blocks.length} className="list-disc space-y-1 pl-5">
          {items}
        </ul>
      ),
    );
    list = null;
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const indented = /^\s{2,}/.test(raw);
    let m: RegExpMatchArray | null;

    if (!line) {
      flush();
      continue;
    }
    if ((m = line.match(/^#{1,6}\s+(.*)$/))) {
      flush();
      blocks.push(
        <h3 key={blocks.length} className="mt-2 font-semibold text-slate-900">
          {renderInline(m[1])}
        </h3>,
      );
      continue;
    }
    if ((m = line.match(/^[-*•]\s+(.*)$/))) {
      const current: ListBlock | null = list;
      if (indented && current && current.items.length > 0) {
        current.items[current.items.length - 1].sub.push(m[1]);
      } else {
        if (!current || current.ordered) {
          flush();
          list = { ordered: false, start: 1, items: [] };
        }
        (list as ListBlock | null)?.items.push({ text: m[1], sub: [] });
      }
      continue;
    }
    if ((m = line.match(/^(\d+)[.)]\s+(.*)$/))) {
      const current: ListBlock | null = list;
      if (!current || !current.ordered) {
        flush();
        // Keep the model's numbering even if a blank line split the list
        list = { ordered: true, start: parseInt(m[1], 10), items: [] };
      }
      (list as ListBlock | null)?.items.push({ text: m[2], sub: [] });
      continue;
    }
    flush();
    blocks.push(<p key={blocks.length}>{renderInline(line)}</p>);
  }
  flush();

  return <div className="space-y-2">{blocks}</div>;
}

// ---------------------------------------------------------------------------
// Sources: merge all search calls in one answer, remove duplicates, sort
// ---------------------------------------------------------------------------
function collectSources(invocations: ToolInvocationLike[] | undefined): Source[] {
  const byText = new Map<string, Source>();
  for (const inv of invocations ?? []) {
    if (inv.state !== 'result' || !SEARCH_TOOLS.includes(inv.toolName)) continue;
    for (const src of (inv.result as Source[]) ?? []) {
      const key = src.text ?? '';
      const existing = byText.get(key);
      if (!existing || (src.score ?? 0) > (existing.score ?? 0)) byText.set(key, src);
    }
  }
  return [...byText.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

function splitSource(src: Source): { label: string; body: string } {
  const text = src.text ?? '';
  const nl = text.indexOf('\n');
  if (src.section && nl > 0) return { label: text.slice(0, nl), body: text.slice(nl + 1) };
  return { label: `Page ${src.page ?? '?'}`, body: text };
}

function SourcesPanel({ sources }: { sources: Source[] }) {
  if (sources.length === 0) return null;
  return (
    <details className="mt-2 w-full max-w-[90%] text-sm text-slate-600 sm:max-w-[85%]">
      <summary className="cursor-pointer select-none font-medium text-slate-700">
        Sources ({sources.length})
      </summary>
      <ul className="mt-2 space-y-2">
        {sources.map((src, i) => {
          const { label, body } = splitSource(src);
          return (
            <li key={i} className="rounded-lg border border-slate-200 bg-white">
              <details>
                <summary className="flex cursor-pointer items-start justify-between gap-3 px-3 py-2">
                  <span className="font-medium text-slate-800">{label}</span>
                  <span className="shrink-0 text-xs text-slate-400">
                    {src.page ? `p. ${src.page} · ` : ''}
                    {typeof src.score === 'number' ? `match ${src.score.toFixed(2)}` : ''}
                  </span>
                </summary>
                <div className="border-t border-slate-100 px-3 py-2">
                  <p className="whitespace-pre-line text-slate-600">{body}</p>
                  {src.url && (
                    <a
                      href={src.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2 inline-block text-xs font-medium text-cyan-700 hover:underline"
                    >
                      Open official text ↗
                    </a>
                  )}
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------
function EmptyState({ onAsk }: { onAsk: (q: string) => void }) {
  return (
    <div className="space-y-6 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">
          Ask about product and organisational cybersecurity rules
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Answers are drawn only from the official texts below, with a citation for every key point.
          Ask in English or Norwegian.
        </p>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Try a question
        </h3>
        <div className="grid gap-2 sm:grid-cols-2">
          {SUGGESTED_QUESTIONS.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => onAsk(q)}
              className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-left text-sm text-slate-700 transition hover:border-cyan-500 hover:bg-cyan-50"
            >
              {q}
            </button>
          ))}
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          What the assistant knows
        </h3>
        <ul className="space-y-1 text-sm">
          {CORPUS.map((d) => (
            <li key={d.name}>
              <a
                href={d.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-cyan-700 hover:underline"
              >
                {d.name}
              </a>{' '}
              <span className="text-slate-500">– {d.detail}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function Page() {
  const { messages, input, handleInputChange, handleSubmit, status, error, append, setMessages } =
    useChat({ api: '/api/chat' });

  const busy = status === 'streaming' || status === 'submitted';
  const ask = (q: string) => {
    if (!busy) append({ role: 'user', content: q });
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col px-4 sm:px-6">
      <header className="flex items-start justify-between gap-4 py-5">
        <div>
          <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">CRA &amp; Digital Security Act Assistant</h1>
          <p className="text-sm text-slate-500">
            EU Cyber Resilience Act and Norwegian digitalsikkerhetsloven, with cited sources.
          </p>
        </div>
        {messages.length > 0 && (
          <button
            type="button"
            onClick={() => setMessages([])}
            disabled={busy}
            className="shrink-0 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-40"
          >
            New chat
          </button>
        )}
      </header>

      <section className="flex-1 pb-4">
        {messages.length === 0 ? (
          <EmptyState onAsk={ask} />
        ) : (
          <ul className="space-y-5">
            {messages.map((m) => {
              const invocations = m.toolInvocations as ToolInvocationLike[] | undefined;
              const searching =
                m.role === 'assistant' && !m.content && (invocations ?? []).some((i) => i.state !== 'result');
              return (
                <li
                  key={m.id}
                  className={m.role === 'user' ? 'flex justify-end' : 'flex flex-col items-start'}
                >
                  {m.role === 'user' ? (
                    <span className="inline-block max-w-[90%] rounded-2xl bg-cyan-600 px-4 py-2 text-white sm:max-w-[85%]">
                      {m.content}
                    </span>
                  ) : (
                    <>
                      {(m.content || searching) && (
                        <div className="max-w-[90%] rounded-2xl border border-slate-200 bg-white px-4 py-3 text-slate-800 sm:max-w-[85%]">
                          {m.content ? (
                            <FormattedText text={m.content} />
                          ) : (
                            <span className="text-sm text-slate-400">Searching the regulations…</span>
                          )}
                        </div>
                      )}
                      <SourcesPanel sources={collectSources(invocations)} />
                    </>
                  )}
                </li>
              );
            })}
            {status === 'submitted' && <li className="text-sm text-slate-400">Thinking…</li>}
          </ul>
        )}
        {error && (
          <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
            Something went wrong. Please try again in a moment.
          </p>
        )}
      </section>

      <div className="sticky bottom-0 border-t border-slate-200 bg-slate-50/95 py-3 backdrop-blur">
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            value={input}
            onChange={handleInputChange}
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 focus:border-cyan-500 focus:outline-none"
            placeholder="Ask about reporting, scope, security requirements…"
            disabled={busy}
          />
          <button
            type="submit"
            disabled={!input.trim() || busy}
            className="rounded-lg bg-slate-900 px-4 py-2 text-white disabled:opacity-40"
          >
            Send
          </button>
        </form>
        <p className="mt-2 text-center text-xs text-slate-400">
          Information only, not legal advice. Always check the official text before making decisions.
        </p>
      </div>
    </main>
  );
}
