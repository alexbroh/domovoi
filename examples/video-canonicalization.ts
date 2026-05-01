/**
 * Example: motivating use case — video canonicalization.
 *
 * Heterogeneous videos from YouTube / Vimeo / Dailymotion / TikTok use
 * different category taxonomies. Canonicalize them under one shared space.
 *
 * Run:
 *   OPENAI_API_KEY=sk-... tsx examples/video-canonicalization.ts
 *
 * Demonstrates:
 *   - Typed input (`Video`-shaped record) with `format` callback
 *   - Multi-class space with margin rule
 *   - Provider chain with fallback (gpt-4o-mini → gpt-4o)
 *   - Outcome routing per Verdict variant
 */

import { domovoi, isClassified, isUncertain, isUnknown } from "../src/index.js";
import { openai } from "../src/providers/index.js";

type Video = {
  readonly platform: "youtube" | "vimeo" | "dailymotion" | "tiktok";
  readonly platformCategory: string;
  readonly title: string;
  readonly description: string;
};

const CANONICAL_CATEGORIES = [
  "news",
  "education",
  "entertainment",
  "sports",
  "music",
  "tech",
  "lifestyle",
] as const;

const VIDEOS: readonly Video[] = [
  {
    platform: "youtube",
    platformCategory: "Howto & Style",
    title: "How to make sourdough at home",
    description: "From starter to bread, beginner-friendly walkthrough.",
  },
  {
    platform: "vimeo",
    platformCategory: "Documentary",
    title: "Election night recap: state-by-state results",
    description: "Coverage of the 2026 midterms with on-the-ground reporting.",
  },
  {
    platform: "dailymotion",
    platformCategory: "Sports",
    title: "Champions League highlights — quarterfinals",
    description: "Goals, saves, and post-match analysis from this week's matches.",
  },
  {
    platform: "tiktok",
    platformCategory: "(unknown)",
    title: "live concert clip",
    description: "Frontman crowd-surfing during the final song.",
  },
  {
    platform: "youtube",
    platformCategory: "Science & Technology",
    title: "Building a Rust web server from scratch",
    description: "Tokio, axum, and async runtime fundamentals in 30 minutes.",
  },
];

async function main(): Promise<void> {
  const canonicalize = domovoi.classifier<(typeof CANONICAL_CATEGORIES)[number], Video>({
    name: "videos",
    space: CANONICAL_CATEGORIES,
    question: "Pick the single canonical category that best fits this video.",
    format: (v: Video): string =>
      `Platform: ${v.platform}\nPlatform-native category: ${v.platformCategory}\nTitle: ${v.title}\nDescription: ${v.description}`,
    thresholds: { high: 0.6, margin: 0.15, coverageMin: 0.5 },
    providers: [openai("gpt-4o-mini"), openai("gpt-4o")],
  });

  console.log("=".repeat(60));
  console.log("Video canonicalization across heterogeneous platforms");
  console.log("=".repeat(60));

  for (const video of VIDEOS) {
    const verdict = await canonicalize(video);
    console.log(`\n  [${video.platform}/${video.platformCategory}] "${video.title.slice(0, 50)}"`);

    if (isClassified(verdict)) {
      console.log(
        `  → ${verdict.value} (p=${verdict.probability.toFixed(3)}, via ${verdict.meta.providerUsed})`,
      );
    } else if (isUncertain(verdict)) {
      console.log(
        `  → uncertain: ${verdict.top} vs ${verdict.runnerUp} ` +
          `(top p=${verdict.probability.toFixed(3)}, via ${verdict.meta.providerUsed})`,
      );
    } else if (isUnknown(verdict)) {
      switch (verdict.reason.type) {
        case "out_of_distribution":
          console.log(
            `  → unknown (out_of_distribution, would-pick=${verdict.reason.topIfRenormalized})`,
          );
          break;
        case "chain_exhausted":
          console.log(
            `  → unknown (chain_exhausted across ${verdict.reason.providersAttempted} providers)`,
          );
          break;
        case "provider_failure":
          console.log(`  → unknown (provider_failure: ${verdict.reason.errors.length} errors)`);
          break;
        default:
          console.log(`  → unknown (${verdict.reason.type})`);
      }
    }
  }
}

main().catch((err) => {
  console.error("Example failed:", err);
  process.exit(1);
});
