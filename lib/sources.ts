/**
 * Source register: the single list of documents the assistant knows about.
 *
 * Used by lib/seed.ts (parsing + chunk metadata), app/api/chat/route.ts
 * (tool filter, tool description, system prompt) and app/page.tsx (corpus
 * list, citation tags). Add a document here and every place picks it up.
 *
 * Batches: a source is live when its `batch` is <= ACTIVE_BATCH. The seed
 * refuses to run if data/ does not match the live sources exactly, so the
 * index, the prompt and the UI always describe the same corpus.
 *
 * This file is imported by the client page, so it must never contain secrets.
 */

export type SourceType = 'legislation' | 'implementing-act' | 'delegated-act' | 'preparatory-works' | 'guidance';

/** Controls how lib/seed.ts detects sections */
export type ParserKind = 'eu' | 'no' | 'generic';

export type Source = {
  file: string; // exact file name in data/ (or data-pending/)
  id: string; // short id used in vector ids, must be unique
  short: string; // name used in citations and the tool filter, must be unique
  title: string; // full official title
  lang: 'en' | 'no';
  kind: ParserKind;
  sourceType: SourceType;
  binding: boolean; // false for guidance and preparatory works
  issuer: string;
  publishedAt: string; // 'YYYY-MM-DD', 'YYYY-MM' or '' if unknown
  // Version of the text (shown in citations and the sources panel). The seed
  // checks the Lovdata fields against the "Sist endret" field in the PDF.
  consolidatedAsOf?: string; // 'YYYY-MM-DD' for EUR-Lex consolidated texts
  officialJournal?: boolean; // the original Official Journal text, published on publishedAt
  lastAmended?: string; // Lovdata "Sist endret": 'YYYY-MM-DD' the latest amendment applies from
  lastAmendedBy?: string; // Lovdata "Sist endret": the amending act, e.g. 'LOV-2026-06-23-74'
  retrievedAt?: string; // Lovdata texts without "Sist endret": 'YYYY-MM-DD' downloaded
  reference?: string; // official document reference, e.g. 'C(2026) 5252'
  url: string; // public source link, '' if not yet known
  description: string; // one line, shown in the UI and the system prompt
  scopeNote?: string; // extra system-prompt rule, included while the source is live
  batch: number;
};

export const ACTIVE_BATCH = 2;

