/**
 * Seed Upstash Vector with chunks from data/sample.pdf.
 *
 * Run once before starting the chat:
 *   npm run seed
 *
 * Re-run any time you replace data/sample.pdf with a different document.
 * Existing chunks are overwritten by id (we use deterministic ids).
 */
import { config as loadEnv } from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';

// Next.js reads .env.local automatically; this script does not.
loadEnv({ path: path.join(process.cwd(), '.env.local') });
import { Index } from '@upstash/vector';
import { embedMany } from 'ai';
import { openai } from '@ai-sdk/openai';
// pdf-parse uses CommonJS; default-import the parser fn
import pdfParse from 'pdf-parse';

const PDF_PATH = path.join(process.cwd(), 'data', 'sample.pdf');
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 100;

type Chunk = { text: string; page: number };

/**
 * Naive but adequate chunker: split text into ~800-char windows with 100-char
 * overlap, attempting to break on sentence boundaries when possible.
 */
function chunkText(text: string, page: number): Chunk[] {
  const out: Chunk[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + CHUNK_SIZE);
    // Try to extend to the next sentence boundary if we're not at the end.
    if (end < text.length) {
      const lookahead = text.slice(end, end + 200);
      const m = lookahead.match(/[.!?]\s/);
      if (m && m.index !== undefined) end += m.index + 1;
    }
    const piece = text.slice(i, end).trim();
    if (piece.length > 0) out.push({ text: piece, page });
    if (end >= text.length) break;
    i = end - CHUNK_OVERLAP;
  }
  return out;
}

async function loadAndChunkPdf(filePath: string): Promise<Chunk[]> {
  const buf = await fs.readFile(filePath);
  const parsed = await pdfParse(buf);
  // pdf-parse returns the whole document as one string. We approximate
  // page numbers by splitting on form-feed (which pdf-parse inserts between pages).
  const pages = parsed.text.split('\f');
  const chunks: Chunk[] = [];
  pages.forEach((pageText, pageIdx) => {
    if (pageText.trim().length === 0) return;
    chunks.push(...chunkText(pageText.trim(), pageIdx + 1));
  });
  return chunks;
}

async function main() {
  if (!process.env.UPSTASH_VECTOR_REST_URL || !process.env.UPSTASH_VECTOR_REST_TOKEN) {
    console.error('Missing UPSTASH_VECTOR_REST_URL / UPSTASH_VECTOR_REST_TOKEN. Set them in .env.local.');
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY in .env.local.');
    process.exit(1);
  }

  console.log(`Loading and chunking ${PDF_PATH}…`);
  const chunks = await loadAndChunkPdf(PDF_PATH);
  console.log(`  produced ${chunks.length} chunks across ${new Set(chunks.map(c => c.page)).size} page(s)`);

  console.log('Embedding…');
  const { embeddings } = await embedMany({
    model: openai.embedding('text-embedding-3-small'),
    values: chunks.map((c) => c.text),
  });

  const index = new Index();
  const records = chunks.map((c, i) => ({
    id: `chunk_${i}`,
    vector: embeddings[i],
    metadata: { text: c.text, page: c.page },
  }));

  console.log(`Upserting ${records.length} chunks to Upstash Vector…`);
  // Upstash supports up to 1000 vectors per upsert; chunk if needed.
  const BATCH = 100;
  for (let i = 0; i < records.length; i += BATCH) {
    await index.upsert(records.slice(i, i + BATCH));
  }
  console.log('✅ Done. Run `npm run dev` and chat at http://localhost:3000');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
