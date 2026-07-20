/**
 * Support ticket routing on the Anthropic multi-sample provider.
 *
 * The Anthropic API exposes no logprobs, so `anthropic()` draws three
 * samples per call and builds the Distribution from verbalized
 * confidence. The payoff of the extra samples is disagreement detection:
 * when the samples split, the ticket is much more likely to be
 * misrouted, and the aggregate probability dips into the `uncertain`
 * band. `high: 0.75` is the recommended threshold for multi-sample
 * providers — unanimous answers land around 0.9, splits around 0.62, so
 * splits go to a human queue instead of the wrong team.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... tsx examples/anthropic-ticket-routing.ts
 */

import { domovoi, match } from "../src/index.js";
import { anthropic } from "../src/providers/index.js";

const TEAMS = ["billing", "technical", "account", "other"] as const;

const ticketRouter = domovoi.classifier({
  name: "ticket-router",
  space: TEAMS,
  providers: [anthropic()],
  thresholds: { high: 0.75 },
});

const tickets = [
  "I was charged twice for my March subscription.",
  "The app crashes every time I open the export dialog.",
  "My teammate can see projects I never shared with them.",
];

for (const ticket of tickets) {
  const verdict = await ticketRouter(ticket);
  const route = match(verdict, {
    classified: ({ value, probability }) => `auto-route → ${value} (p=${probability.toFixed(2)})`,
    uncertain: ({ top, probability }) =>
      `hold for human triage — samples disagreed (leaning ${top}, p=${probability.toFixed(2)})`,
    unknown: ({ reason }) => `hold for human triage (${reason.type})`,
  });
  console.log(`${route}  «${ticket}»`);
}
