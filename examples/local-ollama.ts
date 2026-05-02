/**
 * Local-first classification — data never leaves your machine.
 *
 * The realistic shape: a personal-notes app classifies entries by topic
 * for organization. The user wouldn't want their journal contents shipped
 * to a cloud LLM, so the entire classifier runs against a local Ollama
 * instance. No API key, no network egress, no cost per call.
 *
 *   ollama pull llama-3.1
 *   ollama serve   # if not already running
 *   tsx examples/local-ollama.ts
 */

import { domovoi, match } from "../src/index.js";
import { ollama } from "../src/providers/index.js";

type JournalEntry = {
  readonly date: string;
  readonly text: string;
};

const recentEntries: readonly JournalEntry[] = [
  {
    date: "2026-04-28",
    text: "Long run this morning, 12k. Legs felt heavy in the last 3k but pace held. Trying the new shoes for tomorrow's interval session.",
  },
  {
    date: "2026-04-29",
    text: "Quarterly review prep. Team velocity is up but lead time on bugs is creeping. Need to talk to manager about owning the on-call rotation differently.",
  },
  {
    date: "2026-04-30",
    text: "Mom's birthday dinner went well. She loved the photo book. Note for next year: book the restaurant 3 weeks ahead, not 1.",
  },
  {
    date: "2026-05-01",
    text: "Sourdough loaf #4. Crust was better but the crumb is still too dense. Need to retry with a longer bulk ferment — maybe 6 hours instead of 4.",
  },
];

const ENTRY_CATEGORIES = ["fitness", "work", "family", "hobby"] as const;

const categorizer = domovoi.classifier<(typeof ENTRY_CATEGORIES)[number], JournalEntry>({
  name: "journal_entries",
  space: ENTRY_CATEGORIES,
  question: "Which area of life does this journal entry primarily concern?",
  thresholds: { high: 0.6, margin: 0.1, coverageMin: 0.4 },
  providers: [ollama("llama-3.1")],
  format: (entry) => `[${entry.date}] ${entry.text}`,
});

async function categorizeRecent(): Promise<void> {
  console.log(`Categorizing journal entries (local-only)\n${"=".repeat(60)}`);

  for (const entry of recentEntries) {
    const categoryVerdict = await categorizer(entry);

    const summary = match(categoryVerdict, {
      classified: ({ value, probability }) => `${value} (p=${probability.toFixed(2)})`,
      uncertain: ({ top, runnerUp, probability }) =>
        `unsure: ${top} or ${runnerUp} (p=${probability.toFixed(2)})`,
      unknown: ({ reason }) => `unknown (${reason.type})`,
    });

    console.log(`\n[${entry.date}] ${entry.text.slice(0, 80)}…`);
    console.log(`  → ${summary}`);
  }
}

categorizeRecent().catch((error) => {
  console.error("Categorization failed:", error);
  console.error("\nIs Ollama running? Try: ollama serve && ollama pull llama-3.1");
  process.exit(1);
});
