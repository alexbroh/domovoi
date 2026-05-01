/**
 * Example: local LLM via Ollama.
 *
 * Run:
 *   ollama pull llama-3.1
 *   ollama serve  &  # if not already running
 *   tsx examples/local-ollama.ts
 *
 * Demonstrates:
 *   - Local-first provider via the `ollama()` factory (no API key, no cost)
 *   - String-based logprob matching (Ollama tokenizers vary by model)
 *   - Cloud fallback chain (`local → cloud`) for higher confidence on hard cases
 */

import { domovoi, match } from "../src/index.js";
import { ollama, openai } from "../src/providers/index.js";

const TEXTS = [
  "The CPU spec specifies 12 cores at 3.2 GHz with hyperthreading enabled.",
  "Manchester United beat Liverpool 2–1 in extra time.",
  "Bach's Goldberg Variations are widely considered his keyboard masterpiece.",
];

async function main(): Promise<void> {
  const localOnly = domovoi.classifier({
    name: "local",
    space: ["tech", "sports", "music"] as const,
    question: "Which category best fits this text?",
    thresholds: { high: 0.6, coverageMin: 0.4 },
    providers: [ollama("llama-3.1")],
  });

  const hybrid = domovoi.classifier({
    name: "hybrid",
    space: ["tech", "sports", "music"] as const,
    question: "Which category best fits this text?",
    thresholds: { high: 0.7, coverageMin: 0.5 },
    providers: [
      ollama("llama-3.1"),
      ...(process.env.OPENAI_API_KEY ? [openai("gpt-4o-mini")] : []),
    ],
  });

  console.log("=".repeat(60));
  console.log("Local-only Ollama classifier");
  console.log("=".repeat(60));

  for (const text of TEXTS) {
    const verdict = await localOnly(text);
    const summary = match(verdict, {
      classified: ({ value, probability }) =>
        `✓ ${value} (p=${probability.toFixed(3)}, via ${verdict.meta.providerUsed})`,
      uncertain: ({ top, runnerUp }) => `~ ${top} vs ${runnerUp}`,
      unknown: ({ reason }) => `? ${reason.type}`,
    });
    console.log(`\n  ${text.slice(0, 60)}`);
    console.log(`  → ${summary}`);
  }

  if (process.env.OPENAI_API_KEY) {
    console.log("\n", "=".repeat(60));
    console.log("Hybrid: local primary, cloud fallback on uncertainty");
    console.log("=".repeat(60));
    for (const text of TEXTS) {
      const verdict = await hybrid(text);
      console.log(`\n  ${text.slice(0, 60)}`);
      console.log(`  → providerUsed=${verdict.meta.providerUsed}, kind=${verdict.kind}`);
    }
  } else {
    console.log("\n  (Set OPENAI_API_KEY to also run the hybrid example.)");
  }
}

main().catch((err) => {
  console.error("Example failed:", err);
  console.error("\nDid you start Ollama? Run `ollama serve` and `ollama pull llama-3.1`.");
  process.exit(1);
});
