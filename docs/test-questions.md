# Test questions

Manual regression set for the assistant. Run each question in a new chat after every seed or prompt change, and check the answer against the expected sources and behaviour below.

A question passes when:

- the answer cites the expected sections inline (other relevant citations are fine);
- the sources panel lists those sections;
- the answer ends with the version of each cited text, using the label from `lib/sources.ts` (for example "consolidated text as of 27 July 2026" for the AI Act, "Official Journal text published 1 December 2025" for Implementing Regulation 2025/2392, "Lovdata text retrieved 26 September 2026" for digitalsikkerhetsloven);
- nothing is stated that the retrieved text does not support.

| # | Question | Expected sources | Expected behaviour |
|---|---|---|---|
| 1 | Under what conditions may providers of high-risk AI systems process special categories of personal data to detect and correct bias? | AI Act – Article 4a | Lists the conditions in Article 4a (strictly necessary, cannot be done with synthetic or anonymised data, safeguards). Article 4a is an inserted article, so this checks that inserted articles are retrieved as their own section. |
| 2 | How does the AI Act define an "AI system"? | AI Act – Article 3(1) | Quotes or closely paraphrases the definition (machine-based system, varying levels of autonomy, may exhibit adaptiveness, infers from input how to generate outputs). Cites the single definition, not Article 3 as a whole. |
| 3 | When is an AI system classified as high-risk under the AI Act? | AI Act – Article 6, AI Act – Annex III | Explains both routes: safety component of, or itself, a product under the Union harmonisation legislation in Annex I that requires third-party conformity assessment (Article 6(1)), and the areas listed in Annex III (Article 6(2)), including the exceptions in Article 6(3). |
| 4 | Which products are critical products with digital elements under Implementing Regulation (EU) 2025/2392? | CRA Implementing Regulation 2025/2392 – Annex II | Names the three categories: hardware devices with security boxes; smart meter gateways within smart metering systems; smartcards or similar devices, including secure elements. May also cite CRA Annex IV. |
| 5 | Hvilke varslingsplikter har tilbydere etter digitalsikkerhetsloven? *(What reporting obligations do providers have under digitalsikkerhetsloven?)* | Digitalsikkerhetsloven – § 8, Digitalsikkerhetsloven – § 11 | Answers in Norwegian. Covers both provider types: providers of essential services (§ 8) and providers of digital services (§ 11) must notify the authority designated by the King without undue delay about incidents with a significant impact on the service. |
| 6 | What are the incident reporting deadlines under NIS2? | None from NIS2. Expected pointers: Digitalsikkerhetsloven – § 8 and § 11 | Passes if the answer (1) declines in the first sentence because NIS2 is outside the sources, (2) gives no NIS2 content, such as its deadlines, and (3) points to the nearest in-scope provisions (digitalsikkerhetsloven § 8 and § 11) with citation tags. A closing line that refers the user to the official NIS2 text or the authorities is allowed. |
