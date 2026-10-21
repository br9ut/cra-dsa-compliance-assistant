/**
 * Chat route: RAG as a tool call over the live sources in lib/sources.ts
 * (EU and Norwegian cybersecurity legislation, plus related guidance as
 * batches are added).
 *
 * The model decides when to call searchRegulations. The tool runs a vector
 * search in Upstash (optionally filtered to one document or source type) and
 * returns chunk text plus citation metadata. The client renders these as
 * sources.
 */
import { openai } from '@ai-sdk/openai';
import { streamText, tool, embed } from 'ai';
import { Index } from '@upstash/vector';
import { z } from 'zod';
import { ACTIVE_SOURCES, SOURCE_TYPE_LABEL, versionLabel, type SourceType } from '@/lib/sources';

const index = new Index();

// Chat model: gpt-4o-mini unless CHAT_MODEL is set (server-side only, e.g.
// CHAT_MODEL=gpt-4o for an evaluation run). Embeddings are unaffected.
const CHAT_MODEL = process.env.CHAT_MODEL?.trim() || 'gpt-4o-mini';
// Optional, e.g. CHAT_REASONING_EFFORT=none: gpt-6 models only accept function
// tools on Chat Completions with reasoning switched off
const CHAT_REASONING_EFFORT = process.env.CHAT_REASONING_EFFORT?.trim();

const TOP_K = 6;
// Upstash's approximate search can miss the true best matches when asked for
// few results (measured: 0 of the top 6 for short Norwegian queries such as
// "varslingsplikt" at 6 and even 50 candidates; exact from 100), so rank 100
// candidates by id and score, then fetch text only for the best TOP_K
const CANDIDATES = 100;
const DOC_NAMES = ACTIVE_SOURCES.map((s) => s.short);
const SOURCE_TYPES = [...new Set(ACTIVE_SOURCES.map((s) => s.sourceType))];

// Section expansion settings
const EXPAND_FROM_TOP = TOP_K; // look at all results for split sections
const MAX_SECTIONS_TO_EXPAND = 3; // expand at most 3 sections per search
const MAX_PARTS_PER_SECTION = 10; // cap on parts fetched per section
const PART_TAG = /\[part \d+\/\d+\]/;

