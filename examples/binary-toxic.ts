/**
 * Example: binary toxicity classifier with deadband.
 *
 * Run:
 *   OPENAI_API_KEY=sk-... tsx examples/binary-toxic.ts
 *
 * Demonstrates:
 *   - One-shot binary verb (`domovoi.boolean`)
 *   - Binary deadband: high=0.7, low=0.3 → confident yes, confident no, or wavering
 *   - Cancellation via AbortSignal.timeout
 */

import { domovoi, isClassified, isUncertain } from "../src/index.js";

const COMMENTS = [
  "Have a great day! Hope your project goes well.",
  "I hate this whole community and everyone in it.",
  "I disagree with you but I respect your view.",
  "lol wat",
  "I hate this product but I'm not going to bash anyone.",
];

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Binary toxicity classifier (deadband: high=0.7, low=0.3)");
  console.log("=".repeat(60));

  for (const comment of COMMENTS) {
    const verdict = await domovoi.boolean(comment, "Is this comment toxic?", {
      signal: AbortSignal.timeout(5_000),
      thresholds: { high: 0.7, low: 0.3, coverageMin: 0.3 },
    });

    console.log(`\n  ${comment.slice(0, 60)}`);
    if (isClassified(verdict)) {
      const label = verdict.value === "yes" ? "TOXIC" : "ok";
      console.log(`  → ${label} (p=${verdict.probability.toFixed(3)})`);
    } else if (isUncertain(verdict)) {
      console.log(`  → wavering (top=${verdict.top}, p=${verdict.probability.toFixed(3)})`);
    } else {
      console.log(`  → unknown (reason=${verdict.reason.type})`);
    }
  }
}

main().catch((err) => {
  console.error("Example failed:", err);
  process.exit(1);
});
