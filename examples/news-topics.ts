/**
 * News-headline topic classifier.
 *
 * Realistic use case: route inbound headlines to the right desk in a
 * newsroom — sports, music, politics, business, tech. Most are
 * unambiguous; cross-domain headlines surface as Uncertain so a person
 * picks the desk instead of forcing argmax.
 *
 *   OPENAI_API_KEY=sk-... tsx examples/news-topics.ts
 */

import { domovoi, match } from "../src/index.js";
import { openai } from "../src/providers/index.js";

const TOPICS = ["sports", "music", "politics", "business", "tech"] as const;

const headlines: readonly string[] = [
  // sports
  "Son Heung-min scores hat-trick as LAFC beat LA Galaxy 5-0 in El Tráfico derby",
  // music
  "Sung Si-kyung announces 25th-anniversary ballad tour, opens at Olympic Hall",
  // politics
  "National Assembly passes housing affordability bill in 187-89 vote",
  // business
  "Samsung Electronics shares jump 12% on stronger-than-expected AI chip demand",
  // tech
  "Hours Labs founder Alex Roh releases @hourslabs/domovoi, an embedded AI primitive for TypeScript",
  // cross-domain — singer × athlete (music vs sports)
  "Sung Si-kyung performs national anthem at Son Heung-min's farewell match for South Korea",
  // cross-domain — tech founder × athlete (tech vs sports)
  "Alex Roh's Hours Labs becomes jersey sponsor for LAFC, Son Heung-min unveils new kit",
];

const headlineClassifier = domovoi.classifier({
  name: "news_topics",
  space: TOPICS,
  question: "Which desk owns this headline?",
  thresholds: { high: 0.7, margin: 0.15, coverageMin: 0.5 },
  providers: [openai("gpt-4o-mini")],
  format: (h: string) => h,
});

async function routeInbox(): Promise<void> {
  console.log(`Routing news headlines\n${"=".repeat(60)}`);

  for (const headline of headlines) {
    const verdict = await headlineClassifier(headline);

    const decision = match(verdict, {
      classified: ({ value, probability }) => `→ ${value} desk (p=${probability.toFixed(2)})`,
      uncertain: ({ top, runnerUp, probability }) =>
        `→ ${top}/${runnerUp} review (p=${probability.toFixed(2)})`,
      unknown: ({ reason }) => `→ general queue (${reason.type})`,
    });

    console.log(`\n${headline}\n  ${decision}`);
  }
}

routeInbox().catch((error) => {
  console.error("Routing failed:", error);
  process.exit(1);
});