const esc = (s: string) => s.replace(/'/g, "\\'");
const partNo = (text: unknown) => {
  const m = typeof text === 'string' ? text.match(/\[part (\d+)\/\d+\]/) : null;
  return m ? parseInt(m[1], 10) : 0;
};

const LANG_NAME = { en: 'English', no: 'Norwegian' } as const;

const sourceList = ACTIVE_SOURCES.map((s, i) => {
  const notes = [
    LANG_NAME[s.lang],
    s.binding ? '' : `${SOURCE_TYPE_LABEL[s.sourceType].toLowerCase()}, not legally binding`,
    versionLabel(s),
  ].filter(Boolean);
  return `${i + 1}. ${s.short} – ${s.description} (${notes.join('; ')})`;
}).join('\n');

const hasNonBinding = ACTIVE_SOURCES.some((s) => !s.binding);
const versionedSources = ACTIVE_SOURCES.filter((s) => versionLabel(s));
const scopeNotes = ACTIVE_SOURCES.filter((s) => s.scopeNote).map((s) => `- ${s.scopeNote}`);

const SYSTEM_PROMPT = [
  `You are a compliance assistant that answers questions about these sources:
${sourceList}

How to answer:
- Always call the searchRegulations tool before answering a question about these sources. For comparisons or broad questions, call it several times with focused queries (for example once per law or per topic). Search first and write the answer afterwards; do not announce or describe your searches in the answer.
- Answer ONLY from the retrieved text. If the retrieved text does not answer the question, say so plainly and suggest how the user could rephrase. Never fill gaps with general knowledge.
- Cite every key statement inline in square brackets using the source name and section from the source header, for example [CRA – Article 14] or [Digitalsikkerhetsloven – § 2]. Use only sections that appear in the retrieved results, and attach each tag to the provision that actually contains the statement: a detail from one provision (for example a deadline set in a regulation) must never be cited to another. This applies in every language, including answers in Norwegian: a section number in a heading, in the running text or in a closing list of sources is not a citation, so each key statement still needs its own tag in square brackets. Example of a cited line in a Norwegian answer: "- Tilbyderen skal varsle uten unødig opphold [Digitalsikkerhetsloven – § 8]."
- Answer in the language the user writes in. When you rely on Norwegian text for an English answer, translate it faithfully and keep the Norwegian legal terms in brackets where helpful, e.g. "providers of essential services (tilbydere av samfunnsviktige tjenester)". Norwegian answers use exactly the same citation tags as English ones (på norsk: hver rettslig påstand skal ha en kildehenvisning i hakeparentes, for eksempel [Digitalsikkerhetsloven – § 8]).
- Be concise and practical: start with a direct answer in one or two sentences, then give the key details as a short list. List every stage, deadline, threshold and responsible party that the retrieved text provides.
- Prefer Articles and § sections over Recitals. Use Recitals only to explain the purpose or intent behind a provision, and say that they are recitals.`,
  hasNonBinding &&
    `- Legislation is the only source of obligations. Guidance and preparatory works are not legally binding: use them to explain how a provision is interpreted or applied, say which kind of source it is (for example "ENISA guidance, not binding"), and never present a recommendation in guidance as a legal requirement. If guidance and legislation seem to differ, follow the legislation and point out the difference.`,
  versionedSources.length > 0 &&
    `- Text versions: ${versionedSources.map((s) => `${s.short} – ${versionLabel(s)}`).join('; ')}. Keep the citation tags short, without the version, and say once at the end of the answer which version of each cited text you used, using exactly these labels. Only call a text "consolidated" if its label says so. Consolidated texts and Lovdata texts are not the authentic versions; the authentic text is the one published in the Official Journal of the EU or in Norsk Lovtidend.`,
  `- For EU acts, do not state whether they apply in Norway or have been incorporated into the EEA Agreement unless the retrieved text says so.`,
  ...scopeNotes,
  `- Do not include URLs or markdown links in your answer. The sources panel already links to the official texts.
- If the user asks about a law or document that is not one of these sources (for example NIS2, or the text of the GDPR itself), first call searchRegulations for the same topic (for example "hendelsesvarsling" for incident reporting). Then answer with exactly this template, in the user's language, and nothing else:
  1. One sentence: "[Law] is outside my sources, so I cannot say what it requires."
  2. The line "Related provisions in my sources:" followed by bullets. Each bullet states what one retrieved provision says, with its tag. Cite only provisions that appear in the search results. If the search found nothing related, write "None found." instead of bullets.
  3. The version line.
  Do not compare these provisions with the out-of-scope law in any way: do not say that they align with, implement, correspond to, resemble, differ from or replace it. Do not describe the out-of-scope law, and do not add advice, suggestions or a closing sentence.
- You provide information, not legal advice. If asked whether a specific organisation is compliant, explain that you cannot assess that, then search and summarise the main obligations that would typically apply, and recommend confirming with legal counsel or the relevant authority.
- If a question is unrelated to these sources, politely explain what you can help with.

Final check before you send the answer:
1. Every sentence or bullet that states what a source says ends with a tag such as [Digitalsikkerhetsloven – § 8], in every language. Section numbers in headings or in a closing source list do not count.
2. Each tag points to the provision that contains that statement.
3. If the question was about a law outside your sources, the answer follows the out-of-scope template exactly and compares nothing with that law.`,
]
  .filter(Boolean)
  .join('\n');

const quoted = (names: string[]) => names.map((n) => `'${n}'`).join(', ');

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai(CHAT_MODEL),
    ...(CHAT_REASONING_EFFORT ? { providerOptions: { openai: { reasoningEffort: CHAT_REASONING_EFFORT } } } : {}),
    system: SYSTEM_PROMPT,
    messages,
    tools: {
      searchRegulations: tool({
        description:
          `Search these sources: ${DOC_NAMES.join(', ')}. ` +
          'Use this for any question about obligations, scope, definitions, reporting, incidents, vulnerabilities, security requirements, supervision, penalties or deadlines. ' +
          'The Norwegian texts are written in Norwegian, so when searching them, a query in Norwegian (e.g. "hendelsesvarsling", "styringssystem", "risikovurdering") often works best.',
        parameters: z.object({
          query: z.string().describe('A focused search query: the topic, term or sub-question to look up'),
          // Plain strings (not enums) so an unexpected value such as "NIS2"
          // cannot crash the request; unknown values are simply ignored.
          document: z
            .string()
            .optional()
            .describe(`Optional: limit the search to one source: ${quoted(DOC_NAMES)}. Leave empty to search all sources.`),
          sourceType: z
            .string()
            .optional()
            .describe(
              `Optional: limit the search to one kind of source: ${quoted(SOURCE_TYPES)}. Use 'legislation' to find binding obligations only. Leave empty to search all kinds.`,
            ),
        }),
        execute: async ({ query, document: requestedDoc, sourceType: requestedType }) => {
          const norm = (v?: string) => v?.trim().toLowerCase();
          const document = DOC_NAMES.find((d) => d.toLowerCase() === norm(requestedDoc));
          const sourceType = SOURCE_TYPES.find((t) => t === norm(requestedType)) as SourceType | undefined;
          const filter = [
            document && `doc = '${esc(document)}'`,
            sourceType && `sourceType = '${sourceType}'`,
          ]
            .filter(Boolean)
            .join(' AND ');
          const { embedding } = await embed({
            model: openai.embedding('text-embedding-3-small'),
            value: query,
          });
          const candidates = await index.query({
            vector: embedding,
            topK: CANDIDATES,
            ...(filter ? { filter } : {}),
          });
          const top = [...candidates].sort((a, b) => b.score - a.score).slice(0, TOP_K);
          const fetched = await index.fetch(
            top.map((h) => String(h.id)),
            { includeMetadata: true },
          );
          const hits = top.map((h, i) => ({ ...h, metadata: fetched[i]?.metadata }));

          // Section expansion: long Articles / § sections are split into parts.
          // If one of the top results is such a part, also fetch the other parts
          // of that section so the model sees the whole provision.
          const toExpand = new Map<string, { doc: string; section: string }>();
          for (const h of hits.slice(0, EXPAND_FROM_TOP)) {
            const text = (h.metadata?.text as string) ?? '';
            const doc = (h.metadata?.doc as string) ?? '';
            const section = (h.metadata?.section as string) ?? '';
            if (doc && section && PART_TAG.test(text)) toExpand.set(`${doc}|${section}`, { doc, section });
            if (toExpand.size >= MAX_SECTIONS_TO_EXPAND) break;
          }

          const expanded = await Promise.all(
            [...toExpand.values()].map(({ doc, section }) =>
              index.query({
                vector: embedding,
                topK: MAX_PARTS_PER_SECTION,
                includeMetadata: true,
                filter: `doc = '${esc(doc)}' AND section = '${esc(section)}'`,
              }),
            ),
          );

          // Merge, remove duplicates, and keep parts of the same section in order
          const seen = new Set<string>();
          const all = [...hits, ...expanded.flat()].filter((h) => {
            const id = String(h.id);
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
          });
          const keyOf = (h: (typeof all)[number]) => `${h.metadata?.doc}|${h.metadata?.section}`;
          const best = new Map<string, number>();
          for (const h of all) best.set(keyOf(h), Math.max(best.get(keyOf(h)) ?? 0, h.score));
          all.sort((a, b) => {
            const ka = keyOf(a);
            const kb = keyOf(b);
            if (ka !== kb) return (best.get(kb) ?? 0) - (best.get(ka) ?? 0) || ka.localeCompare(kb);
            return partNo(a.metadata?.text) - partNo(b.metadata?.text);
          });

          return all.map((h) => ({
            text: (h.metadata?.text as string) ?? '',
            doc: (h.metadata?.doc as string) ?? '',
            section: (h.metadata?.section as string) ?? '',
            sectionTitle: (h.metadata?.sectionTitle as string) ?? '',
            page: (h.metadata?.page as number) ?? null,
            url: (h.metadata?.url as string) ?? '',
            lang: (h.metadata?.lang as string) ?? '',
            sourceType: (h.metadata?.sourceType as string) ?? '',
            binding: (h.metadata?.binding as boolean) ?? true,
            issuer: (h.metadata?.issuer as string) ?? '',
            publishedAt: (h.metadata?.publishedAt as string) ?? '',
            version: (h.metadata?.version as string) ?? '',
            reference: (h.metadata?.reference as string) ?? '',
            score: h.score,
          }));
        },
      }),
    },
    maxSteps: 5,
  });

  // Log the real error on the server (visible in Vercel → Logs) but show the
  // user only a generic message, so internal details are never exposed.
  return result.toDataStreamResponse({
    getErrorMessage: (error) => {
      console.error('[chat] stream error:', error);
      return 'An error occurred.';
    },
  });
}
