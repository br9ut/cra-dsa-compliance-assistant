/**
 * Seed Upstash Vector with every PDF in data/.
 *
 * Upgrades compared with the starter:
 *  - Multi-PDF: loads every .pdf in data/ (stretch goal: Multi-PDF support)
 *  - Real page numbers: text is extracted page by page
 *  - Cleaning: removes running headers/footers, page counters, print URLs,
 *    and joins words hyphenated across line breaks
 *  - Structure-aware chunking: one section per Recital / Article / Annex (EU)
 *    or § (Norwegian law). Long sections are split with overlap.
 *  - Citation metadata: document, section, section title, chapter, page, URL
 *  - Each chunk starts with "Document – Section (Title)" so both retrieval
 *    and the model know exactly where the text comes from
 *
 * Usage:
 *   npm run seed -- --dry-run   # parse + chunk only, writes seed-preview.json (free)
 *   npm run seed                # clears the index, then embeds and uploads everything
 */
import { config as loadEnv } from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';

// Next.js reads .env.local automatically; this script does not.
loadEnv({ path: path.join(process.cwd(), '.env.local') });
import { Index } from '@upstash/vector';
import { embedMany } from 'ai';
import { openai } from '@ai-sdk/openai';
import pdfParse from 'pdf-parse';

const DATA_DIR = path.join(process.cwd(), 'data');
const PREVIEW_PATH = path.join(process.cwd(), 'seed-preview.json');
const DRY_RUN = process.argv.includes('--dry-run');

const MAX_SECTION_CHARS = 2000; // sections longer than this are split
const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;
const MIN_SECTION_CHARS = 40; // drop fragments shorter than this
const EMBED_BATCH = 100;
const UPSERT_BATCH = 100;

// ---------------------------------------------------------------------------
// Document register: one entry per file in data/
// ---------------------------------------------------------------------------
type DocKind = 'eu' | 'no' | 'generic';

type DocMeta = {
  id: string; // short id used in vector ids
  short: string; // short name shown in citations
  title: string; // full official title
  lang: 'en' | 'no';
  kind: DocKind; // controls how sections are detected
  url: string; // public source link
};

const DOCS: Record<string, DocMeta> = {
  'cra-2024-2847.pdf': {
    id: 'cra',
    short: 'CRA',
    title: 'Cyber Resilience Act – Regulation (EU) 2024/2847',
    lang: 'en',
    kind: 'eu',
    url: 'https://eur-lex.europa.eu/eli/reg/2024/2847/oj',
  },
  'digitalsikkerhetsloven.pdf': {
    id: 'dsl',
    short: 'Digitalsikkerhetsloven',
    title: 'Lov om digital sikkerhet (digitalsikkerhetsloven)',
    lang: 'no',
    kind: 'no',
    url: 'https://lovdata.no/', // TODO: paste the exact Lovdata page URL
  },
  'digitalsikkerhetsforskriften.pdf': {
    id: 'dsf',
    short: 'Digitalsikkerhetsforskriften',
    title: 'Forskrift om digital sikkerhet (digitalsikkerhetsforskriften)',
    lang: 'no',
    kind: 'no',
    url: 'https://lovdata.no/', // TODO: paste the exact Lovdata page URL
  },
};

type Line = { text: string; page: number };

type Section = {
  label: string; // e.g. "Article 14", "Recital 12", "§ 6"
  title: string; // e.g. "Reporting obligations of manufacturers"
  type: 'front' | 'recital' | 'article' | 'annex' | 'paragraph' | 'document';
  chapter: string;
  page: number;
  lines: string[];
};

type Chunk = {
  id: string;
  text: string; // header + section text (this is what gets embedded)
  doc: string;
  docTitle: string;
  section: string;
  sectionTitle: string;
  sectionType: string;
  chapter: string;
  page: number;
  lang: string;
  url: string;
};

