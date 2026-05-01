/**
 * Support-ticket sentiment triage.
 *
 * The realistic shape: every customer message a small business receives is
 * either a thank-you, a complaint, or something in between. The work isn't
 * "what is the sentiment" — it's *which queue does this go to*. This example
 * runs `domovoi.classify` over a handful of inbound tickets and dispatches
 * each into the appropriate routing decision via `match`.
 *
 *   OPENAI_API_KEY=sk-... tsx examples/sentiment.ts
 */

import { domovoi, match } from "../src/index.js";
import { openai } from "../src/providers/index.js";

type SupportTicket = {
  readonly subject: string;
  readonly body: string;
  readonly customerEmail: string;
};

const inboundTickets: readonly SupportTicket[] = [
  {
    subject: "Best purchase I've made all year",
    body: "Just wanted to say this thing is incredible. Setup took 5 minutes and it's been flawless for 3 weeks now.",
    customerEmail: "happy.customer@example.com",
  },
  {
    subject: "Order #4821 — broken on arrival",
    body: "Received yesterday. Display is cracked, the corner is dented, and the power button is stuck. This is unacceptable for the price.",
    customerEmail: "frustrated@example.com",
  },
  {
    subject: "question about return policy",
    body: "Hi, I'm thinking about ordering but wanted to know how long the return window is and whether I'd pay shipping. Thanks.",
    customerEmail: "considering@example.com",
  },
  {
    subject: "follow-up on warranty",
    body: "Works fine most of the time but occasionally won't connect to wifi. Not a huge deal, just letting you know.",
    customerEmail: "minor.issue@example.com",
  },
  {
    subject: "Re: My recent order",
    body: "took a couple weeks to arrive but everything was packaged well and works as described. happy enough.",
    customerEmail: "neutral.buyer@example.com",
  },
];

const sentimentClassifier = domovoi.classifier<"positive" | "neutral" | "negative", SupportTicket>({
  name: "support_sentiment",
  space: ["positive", "neutral", "negative"] as const,
  question: "What is the customer's emotional tone in this support ticket?",
  thresholds: { high: 0.65, margin: 0.15, coverageMin: 0.5 },
  providers: [openai("gpt-4o-mini")],
  format: (ticket) => `Subject: ${ticket.subject}\n\n${ticket.body}`,
});

const ROUTING_BY_SENTIMENT = {
  positive: "thank-you autoresponder + flag for testimonial-request workflow",
  neutral: "standard support queue (24h SLA)",
  negative: "escalate to senior support + 1h SLA",
} as const;

async function triageInbox(): Promise<void> {
  console.log(`Triaging support inbox\n${"=".repeat(60)}`);

  for (const ticket of inboundTickets) {
    const sentiment = await sentimentClassifier(ticket);

    const routingDecision = match(sentiment, {
      classified: ({ value, probability }) =>
        `route → ${ROUTING_BY_SENTIMENT[value]} (sentiment=${value}, p=${probability.toFixed(2)})`,
      uncertain: ({ top, runnerUp, probability }) =>
        `route → human review queue (top=${top}, runnerUp=${runnerUp}, p=${probability.toFixed(2)})`,
      unknown: ({ reason }) => `route → triage queue (reason=${reason.type})`,
    });

    console.log(`\n[${ticket.customerEmail}] "${ticket.subject}"`);
    console.log(`  ${routingDecision}`);
  }
}

triageInbox().catch((error) => {
  console.error("Triage failed:", error);
  process.exit(1);
});
