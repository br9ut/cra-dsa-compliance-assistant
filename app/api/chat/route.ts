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
- You provide information, not legal advice. For decisions about a specific organisation, recommend confirming with legal counsel or the relevant authority.
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
          document: z
            .enum(['CRA', 'Digitalsikkerhetsloven', 'Digitalsikkerhetsforskriften'])
            .optional()
            .describe('Optional: limit the search to one law. Leave empty to search all three.'),
        }),
        execute: async ({ query, document }) => {
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
          return hits.map((h) => ({
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

  return result.toDataStreamResponse();
}
