/**
 * agent.ts — Sanctum's core: ask a question across your entire private corpus, fully offline.
 *
 *   npm run ask -- "What medications is the patient currently taking, and were any discontinued?"
 *
 * This is the SAFE CORE (long-context Q&A over a local document folder, with injection defense and a
 * compliant perf log). It is fully runnable once the smoke test passes. Two upgrades come next:
 *   - TODO(rag): for corpora too large to fit in context, add QVAC embeddings + a local vector store
 *     (LanceDB / sqlite-vector) and retrieve top-k chunks instead of stuffing everything. Counts toward
 *     the "QVAC usage = whole stack" criterion.
 *   - TODO(turboquant): enable KV-cache compression and push QVAC_CTX to 32768+ to make "long context
 *     on a 4 GB GPU" the demo's headline. Confirm the exact config flag in the installed SDK/docs
 *     (likely a kvCache / cache-quant option) — do NOT guess the key name; verify, then log the
 *     before/after KV-cache memory in artifacts/perf-log.jsonl.
 */

import { profiler } from '@qvac/sdk';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadModelLogged, profiledCompletion, unloadModelLogged } from './perflog';
import { resolveModel, MODEL_CONFIG, GEN_PARAMS } from './models';
import { loadCorpus, buildLongContextPrompt, estimateTokens } from './corpus';

const LOG = 'artifacts/perf-log.jsonl';
const CORPUS_DIR = process.env.SANCTUM_CORPUS ?? 'docs/sample-records';

async function main() {
  const question =
    process.argv.slice(2).join(' ').trim() ||
    'Summarize this person’s health history and flag anything that needs follow-up. Cite documents.';

  mkdirSync('artifacts', { recursive: true });
  profiler.enable({ mode: 'verbose', includeServerBreakdown: true } as any);

  const docs = loadCorpus(CORPUS_DIR);
  const messages = buildLongContextPrompt(docs, question);
  console.log(`Corpus: ${docs.length} documents (${docs.map((d) => d.id).join(', ')})`);
  console.log(`Approx context size: ~${estimateTokens(messages)} tokens (ctx_size=${MODEL_CONFIG.ctx_size})`);
  if (estimateTokens(messages) > MODEL_CONFIG.ctx_size * 0.9) {
    console.warn('⚠  Corpus is close to / over ctx_size. Raise QVAC_CTX (TurboQuant) or enable RAG retrieval.');
  }
  console.log(`\nQ: ${question}\n`);

  const model = resolveModel();
  const modelId = await loadModelLogged(
    {
      modelSrc: resolve(model.path),
      modelType: 'llm',
      modelConfig: MODEL_CONFIG,
      onProgress: (p: unknown) => process.stdout.write(`\r  load: ${JSON.stringify(p)}        `),
    },
    LOG,
  );
  process.stdout.write('\n');

  const result = await profiledCompletion(
    { modelId, history: messages, generationParams: GEN_PARAMS, captureThinking: true },
    { logPath: LOG, modelName: model.name },
  );

  console.log('=== ANSWER ===');
  console.log(result.text.trim());
  console.log('\n=== PERF ===');
  console.log(
    `ttft=${(result.stats as any).timeToFirstToken ?? 'n/a'}ms  tok/s=${(result.stats as any).tokensPerSecond ?? 'n/a'}  device=${(result.stats as any).backendDevice ?? 'n/a'}  stop=${result.stopReason ?? 'n/a'}`,
  );

  await unloadModelLogged(modelId, LOG);
  try {
    writeFileSync('artifacts/profiler.json', JSON.stringify((profiler as any).exportJSON(), null, 2));
    writeFileSync('artifacts/profiler.txt', `${(profiler as any).exportSummary()}\n\n${(profiler as any).exportTable()}`);
  } catch {
    /* non-fatal */
  }
  (profiler as any).disable?.();
}

main().catch((e) => {
  console.error('\n❌ Sanctum error:', e);
  process.exit(1);
});
