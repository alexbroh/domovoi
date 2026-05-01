/**
 * Example: 3-class sentiment classifier.
 *
 * Run:
 *   OPENAI_API_KEY=sk-... tsx examples/sentiment.ts
 *
 * Demonstrates:
 *   - Multi-class classifier with `classifier({...})`
 *   - Inclusive `>=` threshold (L1)
 *   - Per-classifier in-memory cache (J1)
 *   - The `match` exhaustive helper
 */

import { domovoi, match } from "../src/index.js";
import { openai } from "../src/providers/index.js";

const REVIEWS = [
  "I love this product, it has changed my life for the better.",
  "It's fine, does what it says on the tin.",
  "Absolute garbage. Do not buy.",
  "Hard to tell — works one day, broken the next.",
  "The new keyboard layout took me a while but I really like it now.",
];

async function main(): Promise<void> {
  const sentiment = domovoi.classifier({
    name: "sentiment",
    space: ["positive", "neutral", "negative"] as const,
    question: "Which sentiment best describes this review?",
    thresholds: { high: 0.6, margin: 0.15, coverageMin: 0.5 },
    providers: [openai("gpt-4o-mini")],
  });

  console.log("=".repeat(60));
  console.log("3-class sentiment classifier (positive / neutral / negative)");
  console.log("=".repeat(60));

  for (const review of REVIEWS) {
    const verdict = await sentiment(review);
    const summary = match(verdict, {
      classified: ({ value, probability }) => `✓ ${value.padEnd(8)} (p=${probability.toFixed(3)})`,
      uncertain: ({ top, runnerUp, probability }) =>
        `~ ${top.padEnd(8)} vs ${runnerUp} (top p=${probability.toFixed(3)})`,
      unknown: ({ reason }) => `? ${reason.type}`,
    });
    console.log(`\n  ${review}`);
    console.log(`  → ${summary}`);
  }
}

main().catch((err) => {
  console.error("Example failed:", err);
  process.exit(1);
});
