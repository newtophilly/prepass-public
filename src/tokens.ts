/**
 * Token estimation — a transport-agnostic text utility.
 *
 * Lives here (not in the curator) so the pipeline and router can size prompts
 * without importing curation internals. ~4 chars/token is good enough for
 * budgeting; swap for a real tokenizer if exact counts ever matter.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