export const SOURCES: Source[] = [
  // ---- Batch 0: original corpus -------------------------------------------
  {
    file: 'cra-2024-2847.pdf',
    id: 'cra',
    short: 'CRA',
    title: 'Cyber Resilience Act – Regulation (EU) 2024/2847',
    lang: 'en',
    kind: 'eu',
    sourceType: 'legislation',
    binding: true,
    issuer: 'EU',
    publishedAt: '2024-11-20',
    officialJournal: true,
    url: 'https://eur-lex.europa.eu/eli/reg/2024/2847/oj',
    description: 'EU Cyber Resilience Act, Regulation (EU) 2024/2847',
    batch: 0,
  },
  {
    file: 'digitalsikkerhetsloven.pdf',
    id: 'dsl',
    short: 'Digitalsikkerhetsloven',
    title: 'Lov om digital sikkerhet (digitalsikkerhetsloven)',
    lang: 'no',
    kind: 'no',
    sourceType: 'legislation',
    binding: true,
    issuer: 'Stortinget',
    publishedAt: '2023-12-20',
    retrievedAt: '2026-09-26',
    url: 'https://lovdata.no/dokument/NL/lov/2023-12-20-108?q=digitalsikkerhetsloven',
    description: 'Norwegian Digital Security Act',
    batch: 0,
  },
  {
    file: 'digitalsikkerhetsforskriften.pdf',
    id: 'dsf',
    short: 'Digitalsikkerhetsforskriften',
    title: 'Forskrift om digital sikkerhet (digitalsikkerhetsforskriften)',
    lang: 'no',
    kind: 'no',
    sourceType: 'legislation',
    binding: true,
    issuer: 'Justis- og beredskapsdepartementet',
    publishedAt: '2025-06-23',
    retrievedAt: '2026-09-26',
    url: 'https://lovdata.no/dokument/SF/forskrift/2025-06-20-1131?q=digitalsikkerhetsforskriften',
    description: 'Norwegian Digital Security Regulation',
    batch: 0,
  },

  // ---- Batch 1: AI Act and CRA implementing acts --------------------------
  {
    file: 'eu-ai-act-consolidated-2026-07-27.pdf',
    id: 'aia',
    short: 'AI Act',
    title: 'Artificial Intelligence Act – Regulation (EU) 2024/1689',
    lang: 'en',
    kind: 'eu',
    sourceType: 'legislation',
    binding: true,
    issuer: 'EU',
    publishedAt: '2024-07-12',
    consolidatedAsOf: '2026-07-27',
    url: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02024R1689-20260727',
    description: 'EU Artificial Intelligence Act, Regulation (EU) 2024/1689',
    scopeNote:
      'AI Act: explain obligations by role (provider, deployer, importer, distributor, provider of a general-purpose AI model) and by risk category (prohibited practices, high-risk, transparency obligations, general-purpose AI). Take application dates only from the retrieved text (for example Article 113), never from memory.',
    batch: 1,
  },
  {
    file: 'cra-implementing-reg-2025-2392.pdf',
    id: 'cra-ir-2025-2392',
    short: 'CRA Implementing Regulation 2025/2392',
    title:
      'Commission Implementing Regulation (EU) 2025/2392 on the technical description of the categories of important and critical products with digital elements',
    lang: 'en',
    kind: 'eu',
    sourceType: 'implementing-act',
    binding: true,
    issuer: 'European Commission',
    publishedAt: '2025-12-01',
    officialJournal: true,
    url: 'https://eur-lex.europa.eu/legal-content/en/TXT/?uri=CELEX:32025R2392',
    description: 'Technical description of important and critical product categories under the CRA',
    batch: 1,
  },

  // ---- Batch 2: sikkerhetsloven and key regulations -----------------------
  {
    file: 'sikkerhetsloven.pdf',
    id: 'sikkl',
    short: 'Sikkerhetsloven',
    title: 'Lov om nasjonal sikkerhet (sikkerhetsloven)',
    lang: 'no',
    kind: 'no',
    sourceType: 'legislation',
    binding: true,
    issuer: 'Stortinget',
    publishedAt: '2018-06-01',
    lastAmended: '2026-10-16', // "Sist endret LOV-2026-06-23-74 fra 16.10.2026"
    lastAmendedBy: 'LOV-2026-06-23-74',
    url: 'https://lovdata.no/dokument/NL/lov/2018-06-01-24',
    description: 'Norwegian National Security Act',
    scopeNote:
      'Sikkerhetsloven: never say or imply that an organisation is subject to sikkerhetsloven without first retrieving the scope provisions (§ 1-2 and § 1-3). For any question about who the Act applies to, search sikkerhetsloven at least twice: once for "hvem loven gjelder for" (§ 1-2) and once for "vedtak om at loven skal gjelde for andre virksomheter" (§ 1-3), and cite both. Every such answer must mention the § 1-3 designation route, not only the bodies listed in § 1-2. Under the text, the Act applies directly to state, county and municipal bodies and to suppliers in security-graded procurements (chapter 9). Private suppliers of goods or services in security-graded procurements are covered directly by § 1-2, without any designation decision, so never say that private companies are covered only by designation. Other organisations are covered only if a ministry has designated them by an individual decision (vedtak) under § 1-3. NSM may propose such designations, but the ministry decides. The exception is organisations outside any ministry’s area of responsibility: for them NSM makes the decision, and the ministry handles appeals (§ 1-3, last paragraph). If the user has not said whether such a decision exists, say that applicability depends on it.',
    batch: 2,
  },
  {
    file: 'virksomhetssikkerhetsforskriften.pdf',
    id: 'vsf',
    short: 'Virksomhetsikkerhetsforskriften',
    title: 'Forskrift om virksomheters arbeid med forebyggende sikkerhet (virksomhetsikkerhetsforskriften)',
    lang: 'no',
    kind: 'no',
    sourceType: 'legislation',
    binding: true,
    issuer: 'Justis- og beredskapsdepartementet',
    publishedAt: '2018-12-20',
    lastAmended: '2019-05-03', // "Sist endret FOR-2019-05-03-560" (no "fra" date, so the date of the amending act)
    lastAmendedBy: 'FOR-2019-05-03-560',
    url: 'https://lovdata.no/dokument/SF/forskrift/2018-12-20-2053',
    description: 'Regulation on organisations’ preventive security work under sikkerhetsloven',
    scopeNote:
      'Virksomhetsikkerhetsforskriften: chapter 2 (Sikkerhetsstyring, §§ 3–11) sets out the security management system, but most of its sections never use the word "styringssystem". For questions about the security management system, search this regulation for "sikkerhetsstyring" as well as "styringssystem", and cite each section you use.',
    batch: 2,
  },

  // ---- Batch 3: preparatory works and NSM ---------------------------------
  {
    file: 'prop-109-ls-2022-2023.pdf',
    id: 'prop109',
    short: 'Prop. 109 LS (2022–2023)',
    title: 'Prop. 109 LS (2022–2023) Lov om digital sikkerhet (digitalsikkerhetsloven)',
    lang: 'no',
    kind: 'generic',
    sourceType: 'preparatory-works',
    binding: false,
    issuer: 'Justis- og beredskapsdepartementet',
    publishedAt: '2023-05-05',
    url: 'https://www.regjeringen.no/no/-dokumenter/prop.-109-ls-20222023/id2975558/',
    description: 'Preparatory works for digitalsikkerhetsloven',
    batch: 3,
  },
  {
    file: 'nsm-grunnprinsipper-ikt-v2-1.pdf',
    id: 'nsm-gp',
    short: 'NSM Grunnprinsipper',
    title: 'NSMs grunnprinsipper for IKT-sikkerhet, versjon 2.1',
    lang: 'no',
    kind: 'generic',
    sourceType: 'guidance',
    binding: false,
    issuer: 'Nasjonal sikkerhetsmyndighet (NSM)',
    publishedAt: '2024-05-31',
    url: 'https://nsm.no/getfile.php/1313975-1717589722/NSM/Filer/Dokumenter/Veiledere/NSMs%20Grunnprinsipper%20for%20IKT-sikkerhet%20v2.1.pdf',
    description: 'NSM’s basic principles for ICT security (recommendations)',
    batch: 3,
  },

  // ---- Batch 4: CRA, ENISA and data-protection guidance -------------------
  // The 2-page cover note (cra-guidance-c-2026-5252.pdf) is intentionally left
  // out; it is kept in data-pending/excluded/.
  {
    file: 'cra-guidance-c-2026-5252-annex.pdf',
    id: 'cra-guid',
    short: 'Commission CRA guidance',
    title: 'Commission guidance on the application of Regulation (EU) 2024/2847 (Cyber Resilience Act) – Annex to C(2026) 5252',
    lang: 'en',
    kind: 'generic',
    sourceType: 'guidance',
    binding: false,
    issuer: 'European Commission',
    publishedAt: '2026-07-27',
    reference: 'C(2026) 5252',
    url: 'https://digital-strategy.ec.europa.eu/en/library/commission-publishes-new-guidance-support-timely-cyber-resilience-act-implementation',
    description: 'Commission guidance on the application of the CRA',
    batch: 4,
  },
  {
    file: 'enisa-cra-srp-factsheet.pdf',
    id: 'enisa-srp-fs',
    short: 'ENISA SRP factsheet',
    title: 'CRA Single Reporting Platform Factsheet',
    lang: 'en',
    kind: 'generic',
    sourceType: 'guidance',
    binding: false,
    issuer: 'ENISA',
    publishedAt: '2026-09',
    url: 'https://www.enisa.europa.eu/cra-srp/',
    description: 'How to report under the CRA via the Single Reporting Platform',
    batch: 4,
  },
  {
    file: 'enisa-cra-srp-user-manual.pdf',
    id: 'enisa-srp-um',
    short: 'ENISA SRP user manual',
    title: 'CRA Single Reporting Platform – AR User Manual, version 1.1',
    lang: 'en',
    kind: 'generic',
    sourceType: 'guidance',
    binding: false,
    issuer: 'ENISA',
    publishedAt: '2026-09',
    url: 'https://www.enisa.europa.eu/cra-srp/',
    description: 'User manual for the CRA Single Reporting Platform',
    batch: 4,
  },
  {
    file: 'edpb-guidelines-9-2022-breach.pdf',
    id: 'edpb-9-2022',
    short: 'EDPB Guidelines 9/2022',
    title: 'EDPB Guidelines 9/2022 on personal data breach notification under GDPR, version 2.0',
    lang: 'en',
    kind: 'generic',
    sourceType: 'guidance',
    binding: false,
    issuer: 'European Data Protection Board (EDPB)',
    publishedAt: '2023-03-28',
    url: 'https://www.edpb.europa.eu/documents/426_en',
    description: 'EDPB guidance on personal data breach notification',
    batch: 4,
  },
  {
    file: 'datatilsynet-avvik-oppfolging.pdf',
    id: 'dt-avvik',
    short: 'Datatilsynet – oppfølging av avvik',
    title: 'Datatilsynet: Hvordan følge opp bruddet internt?',
    lang: 'no',
    kind: 'generic',
    sourceType: 'guidance',
    binding: false,
    issuer: 'Datatilsynet',
    publishedAt: '',
    url: 'https://www.datatilsynet.no/rettigheter-og-plikter/virksomhetenes-plikter/avvik/hvordan-folge-opp-bruddet-internt/',
    description: 'Datatilsynet on internal follow-up of personal data breaches',
    batch: 4,
  },
  {
    file: 'datatilsynet-etablere-internkontroll.pdf',
    id: 'dt-ik',
    short: 'Datatilsynet – internkontroll',
    title: 'Datatilsynet: Etablere internkontroll',
    lang: 'no',
    kind: 'generic',
    sourceType: 'guidance',
    binding: false,
    issuer: 'Datatilsynet',
    publishedAt: '',
    url: 'https://www.datatilsynet.no/rettigheter-og-plikter/virksomhetenes-plikter/informasjonssikkerhet-internkontroll/etablere-internkontroll/',
    description: 'Datatilsynet guidance on internal control and information security',
    batch: 4,
  },
  {
    file: 'datatilsynet-infosec-internal-control-en.pdf',
    id: 'dt-infosec-en',
    short: 'Datatilsynet – information security (EN)',
    title: 'Datatilsynet: Information security and internal control',
    lang: 'en',
    kind: 'generic',
    sourceType: 'guidance',
    binding: false,
    issuer: 'Datatilsynet',
    publishedAt: '',
    url: 'https://www.datatilsynet.no/rettigheter-og-plikter/virksomhetenes-plikter/informasjonssikkerhet-internkontroll/',
    description: 'Datatilsynet overview of information security and internal control (English)',
    batch: 4,
  },
];