// ---------------------------------------------------------------------------
// 1. Extract text page by page (the starter lost page numbers here)
// ---------------------------------------------------------------------------
async function extractPages(filePath: string): Promise<string[]> {
  const buf = await fs.readFile(filePath);
  const pages: string[] = [];

  const renderPage = async (pageData: any): Promise<string> => {
    const content = await pageData.getTextContent({
      normalizeWhitespace: false,
      disableCombineTextItems: false,
    });
    let lastY: number | undefined;
    let text = '';
    for (const item of content.items as any[]) {
      const y = item.transform[5];
      if (lastY === undefined || Math.abs(y - lastY) < 1) text += item.str;
      else text += '\n' + item.str;
      lastY = y;
    }
    const idx = typeof pageData.pageIndex === 'number' ? pageData.pageIndex : pages.length;
    pages[idx] = text;
    return text;
  };

  await pdfParse(buf, { pagerender: renderPage as any });
  return Array.from(pages, (p) => p ?? '');
}

// ---------------------------------------------------------------------------
// 2. Clean: drop headers, footers, page counters and print artefacts
// ---------------------------------------------------------------------------
const NOISE_PATTERNS: RegExp[] = [
  /^OJ L,? .*$/i, // EU Official Journal running header
  /^ELI: ?http.*$/i, // EU footer
  /^EN$/, // EU language marker
  /^\d+\s*\/\s*\d+$/, // page counters such as "12/81"
  /^https?:\/\/\S+(\s+\d+\s*\/\s*\d+)?$/i, // browser-print URL footer
  /^\d{1,2}[./]\d{1,2}[./]\d{2,4},?\s+\d{1,2}[:.]\d{2}.*$/, // browser-print date header
  /.*\s-\sLovdata$/i, // browser-print title header
];

