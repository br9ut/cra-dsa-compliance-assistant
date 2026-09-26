'use client';

import { useChat } from '@ai-sdk/react';

type Source = { text?: string; page?: number; score?: number };

export default function Page() {
  const { messages, input, handleInputChange, handleSubmit, status, error } = useChat({
    api: '/api/chat',
  });

  return (
    <main className="mx-auto max-w-3xl p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Acme Spec Bot</h1>
        <p className="text-sm text-slate-500">
          Ask questions about the Acme Widget API. Sources appear under each answer.
        </p>
      </header>

      <ul className="space-y-4 mb-6 min-h-[200px]">
        {messages.map((m) => (
          <li
            key={m.id}
            className={
              m.role === 'user'
                ? 'flex justify-end'
                : 'flex justify-start flex-col items-start'
            }
          >
            <span
              className={
                m.role === 'user'
                  ? 'inline-block rounded-2xl bg-cyan-600 text-white px-4 py-2 max-w-[85%]'
                  : 'inline-block rounded-2xl bg-white border border-slate-200 px-4 py-2 max-w-[85%]'
              }
            >
              {m.content}
            </span>

            {m.role === 'assistant' &&
              m.toolInvocations?.map(
                (inv) =>
                  inv.state === 'result' &&
                  inv.toolName === 'getInformation' && (
                    <details
                      key={inv.toolCallId}
                      className="mt-2 text-sm text-slate-600 max-w-[85%]"
                    >
                      <summary className="cursor-pointer">
                        Sources ({(inv.result as Source[]).length})
                      </summary>
                      <ul className="mt-2 space-y-2">
                        {(inv.result as Source[]).map((src, i) => (
                          <li
                            key={i}
                            className="border-l-2 border-cyan-500 pl-3"
                          >
                            <span className="text-xs text-slate-400">
                              page {src.page ?? '?'} · score{' '}
                              {typeof src.score === 'number'
                                ? src.score.toFixed(2)
                                : '—'}
                            </span>
                            <p>{src.text}</p>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ),
              )}
          </li>
        ))}
        {status === 'streaming' && (
          <li className="text-sm text-slate-400">…</li>
        )}
        {error && (
          <li className="text-sm text-rose-600">
            Error: {error.message}
          </li>
        )}
      </ul>

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          value={input}
          onChange={handleInputChange}
          className="flex-1 border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:border-cyan-500"
          placeholder="Ask about authentication, rate limits, error codes…"
          disabled={status === 'streaming' || status === 'submitted'}
        />
        <button
          type="submit"
          disabled={!input || status === 'streaming' || status === 'submitted'}
          className="rounded-lg bg-slate-900 text-white px-4 py-2 disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </main>
  );
}
