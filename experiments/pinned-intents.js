/**
 * Pinned intent vectors.
 *
 * The intent parser is a hosted instruction-tuned model (Section "Intent-Parser
 * Evaluation" of the paper), so the pipeline is NOT reproducible end to end from
 * source: without the same credentials and the same provider revision the parser
 * returns different weight vectors, and the panels that price cost move with
 * those weights. The parser's contribution is reproducible from the vectors
 * recorded here; regenerating the paper's empirical results also requires the
 * frozen registry and leaderboard inputs listed in data/data_schema.json.
 *
 * `intents.frozen.json` holds the full `analysis` object the shipped parser
 * returned for each prompt on the frozen revision. The harnesses call
 * `pinnedIntent(prompt)` instead of `recommendModels()`, which removes the
 * hosted model from the dependency graph without changing any arithmetic.
 */
import { readFileSync } from 'node:fs'

const PINNED = JSON.parse(readFileSync(new URL('./intents.frozen.json', import.meta.url), 'utf8'))

export async function pinnedIntent(prompt) {
  const analysis = PINNED[prompt]
  if (!analysis) throw new Error(`no pinned intent for prompt: ${prompt}`)
  return { analysis }
}

export const PINNED_PROMPTS = Object.keys(PINNED)