function toLines(pages: string[]): Line[] {
  const out: Line[] = [];
  pages.forEach((pageText, i) => {
    for (const raw of pageText.split('\n')) {
      const text = raw
        .replace(/\u00AD\s*$/, '-') // soft hyphen at line end -> normal hyphen
        .replace(/\u00AD/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) continue;
      if (NOISE_PATTERNS.some((re) => re.test(text))) continue;
      out.push({ text, page: i + 1 });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// 3. Split into legal units (Recital / Article / Annex / §)
// ---------------------------------------------------------------------------
const EU_CHAPTER = /^CHAPTER\s+([IVXLC]+)$/;
const EU_ARTICLE = /^Article\s+(\d+)$/;
const EU_ANNEX = /^ANNEX\s+([IVXLC]+)$/;
const EU_RECITAL = /^\((\d{1,3})\)\s*(.*)$/;
const EU_ENACTING = /^HAVE ADOPTED THIS REGULATION/;
const NO_CHAPTER = /^Kapittel\s+(\d+\s?[a-z]?)\s*\.?\s*(.*)$/;
const NO_PARAGRAPH = /^§\s*(\d+\s?[a-z]?)\s*\.\s*([A-ZÆØÅ].*)?$/;

function splitSections(lines: Line[], kind: DocKind): Section[] {
  const sections: Section[] = [];
  let chapter = '';
  let current: Section = {
    label: kind === 'no' ? 'Innledning' : kind === 'eu' ? 'Preamble' : 'Document',
    title: '',
    type: kind === 'generic' ? 'document' : 'front',
    chapter: '',
    page: lines[0]?.page ?? 1,
    lines: [],
  };
  let expectTitle = false;
  let expectChapterTitle = false;
  let seenArticle = false;
  let lastRecital = 0;
  let lastArticle = 0;
  let lastPara = 0;

  const start = (label: string, title: string, type: Section['type'], page: number) => {
    if (current.lines.length) sections.push(current);
    current = { label, title, type, chapter, page, lines: [] };
  };

  for (const { text, page } of lines) {
    if (expectChapterTitle) {
      expectChapterTitle = false;
      if (text.length < 150) {
        chapter += ` – ${text}`;
        continue;
      }
    }
    if (expectTitle) {
      expectTitle = false;
      if (text.length < 200) {
        current.title = text;
        continue;
      }
    }

    let m: RegExpMatchArray | null;

    if (kind === 'eu') {
      if (EU_ENACTING.test(text)) continue;
      if ((m = text.match(EU_CHAPTER))) {
        chapter = `Chapter ${m[1]}`;
        expectChapterTitle = true;
        continue;
      }
      // Articles must be sequential, which filters out stray cross-references
      if ((m = text.match(EU_ARTICLE)) && parseInt(m[1], 10) === lastArticle + 1) {
        lastArticle += 1;
        seenArticle = true;
        start(`Article ${m[1]}`, '', 'article', page);
        expectTitle = true;
        continue;
      }
      if (seenArticle && (m = text.match(EU_ANNEX))) {
        chapter = '';
        start(`Annex ${m[1]}`, '', 'annex', page);
        expectTitle = true;
        continue;
      }
      // Recitals only exist before Article 1, and must be sequential
      if (!seenArticle && (m = text.match(EU_RECITAL)) && parseInt(m[1], 10) === lastRecital + 1) {
        lastRecital += 1;
        start(`Recital ${m[1]}`, '', 'recital', page);
        if (m[2]) current.lines.push(m[2]);
        continue;
      }
    } else if (kind === 'no') {
      if ((m = text.match(NO_CHAPTER))) {
        chapter = `Kapittel ${m[1].replace(/\s/g, '')}${m[2] ? ` – ${m[2]}` : ''}`;
        continue;
      }
      if ((m = text.match(NO_PARAGRAPH))) {
        const n = parseInt(m[1], 10);
        // Allow a restart at § 1 (e.g. after a table of contents)
        if (n >= lastPara || n === 1) {
          lastPara = n;
          start(`§ ${m[1].replace(/\s/g, '')}`, m[2] ?? '', 'paragraph', page);
          if (!m[2]) expectTitle = true;
          continue;
        }
      }
    }

    current.lines.push(text);
  }
  if (current.lines.length) sections.push(current);
  return sections;
}

// ---------------------------------------------------------------------------
// 4. Turn sections into chunks with a citation header
// ---------------------------------------------------------------------------
function joinLines(lines: string[]): string {
  let out = '';
  for (const line of lines) {
    if (!out) {
      out = line;
    } else if (out.endsWith('-') && /^[a-zæøå]/.test(line)) {
      out = out.slice(0, -1) + line; // re-join hyphenated words
    } else if (/^(\d+\.|\([a-z0-9]+\)|[a-z]\))\s/.test(line)) {
      out += '\n' + line; // keep numbered paragraphs and points on new lines
    } else {
      out += ' ' + line;
    }
  }
  return out.trim();
}

function splitLong(text: string): string[] {
  if (text.length <= MAX_SECTION_CHARS) return [text];
  const parts: string[] = [];
  const minCut = Math.floor(CHUNK_SIZE * 0.6);
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + CHUNK_SIZE);
    if (end < text.length) {
      // Prefer to cut at a paragraph break, otherwise at a sentence end
      const window = text.slice(i + minCut, end);
      const nl = window.lastIndexOf('\n');
      const dot = window.lastIndexOf('. ');
      const cut = nl >= 0 ? nl : dot >= 0 ? dot + 1 : -1;
      if (cut >= 0) end = i + minCut + cut;
    }
    const piece = text.slice(i, end).trim();
    if (piece) parts.push(piece);
    if (end >= text.length) break;
    // Start the next chunk with some overlap, on a word boundary
    const back = text.indexOf(' ', end - CHUNK_OVERLAP);
    i = back > i && back < end ? back + 1 : end;
  }
  return parts;
}

function buildChunks(sections: Section[], doc: DocMeta): Chunk[] {
  const chunks: Chunk[] = [];
  let n = 0;
  for (const s of sections) {
    const body = joinLines(s.lines);
    if (body.length < MIN_SECTION_CHARS) continue;
    const parts = splitLong(body);
    parts.forEach((part, k) => {
      const header =
        `${doc.short} – ${s.label}` +
        (s.title ? ` (${s.title})` : '') +
        (parts.length > 1 ? ` [part ${k + 1}/${parts.length}]` : '');
      chunks.push({
        id: `${doc.id}-${n++}`,
        text: `${header}\n${part}`,
        doc: doc.short,
        docTitle: doc.title,
        section: s.label,
        sectionTitle: s.title,
        sectionType: s.type,
        chapter: s.chapter,
        page: s.page,
        lang: doc.lang,
        url: doc.url,
      });
    });
  }
  return chunks;
}

function genericMeta(file: string): DocMeta {
  const base = path.basename(file, path.extname(file));
  return {
    id: base.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    short: base,
    title: base,
    lang: 'en',
    kind: 'generic',
    url: '',
  };
}

// ---------------------------------------------------------------------------
// 5. Main
// ---------------------------------------------------------------------------
async function main() {
  if (!DRY_RUN) {
    if (!process.env.UPSTASH_VECTOR_REST_URL || !process.env.UPSTASH_VECTOR_REST_TOKEN) {
      console.error('Missing UPSTASH_VECTOR_REST_URL / UPSTASH_VECTOR_REST_TOKEN. Set them in .env.local.');
      process.exit(1);
    }
    if (!process.env.OPENAI_API_KEY) {
      console.error('Missing OPENAI_API_KEY in .env.local.');
      process.exit(1);
    }
  }

  const files = (await fs.readdir(DATA_DIR)).filter((f) => f.toLowerCase().endsWith('.pdf')).sort();
  if (files.length === 0) {
    console.error(`No PDF files found in ${DATA_DIR}`);
    process.exit(1);
  }

  const all: Chunk[] = [];
  for (const file of files) {
    const meta = DOCS[file] ?? genericMeta(file);
    if (!DOCS[file]) console.warn(`⚠️  ${file} is not listed in DOCS – using generic settings`);

    const pages = await extractPages(path.join(DATA_DIR, file));
    const sections = splitSections(toLines(pages), meta.kind);
    const chunks = buildChunks(sections, meta);

    const byType: Record<string, number> = {};
    for (const s of sections) byType[s.type] = (byType[s.type] ?? 0) + 1;
    const summary = Object.entries(byType)
      .map(([t, c]) => `${c} ${t}`)
      .join(', ');
    console.log(`📄 ${file}: ${pages.length} pages → ${sections.length} sections (${summary}) → ${chunks.length} chunks`);
    all.push(...chunks);
  }

  await fs.writeFile(PREVIEW_PATH, JSON.stringify(all, null, 2));
  console.log(`\n📝 Preview of all ${all.length} chunks written to seed-preview.json`);

  if (DRY_RUN) {
    console.log('Dry run – nothing was embedded or uploaded.');
    return;
  }

  console.log('Embedding…');
  const embeddings: number[][] = [];
  for (let i = 0; i < all.length; i += EMBED_BATCH) {
    const batch = all.slice(i, i + EMBED_BATCH);
    const res = await embedMany({
      model: openai.embedding('text-embedding-3-small'),
      values: batch.map((c) => c.text),
    });
    embeddings.push(...res.embeddings);
    console.log(`  embedded ${Math.min(i + EMBED_BATCH, all.length)}/${all.length}`);
  }

  const index = new Index();
  console.log('Clearing old vectors from the index…');
  await index.reset();

  const records = all.map((c, i) => {
    const { id, ...metadata } = c;
    return { id, vector: embeddings[i], metadata };
  });

  console.log(`Upserting ${records.length} chunks to Upstash Vector…`);
  for (let i = 0; i < records.length; i += UPSERT_BATCH) {
    await index.upsert(records.slice(i, i + UPSERT_BATCH));
  }
  console.log('✅ Done. Run `npm run dev` and chat at http://localhost:3000');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