export const ACTIVE_SOURCES = SOURCES.filter((s) => s.batch <= ACTIVE_BATCH);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** '2026-07-27' -> '27 July 2026' */
export function formatDate(iso?: string): string {
  const m = iso?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${parseInt(m[3], 10)} ${MONTHS[parseInt(m[2], 10) - 1]} ${m[1]}` : '';
}

/**
 * Which version of the text the corpus holds, e.g.
 *   'consolidated text as of 27 July 2026'                       (EUR-Lex consolidated version)
 *   'Official Journal text published 1 December 2025'            (EUR-Lex original act)
 *   'Lovdata text last amended 16 October 2026 (LOV-2026-06-23-74)' (Lovdata "Sist endret")
 *   'Lovdata text retrieved 26 September 2026'                   (Lovdata, no "Sist endret")
 */
export function versionLabel(
  src: Pick<
    Source,
    'consolidatedAsOf' | 'officialJournal' | 'publishedAt' | 'lastAmended' | 'lastAmendedBy' | 'retrievedAt'
  >,
): string {
  if (src.consolidatedAsOf) return `consolidated text as of ${formatDate(src.consolidatedAsOf)}`;
  if (src.officialJournal && formatDate(src.publishedAt)) {
    return `Official Journal text published ${formatDate(src.publishedAt)}`;
  }
  if (src.lastAmended) {
    return `Lovdata text last amended ${formatDate(src.lastAmended)}${src.lastAmendedBy ? ` (${src.lastAmendedBy})` : ''}`;
  }
  if (src.retrievedAt) return `Lovdata text retrieved ${formatDate(src.retrievedAt)}`;
  return '';
}

export const SOURCE_TYPE_LABEL: Record<SourceType, string> = {
  legislation: 'Legislation',
  'implementing-act': 'Implementing act',
  'delegated-act': 'Delegated act',
  'preparatory-works': 'Preparatory works',
  guidance: 'Guidance',
};
