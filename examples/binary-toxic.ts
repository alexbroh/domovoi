/**
 * Comment moderation with binary deadband.
 *
 * The realistic shape: a community platform receives user comments and
 * needs three outcomes — auto-publish (clearly fine), auto-block (clearly
 * toxic), and hold-for-human-review (ambiguous). The deadband
 * (`high: 0.7, low: 0.3`) creates that third state explicitly: anything
 * in the wavering zone goes to the moderation queue rather than getting
 * a forced binary call.
 *
 *   OPENAI_API_KEY=sk-... tsx examples/binary-toxic.ts
 */

import { domovoi, match } from "../src/index.js";

type Comment = {
  readonly id: string;
  readonly authorHandle: string;
  readonly text: string;
};

const incomingComments: readonly Comment[] = [
  {
    id: "c-001",
    authorHandle: "@kindreader",
    text: "Have a great day! Hope your project goes well.",
  },
  {
    id: "c-002",
    authorHandle: "@anon_42",
    text: "I hate this whole community and everyone in it.",
  },
  {
    id: "c-003",
    authorHandle: "@discourse",
    text: "I disagree with you but I respect your reasoning. Here's why I see it differently...",
  },
  {
    id: "c-004",
    authorHandle: "@brevity",
    text: "lol wat",
  },
  {
    id: "c-005",
    authorHandle: "@ambivalent",
    text: "I hate this product but I'm not going to bash anyone for liking it.",
  },
];

async function moderateBatch(): Promise<void> {
  console.log(`Moderating incoming comments\n${"=".repeat(60)}`);

  for (const comment of incomingComments) {
    const toxicityVerdict = await domovoi.boolean(
      comment.text,
      "Is this comment toxic, abusive, or harassing toward other users or groups?",
      {
        thresholds: { high: 0.7, low: 0.3, coverageMin: 0.5 },
        signal: AbortSignal.timeout(5_000),
      },
    );

    const moderationAction = match(toxicityVerdict, {
      classified: ({ value, probability }) =>
        value === "yes"
          ? `BLOCKED (toxicity p=${probability.toFixed(2)}); notify author`
          : `PUBLISHED (toxicity p=${probability.toFixed(2)})`,
      uncertain: ({ probability }) =>
        `HOLD for human review (wavering, p=${probability.toFixed(2)})`,
      unknown: ({ reason }) => `HOLD for human review (model unavailable: ${reason.type})`,
    });

    console.log(`\n[${comment.id}] ${comment.authorHandle}: ${truncate(comment.text, 70)}`);
    console.log(`  → ${moderationAction}`);
  }
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

moderateBatch().catch((error) => {
  console.error("Moderation failed:", error);
  process.exit(1);
});
