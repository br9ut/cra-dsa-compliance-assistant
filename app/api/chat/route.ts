/**
 * Chat route: RAG as a tool call over the CRA and the Norwegian
 * Digital Security Act (digitalsikkerhetsloven) and Regulation
 * (digitalsikkerhetsforskriften).
 *
 * The model decides when to call searchRegulations. The tool runs a vector
 * search in Upstash (optionally filtered to one document) and returns chunk
 * text plus citation metadata. The client renders these as sources.
 */
import { openai } from '@ai-sdk/openai';
import { streamText, tool, embed } from 'ai';
import { Index } from '@upstash/vector';
import { z } from 'zod';

const index = new Index();

const TOP_K = 6;
const DOC_NAMES = ['CRA', 'Digitalsikkerhetsloven', 'Digitalsikkerhetsforskriften'];

// Section expansion settings
const EXPAND_FROM_TOP = 3; // look at the top 3 results for split sections
const MAX_SECTIONS_TO_EXPAND = 2; // expand at most 2 sections per search
const MAX_PARTS_PER_SECTION = 10; // cap on parts fetched per section
const PART_TAG = /\[part \d+\/\d+\]/;

const esc = (s: string) => s.replace(/'/g, "\\'");
const partNo = (text: unknown) => {
  const m = typeof text === 'string' ? text.match(/\[part (\d+)\/\d+\]/) : null;
  return m ? parseInt(m[1], 10) : 0;
};

const SYSTEM_PROMPT = `You are a compliance assistant that answers questions about three legal texts:
1. CRA – the EU Cyber Resilience Act, Regulation (EU) 2024/2847 (English)
2. Digitalsikkerhetsloven – the Norwegian Digital Security Act (Norwegian)
3. Digitalsikkerhetsforskriften – the Norwegian Digital Security Regulation (Norwegian)

How to answer:
- Always call the searchRegulations tool before answering a question about these laws. For comparisons or broad questions, call it several times with focused queries (for example once per law or per topic).
- Answer ONLY from the retrieved text. If the retrieved text does not answer the question, say so plainly and suggest how the user could rephrase. Never fill gaps with general knowledge.
- Cite every key statement inline in square brackets using the source header, for example [CRA – Article 14] or [Digitalsikkerhetsloven – § 2]. Use only sections that appear in the retrieved results.
- Answer in the language the user writes in. When you rely on Norwegian text for an English answer, translate it faithfully and keep the Norwegian legal terms in brackets where helpful, e.g. "providers of essential services (tilbydere av samfunnsviktige tjenester)".
- Be concise and practical: start with a direct answer in one or two sentences, then give the key details as a short list. List every stage, deadline, threshold and responsible party that the retrieved text provides.
- Prefer Articles and § sections over Recitals. Use Recitals only to explain the purpose or intent behind a provision, and say that they are recitals.
- Do not include URLs or markdown links in your answer. The sources panel already links to the official texts.
- If the user asks about a law that is not one of the three texts (for example NIS2 or GDPR), say clearly that it is outside your sources. You may point to related provisions in the three texts if they are relevant.
- You provide information, not legal advice. If asked whether a specific organisation is compliant, explain that you cannot assess that, then search and summarise the main obligations that would typically apply, and recommend confirming with legal counsel or the relevant authority.
- If a question is unrelated to these laws, politely explain what you can help with.`;

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai('gpt-4o-mini'),
    system: SYSTEM_PROMPT,
    messages,
    tools: {
      searchRegulations: tool({
        description:
          'Search the Cyber Resilience Act (CRA), the Norwegian Digital Security Act (digitalsikkerhetsloven) and the Norwegian Digital Security Regulation (digitalsikkerhetsforskriften). ' +
          'Use this for any question about obligations, scope, definitions, reporting, incidents, vulnerabilities, security requirements, supervision, penalties or deadlines in these laws. ' +
          'The Norwegian texts are written in Norwegian, so when searching them, a query in Norwegian (e.g. "hendelsesvarsling", "styringssystem", "risikovurdering") often works best.',
        parameters: z.object({
          query: z.string().describe('A focused search query: the topic, term or sub-question to look up'),
          // A plain string (not an enum) so an unexpected value such as "NIS2"
          // cannot crash the request; unknown values are simply ignored.
          document: z
            .string()
            .optional()
            .describe(
              "Optional: limit the search to one law: 'CRA', 'Digitalsikkerhetsloven' or 'Digitalsikkerhetsforskriften'. Leave empty to search all three.",
            ),
        }),
        execute: async ({ query, document: requested }) => {
          const document = DOC_NAMES.find((d) => d.toLowerCase() === requested?.trim().toLowerCase());
          const { embedding } = await embed({
            model: openai.embedding('text-embedding-3-small'),
            value: query,
          });
          const hits = await index.query({
            vector: embedding,
            topK: TOP_K,
            includeMetadata: true,
            ...(document ? { filter: `doc = '${document}'` } : {}),
          });

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
