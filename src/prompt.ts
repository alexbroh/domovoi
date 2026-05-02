/**
 * Default classifier prompt template and rendering helpers.
 *
 * Labels render in user-given order (never sorted) so prompt-position bias
 * is the caller's choice. Custom templates must supply their own
 * `templateHash` so cache keys stay correct.
 */

import type { PromptTemplate } from "./types.js";

const DEFAULT_TEMPLATE_HASH = "domovoi/v0-default";

export const defaultTemplate: PromptTemplate = {
  systemPrompt: "You are a careful classifier. Output exactly one of: {labels_csv}. No other text.",
  userTemplate: (input: string, _space: readonly string[], question?: string): string =>
    question === undefined ? input : `${question}\n${input}`,
  templateHash: DEFAULT_TEMPLATE_HASH,
};

/** Substitute `{labels_csv}` in the system prompt; `undefined` if there isn't one. */
export function renderSystemPrompt(
  template: PromptTemplate,
  space: readonly string[],
): string | undefined {
  if (template.systemPrompt === undefined) return undefined;
  return template.systemPrompt.replace("{labels_csv}", space.join(", "));
}

/** Render the user message via the template's `userTemplate` callback. */
export function renderUserPrompt(
  template: PromptTemplate,
  input: string,
  space: readonly string[],
  question?: string,
): string {
  return template.userTemplate(input, space, question);
}
