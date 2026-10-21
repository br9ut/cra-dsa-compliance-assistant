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
 *  - Citation metadata: document, section, section title, chapter, page, URL,
 *    source type, binding, issuer, publication date, consolidation date
 *  - Each chunk starts with "Document – Section (Title)" so both retrieval
 *    and the model know exactly where the text comes from
 *  - Safety checks: every PDF must be registered in lib/sources.ts, data/
 *    must hold exactly the live sources, no two PDFs may be identical, and
 *    repeated text within a document is embedded only once
 *
 * Usage:
 *   npm run seed -- --dry-run                    # parse + chunk only, writes seed-preview.json (free)
 *   npm run seed -- --dry-run --dir=data-pending # preview a pending batch
 *   npm run seed                                 # clears the index, then embeds and uploads everything
 */
import { config as loadEnv } from 'dotenv';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// Next.js reads .env.local automatically; this script does not.
loadEnv({ path: path.join(process.cwd(), '.env.local') });
import { Index } from '@upstash/vector';
import { embedMany } from 'ai';
import { openai } from '@ai-sdk/openai';
import pdfParse from 'pdf-parse';
import { ACTIVE_BATCH, SOURCES, versionLabel, type ParserKind, type Source } from './sources';

const DRY_RUN = process.argv.includes('--dry-run');
const DIR_ARG = process.argv.find((a) => a.startsWith('--dir='))?.slice('--dir='.length);
const DATA_DIR = path.join(process.cwd(), DIR_ARG ?? 'data');
const PREVIEW_PATH = path.join(process.cwd(), 'seed-preview.json');

const MAX_SECTION_CHARS = 2000; // sections longer than this are split
const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;
const MIN_SECTION_CHARS = 40; // drop fragments shorter than this
const EMBED_BATCH = 100;
const UPSERT_BATCH = 100;

// The document register lives in lib/sources.ts
const BY_FILE = new Map(SOURCES.map((s) => [s.file, s]));

type Line = { text: string; page: number };

type Section = {
  label: string; // e.g. "Article 14", "Recital 12", "§ 6"
  title: string; // e.g. "Reporting obligations of manufacturers"
  type: 'front' | 'recital' | 'article' | 'definition' | 'annex' | 'paragraph' | 'document';
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
  sourceType: string;
  binding: boolean;
  issuer: string;
  publishedAt: string;
  version: string; // e.g. "consolidated text as of 27 July 2026", "Lovdata text retrieved 26 September 2026"
  reference: string;
};

// ---------------------------------------------------------------------------
// 1. Extract text page by page (the starter lost page numbers here)
// ---------------------------------------------------------------------------
// Order text items as they appear on the page: top to bottom, then left to
// right. Lovdata PDFs emit chapter headings at the start of each page's text
// stream, wherever they are printed, which put §§ under the wrong chapter.
function byVisualOrder(a: any, b: any): number {
  const dy = b.transform[5] - a.transform[5];
  return Math.abs(dy) >= 1 ? dy : a.transform[4] - b.transform[4];
}

