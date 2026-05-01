/**
 * Prompt template — default classifier prompt and override semantics.
 *
 * Default template (locked in v0):
 *   system: "You are a careful classifier. Output exactly one of: {labels_csv}. No other text."
 *   user:   "{question}\n{input}"   (single newline; question undefined → just input)
 *
 * {labels_csv} uses USER-GIVEN order (K3); never sorted.
 *
 * User overrides MUST supply their own `templateHash` so cache key composition
 * stays correct (R14). The library default carries hardcoded hash
 * "domovoi/v0-default".
 */

import type { PromptTemplate } from "./types.js";

const DEFAULT_TEMPLATE_HASH = "domovoi/v0-default";

/**
 * Built-in classifier template. Reads the input verbatim (no truncation in v0,
 * per L4 / R15) and emits a CSV of labels in user-given order.
 */
export const defaultTemplate: PromptTemplate = {
  systemPrompt: "You are a careful classifier. Output exactly one of: {labels_csv}. No other text.",
  userTemplate: (input: string, _space: ReadonlyArray<string>, question?: string): string => {
    if (question === undefined) return input;
    return `${question}\n${input}`;
  },
  templateHash: DEFAULT_TEMPLATE_HASH,
};

/**
 * Render the system prompt by substituting `{labels_csv}` with the user-given
 * label order. Returns `undefined` if the template has no system prompt.
 */
export function renderSystemPrompt(
  template: PromptTemplate,
  space: ReadonlyArray<string>,
): string | undefined {
  if (template.systemPrompt === undefined) return undefined;
  return template.systemPrompt.replace("{labels_csv}", space.join(", "));
}

/**
 * Render the user message by invoking the template's `userTemplate` callback
 * with the formatted input, the space (user-given order), and an optional
 * question.
 */
export function renderUserPrompt(
  template: PromptTemplate,
  input: string,
  space: ReadonlyArray<string>,
  question?: string,
): string {
  return template.userTemplate(input, space, question);
}
