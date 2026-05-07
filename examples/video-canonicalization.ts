/**
 * Cross-platform video canonicalization — the motivating use case.
 *
 * Heterogeneous video sources (YouTube / Vimeo / Dailymotion / TikTok) use
 * different category taxonomies that don't align. A unified product (a
 * media library, a recommendation feed, an analytics pipeline) needs all
 * of them mapped onto one canonical category space.
 *
 * Rules-based mapping is brittle — every platform reorganizes its taxonomy
 * periodically, and the mapping decisions involve genuine ambiguity. AI
 * dispatch handles it: the classifier reads platform metadata + content
 * fields and emits a typed Verdict over the canonical space.
 *
 * Demonstrates: typed input via the `format` callback, multi-class space
 * with margin rule, provider chain (cheap primary → strong fallback on
 * uncertainty), and `match` over Verdict variants for routing.
 *
 *   OPENAI_API_KEY=sk-... tsx examples/video-canonicalization.ts
 */

import { domovoi, match } from "../src/index.js";
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

type CanonicalCategory = (typeof CANONICAL_CATEGORIES)[number];

const videosToCanonicalize: readonly Video[] = [
  {
    platform: "youtube",
    platformCategory: "Howto & Style",
    title: "How to make sourdough at home",
    description: "From starter to finished loaf, beginner-friendly walkthrough.",
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
    description: "Frontman crowd-surfing during the final song of the encore.",
  },
  {
    platform: "youtube",
    platformCategory: "Science & Technology",
    title: "Building a Rust web server from scratch",
    description: "Tokio, axum, and async runtime fundamentals in 30 minutes.",
  },
];

const canonicalizeVideo = domovoi.classifier<CanonicalCategory, Video>({
  name: "video_canonicalization",
  space: CANONICAL_CATEGORIES,
  question: "Pick the single canonical category that best fits this video.",
  format: (video) =>
    [
      `Platform: ${video.platform}`,
      `Platform-native category: ${video.platformCategory}`,
      `Title: ${video.title}`,
      `Description: ${video.description}`,
    ].join("\n"),
  thresholds: { high: 0.6, margin: 0.15, coverageMin: 0.5 },
  providers: [openai("gpt-4o-mini"), openai("gpt-4o")],
});

const UNKNOWN_REASON_DESCRIPTIONS = {
  out_of_distribution: "input doesn't fit any canonical category — propose a new one",
  chain_exhausted: "every model in the chain returned Uncertain — defer to human",
  provider_failure: "every model errored — operational problem, retry later",
  predicate_rejected: "post-hoc validity check failed",
  budget_exhausted: "exceeded budget mid-call",
  budget_exceeded: "scope token budget exhausted",
  cancelled: "request was cancelled",
} as const;

async function canonicalizeBatch(): Promise<void> {
  console.log(`Canonicalizing videos across platforms\n${"=".repeat(60)}`);

  for (const video of videosToCanonicalize) {
    const verdict = await canonicalizeVideo(video);

    const summary = match(verdict, {
      classified: ({ value, probability, meta }) =>
        `${value} (p=${probability.toFixed(2)}, via ${meta.providerUsed})`,
      uncertain: ({ top, runnerUp, probability, meta }) =>
        `uncertain: ${top} vs ${runnerUp} (top p=${probability.toFixed(2)}, via ${meta.providerUsed})`,
      unknown: ({ reason }) => `unknown — ${UNKNOWN_REASON_DESCRIPTIONS[reason.type]}`,
    });

    console.log(`\n[${video.platform} / ${video.platformCategory}] "${video.title}"`);
    console.log(`  → ${summary}`);
  }
}

canonicalizeBatch().catch((error) => {
  console.error("Canonicalization failed:", error);
  process.exit(1);
});