async function extractPages(filePath: string, visualOrder = false): Promise<string[]> {
  const buf = await fs.readFile(filePath);
  const pages: string[] = [];

  const renderPage = async (pageData: any): Promise<string> => {
    const content = await pageData.getTextContent({
      normalizeWhitespace: false,
      disableCombineTextItems: false,
    });
    const items = content.items as any[];
    const rotated = items.some((it) => Math.abs(it.transform[1]) > Math.abs(it.transform[0]));
    // Page 1 keeps stream order: Lovdata's metadata table prints each value
    // 6pt above its label, so sorting would separate "Sist endret" from its value
    if (visualOrder && !rotated && pageData.pageIndex > 0) items.sort(byVisualOrder);
    let lastPos: number | undefined;
    let text = '';
    for (const item of items) {
      const [a, b, , , x, y] = item.transform;
      // Text on rotated pages (e.g. landscape annex tables) runs along the
      // y axis, so a new line shows up as a change in x instead of y
      const pos = Math.abs(b) > Math.abs(a) ? x : y;
      if (lastPos === undefined || Math.abs(pos - lastPos) < 1) text += item.str;
      else text += '\n' + item.str;
      lastPos = pos;
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
  /^0\d{4}[A-Z]\d{4} — [A-Z]{2} — .*$/, // EUR-Lex consolidated running header, e.g. "02024R1689 — EN — 27.07.2026 — 001.001 — 3"
];

// EUR-Lex consolidated-text amendment markers: ▼B, ▼M1, ►M1 … ◄, ►C1 …
const CONSOLIDATION_MARKERS = /[▼►]\s*(?:B|[MACR]\d+)\b|◄/g;

// Lovdata's "Kort om loven" box is an encyclopedia summary (Store norske
// leksikon), not law text, so it is left out of the corpus
const LOVDATA_SUMMARY_START = /^Kort om loven$/;
const LOVDATA_SUMMARY_END = /^Kapitteloversikt:?$/;

function toLines(pages: string[]): Line[] {
  const out: Line[] = [];
  let inSummary = false;
  pages.forEach((pageText, i) => {
    for (const raw of pageText.split('\n')) {
      const text = raw
        .replace(CONSOLIDATION_MARKERS, '')
        .replace(/\u00AD\s*$/, '-') // soft hyphen at line end -> normal hyphen
        .replace(/\u00AD/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) continue;
      if (LOVDATA_SUMMARY_START.test(text)) inSummary = true;
      if (inSummary && LOVDATA_SUMMARY_END.test(text)) inSummary = false;
      if (inSummary) continue;
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
const EU_SECTION = /^SECTION\s+(\d+)$/;
const EU_ARTICLE = /^Article\s+(\d+)([a-z]?)$/; // "Article 4a" = article inserted by an amendment
const EU_ANNEX = /^ANNEX(?:\s+([IVXLC]+))?$/; // a single annex has no number
const EU_RECITAL = /^\((\d{1,3})\)\s*(.*)$/;
const EU_DEFINITIONS = /^Definitions$/i;
// A CHAPTER / SECTION title that wraps onto the next line ends with a connective or a comma
const EU_HEADING_WRAPS = /(\s(and|of|for|the|or|to|in|on|with|by)|,)$/i;
const EU_POINT = /^\((\d{1,3})([a-z]?)\)\s*(.*)$/; // "(14a) ‘SME’ means …", CRA: "(1)‘product …"
const EU_ENACTING = /^HAVE ADOPTED THIS REGULATION/;
const NO_CHAPTER = /^Kapittel\s+(\d+\s?[a-z]?)\s*\.?\s*(.*)$/;
// "§ 6." (digitalsikkerhetsloven) and "§ 1-2." (sikkerhetsloven: chapter-section)
const NO_PARAGRAPH = /^§\s*(\d+(?:-\d+)?\s?[a-z]?)\s*\.\s*([A-ZÆØÅ].*)?$/;
// A § title that wraps onto the next line ends with a connective or a comma
const NO_TITLE_WRAPS = /(\s(og|eller|med|av|for|i|til|om|ved|på)|,)$/;

// Order key for § numbers: "6" -> 6, "1-2" -> 1002
function paraKey(num: string): number {
  const [a, b] = num.split('-').map((x) => parseInt(x, 10));
  return b === undefined ? a : a * 1000 + b;
}

// Sequence check that allows inserted numbers: 4 -> 4a -> 4b -> 5
type SeqNo = { n: number; suffix: string };
function isNextNo(last: SeqNo, n: number, suffix: string): boolean {
  if (!suffix) return n === last.n + 1;
  const expected = last.suffix ? String.fromCharCode(last.suffix.charCodeAt(0) + 1) : 'a';
  return n === last.n && suffix === expected;
}

// "‘AI system’ means …" -> "Definition of ‘AI system’"
function definitionTitle(text: string): string {
  const m = text.match(/^([‘'“"][^’'”"]+[’'”"])/);
  return m ? `Definition of ${m[1]}` : '';
}

function splitSections(lines: Line[], kind: ParserKind): Section[] {
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
  let chapterOnly = ''; // chapter without the current SECTION
  let expectTitle = false;
  let expectTitleRest = false;
  let expectHeadingTitle: '' | 'chapter' | 'section' = '';
  let headingWraps = false;
  let seenArticle = false;
  let seenAnnex = false;
  let lastRecital = 0;
  let lastArticle: SeqNo = { n: 0, suffix: '' };
  let lastPoint: SeqNo = { n: 0, suffix: '' };
  let definitionsOf = ''; // label of the Definitions article being split by point
  let lastPara = 0;
  let noChapterWraps = false; // a Lovdata chapter heading is always followed directly by a §

  const start = (label: string, title: string, type: Section['type'], page: number) => {
    if (current.lines.length) sections.push(current);
    current = { label, title, type, chapter, page, lines: [] };
  };

  for (const { text, page } of lines) {
    if (expectHeadingTitle) {
      const target: 'chapter' | 'section' = expectHeadingTitle;
      expectHeadingTitle = '';
      if (text.length < 150) {
        // First line of the title, or the rest of a title that wrapped
        chapter += headingWraps ? ` ${text}` : ` – ${text}`;
        headingWraps = EU_HEADING_WRAPS.test(text);
        if (headingWraps) expectHeadingTitle = target;
        if (target === 'chapter') chapterOnly = chapter;
        continue;
      }
      headingWraps = false;
    }
    if (expectTitle) {
      expectTitle = false;
      // Some EU articles have no title: then the next line is already body
      // text, typically a numbered paragraph or a long wrapped sentence
      const bodyText = kind === 'eu' && (text.length > 120 || /^(\d+\.\s|\()/.test(text));
      if (text.length < 200 && !bodyText) {
        // Drop a stray closing quote with no opening quote ("Subject matter'" in the AI Act PDF)
        current.title = /^[^‘'“"]*'$/.test(text) ? text.slice(0, -1) : text;
        if (kind === 'eu') expectTitleRest = true; // only taken if the next line starts in lowercase
        if (current.type === 'article' && EU_DEFINITIONS.test(text)) {
          definitionsOf = current.label;
          lastPoint = { n: 0, suffix: '' };
        }
        continue;
      }
    }
    if (noChapterWraps) {
      // Lines between a chapter heading and the next § are the rest of the heading
      if (!NO_PARAGRAPH.test(text) && !NO_CHAPTER.test(text) && text.length < 120) {
        chapter += ` ${text}`;
        continue;
      }
      noChapterWraps = false;
    }
    if (expectTitleRest) {
      expectTitleRest = false;
      // Body text starts with a capital; the rest of a wrapped title does not
      if (text.length < 100 && /^[a-zæøå]/.test(text)) {
        current.title += ` ${text}`;
        if (kind === 'eu') expectTitleRest = true; // long annex titles wrap over three lines
        continue;
      }
    }

    let m: RegExpMatchArray | null;

    if (kind === 'eu') {
      if (EU_ENACTING.test(text)) continue;
      if ((m = text.match(EU_CHAPTER))) {
        chapter = chapterOnly = `Chapter ${m[1]}`;
        expectHeadingTitle = 'chapter';
        headingWraps = false;
        continue;
      }
      if (seenArticle && (m = text.match(EU_SECTION))) {
        chapter = `${chapterOnly}, Section ${m[1]}`;
        expectHeadingTitle = 'section';
        headingWraps = false;
        continue;
      }
      // Articles must be sequential (inserted ones such as 4a included),
      // which filters out stray cross-references
      if ((m = text.match(EU_ARTICLE)) && isNextNo(lastArticle, parseInt(m[1], 10), m[2])) {
        lastArticle = { n: parseInt(m[1], 10), suffix: m[2] };
        seenArticle = true;
        definitionsOf = '';
        start(`Article ${m[1]}${m[2]}`, '', 'article', page);
        expectTitle = true;
        continue;
      }
      if (seenArticle && (m = text.match(EU_ANNEX)) && (m[1] || !seenAnnex)) {
        seenAnnex = true;
        definitionsOf = '';
        chapter = chapterOnly = '';
        start(m[1] ? `Annex ${m[1]}` : 'Annex', '', 'annex', page);
        expectTitle = true;
        continue;
      }
      // Definitions articles are split by point, so each definition is
      // retrieved and cited on its own, e.g. "Article 3(14a)"
      if (definitionsOf && (m = text.match(EU_POINT)) && isNextNo(lastPoint, parseInt(m[1], 10), m[2])) {
        lastPoint = { n: parseInt(m[1], 10), suffix: m[2] };
        // Drop the short lead-in ("For the purposes of this Regulation, …:")
        if (current.type === 'article' && joinLines(current.lines).length < 200) current.lines = [];
        start(`${definitionsOf}(${m[1]}${m[2]})`, definitionTitle(m[3]), 'definition', page);
        current.lines.push(m[3]);
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
        // Table-of-contents entries carry a § range and never wrap into body text
        noChapterWraps = !text.includes('(§');
        continue;
      }
      if ((m = text.match(NO_PARAGRAPH))) {
        const n = paraKey(m[1]);
        // Allow a restart at § 1 / § 1-1 (e.g. after a table of contents)
        if (n >= lastPara || n === 1 || n === 1001) {
          lastPara = n;
          start(`§ ${m[1].replace(/\s/g, '')}`, m[2] ?? '', 'paragraph', page);
          if (!m[2]) expectTitle = true;
          else if (NO_TITLE_WRAPS.test(m[2])) expectTitleRest = true;
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
  for (const raw of lines) {
    // Lovdata letter lists lose the space: "a.tilbydere" -> "a. tilbydere"
    const line = raw.replace(/^([a-zæøå])\.(?=[a-zæøåA-ZÆØÅ])/, '$1. ');
    if (!out) {
      out = line;
    } else if (out.endsWith('-') && /^[a-zæøå]/.test(line)) {
      out = out.slice(0, -1) + line; // re-join hyphenated words
    } else if (/^(\d+\.|\([a-z0-9]+\)|[a-zæøå][.)])\s/.test(line)) {
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

const sha256 = (data: crypto.BinaryLike) => crypto.createHash('sha256').update(data).digest('hex');
const textKey = (text: string) => sha256(text.toLowerCase().replace(/\s+/g, ' ').trim());

function buildChunks(sections: Section[], doc: Source): { chunks: Chunk[]; dropped: number } {
  const chunks: Chunk[] = [];
  const seen = new Set<string>(); // repeated text (boilerplate) is embedded only once per document
  let dropped = 0;
  let n = 0;
  const version = versionLabel(doc);
  for (const s of sections) {
    const body = joinLines(s.lines);
    if (body.length < MIN_SECTION_CHARS) continue;
    const parts = splitLong(body).filter((part) => {
      const key = textKey(part);
      if (seen.has(key)) {
        dropped += 1;
        return false;
      }
      seen.add(key);
      return true;
    });
    parts.forEach((part, k) => {
      const header =
        `${doc.short} – ${s.label}` +
        (s.title ? ` (${s.title})` : '') +
        (parts.length > 1 ? ` [part ${k + 1}/${parts.length}]` : '') +
        (version ? ` · ${version}` : '');
      chunks.push({
        id: `${doc.id}-${n++}`,
        // The chapter line ("Kapittel 2 – Sikkerhetsstyring") lets broad questions
        // find every section of a chapter, even ones that never use its key term
        text: `${header}\n${s.chapter ? `${s.chapter}\n` : ''}${part}`,
        doc: doc.short,
        docTitle: doc.title,
        section: s.label,
        sectionTitle: s.title,
        sectionType: s.type,
        chapter: s.chapter,
        page: s.page,
        lang: doc.lang,
        url: doc.url,
        sourceType: doc.sourceType,
        binding: doc.binding,
        issuer: doc.issuer,
        publishedAt: doc.publishedAt,
        version,
        reference: doc.reference ?? '',
      });
    });
  }
  return { chunks, dropped };
}

// ---------------------------------------------------------------------------
// 5. Safety checks: register, batches, duplicate files
// ---------------------------------------------------------------------------
function checkRegister(): string[] {
  const errors: string[] = [];
  for (const key of ['file', 'id', 'short'] as const) {
    const seen = new Set<string>();
    for (const s of SOURCES) {
      const v = s[key].toLowerCase();
      if (seen.has(v)) errors.push(`lib/sources.ts: duplicate ${key} "${s[key]}"`);
      seen.add(v);
    }
  }
  return errors;
}

async function checkFiles(files: string[]): Promise<{ errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const unregistered = files.filter((f) => !BY_FILE.has(f));
  for (const f of unregistered) errors.push(`${f} is not registered in lib/sources.ts`);

  // The index is rebuilt from scratch, so a live source missing from data/
  // would silently disappear from the index, and a pending one would appear
  // in answers before the prompt and UI know about it.
  if (!DIR_ARG) {
    for (const s of SOURCES) {
      const present = files.includes(s.file);
      if (s.batch <= ACTIVE_BATCH && !present) {
        errors.push(`${s.file} is live (batch ${s.batch}) but missing from data/`);
      }
      if (s.batch > ACTIVE_BATCH && present) {
        const msg = `${s.file} belongs to batch ${s.batch} but ACTIVE_BATCH is ${ACTIVE_BATCH}: move it to data-pending/ or raise ACTIVE_BATCH`;
        (DRY_RUN ? warnings : errors).push(msg);
      }
    }
  }

  const byHash = new Map<string, string>();
  for (const f of files) {
    const hash = sha256(await fs.readFile(path.join(DATA_DIR, f)));
    const other = byHash.get(hash);
    if (other) errors.push(`${f} is identical to ${other}`);
    else byHash.set(hash, f);
  }
  return { errors, warnings };
}

// Lovdata front page: "Sist endret" on one line, the amending act on the next,
// e.g. "LOV-2026-06-23-74 fra 16.10.2026" or "FOR-2019-05-03-560". (A
// one-line "Sist endret 12.06.2026" belongs to the encyclopedia summary.)
const LOVDATA_AMENDED_BY = /^((?:LOV|FOR)-(\d{4})-(\d{2})-(\d{2})-\d+)(?: fra (\d{2})\.(\d{2})\.(\d{4}))?/;

function lovdataLastAmended(lines: Line[]): { by: string; date: string } | null {
  const i = lines.findIndex((l, k) => l.page <= 2 && l.text === 'Sist endret' && LOVDATA_AMENDED_BY.test(lines[k + 1]?.text ?? ''));
  if (i < 0) return null;
  const m = lines[i + 1].text.match(LOVDATA_AMENDED_BY)!;
  // The "fra" date is when the latest amendment applies; without it, use the amending act's date
  return { by: m[1], date: m[5] ? `${m[7]}-${m[6]}-${m[5]}` : `${m[2]}-${m[3]}-${m[4]}` };
}

// The version label must come from the PDF itself, not from the download date
function checkLovdataVersion(meta: Source, lines: Line[]): string | null {
  if (meta.kind !== 'no') return null;
  const found = lovdataLastAmended(lines);
  if (found) {
    if (meta.lastAmended !== found.date || meta.lastAmendedBy !== found.by) {
      return `${meta.file}: the PDF says "Sist endret ${found.by}" (${found.date}); set lastAmended and lastAmendedBy in lib/sources.ts to match`;
    }
  } else if (meta.lastAmended || !meta.retrievedAt) {
    return `${meta.file}: the PDF has no "Sist endret" field; use retrievedAt (the download date) in lib/sources.ts instead of lastAmended`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 6. Main
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

  if (DIR_ARG && !DRY_RUN) {
    console.error('--dir is only allowed with --dry-run: the index is always built from data/.');
    process.exit(1);
  }

  const files = (await fs.readdir(DATA_DIR)).filter((f) => f.toLowerCase().endsWith('.pdf')).sort();
  if (files.length === 0) {
    console.error(`No PDF files found in ${DATA_DIR}`);
    process.exit(1);
  }

  const { errors: fileErrors, warnings } = await checkFiles(files);
  const errors = [...checkRegister(), ...fileErrors];
  for (const w of warnings) console.warn(`⚠️  ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`❌ ${e}`);
    console.error('Nothing was embedded or uploaded.');
    process.exit(1);
  }

  const all: Chunk[] = [];
  const versionErrors: string[] = [];
  for (const file of files) {
    const meta = BY_FILE.get(file)!;
    const pages = await extractPages(path.join(DATA_DIR, file), meta.kind === 'no');
    const lines = toLines(pages);
    const versionError = checkLovdataVersion(meta, lines);
    if (versionError) versionErrors.push(versionError);
    const sections = splitSections(lines, meta.kind);
    const { chunks, dropped } = buildChunks(sections, meta);

    const byType: Record<string, number> = {};
    for (const s of sections) byType[s.type] = (byType[s.type] ?? 0) + 1;
    const summary = Object.entries(byType)
      .map(([t, c]) => `${c} ${t}`)
      .join(', ');
    console.log(
      `📄 ${file}: ${pages.length} pages → ${sections.length} sections (${summary}) → ${chunks.length} chunks` +
        (dropped ? ` (${dropped} repeated chunks dropped)` : ''),
    );
    all.push(...chunks);
  }

  if (versionErrors.length) {
    for (const e of versionErrors) console.error(`❌ ${e}`);
    console.error('Nothing was embedded or uploaded.');
    process.exit(1);
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
