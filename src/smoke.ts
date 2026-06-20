/**
 * smoke.ts — DAY-0 SMOKE TEST. Run this FIRST, before building any features.
 *
 *   1. npm install                 (expect ~3.7 GB of node_modules — all native runtimes)
 *   2. npm run doctor              (optional: validates host/GPU; needs @qvac/cli)
 *   3. npm run models              (downloads MedPsy-1.7B GGUF, ~1.28 GB)
 *   4. npm run smoke               (this file)
 *
 * It loads MedPsy-1.7B, runs ONE streamed completion, writes a compliant perf-log row, and dumps the
 * profiler artifacts. If this prints a real answer + non-null TTFT/tokens-per-sec, the whole stack
 * (install, native backend, model load, streaming, stats, logging) is verified on THIS machine.
 *
 * This is also where you confirm the two open API questions:
 *   (a) does generation respect GEN_PARAMS (does the answer truncate inside <think>)?
 *   (b) are stats.timeToFirstToken / tokensPerSecond populated, or do the wall-clock fallbacks kick in?
 */

import { profiler } from '@qvac/sdk';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadModelLogged, profiledCompletion, unloadModelLogged } from './perflog';
import { resolveModel, MODEL_CONFIG, GEN_PARAMS } from './models';

const LOG = 'artifacts/perf-log.jsonl';
const ART = 'artifacts';

async function main() {
  mkdirSync(ART, { recursive: true });

  // Verbose mode is REQUIRED to harvest model-load gauges into recentEvents.
  profiler.enable({ mode: 'verbose', includeServerBreakdown: true } as any);

  const model = resolveModel();
  console.log(`Loading ${model.name} from ${model.path} (device=${MODEL_CONFIG.device}, ctx=${MODEL_CONFIG.ctx_size}) …`);

  const modelId = await loadModelLogged(
    {
      modelSrc: resolve(model.path),
      modelType: 'llm',
      modelConfig: MODEL_CONFIG,
      onProgress: (p: unknown) => process.stdout.write(`\r  load/download: ${JSON.stringify(p)}        `),
    },
    LOG,
  );
  console.log(`\n  loaded as modelId=${modelId}`);

  console.log('\nRunning a test completion …\n');
  const result = await profiledCompletion(
    {
      modelId,
      history: [
        { role: 'user', content: 'In two short sentences, explain what on-device/edge AI is and one reason privacy benefits from it.' },
      ],
      generationParams: GEN_PARAMS,
      captureThinking: true,
    },
    { logPath: LOG, modelName: model.name },
  );

  console.log('--- ANSWER ---');
  console.log(result.text.trim() || '(empty — if blank, raise QVAC_PREDICT; MedPsy is a Thinking model)');
  console.log('--- STATS ---');
  console.log(JSON.stringify(result.stats, null, 2));

  await unloadModelLogged(modelId, LOG);

  // Dump the profiler artifacts (the .txt doubles as a clean "performance" screenshot source).
  try {
    writeFileSync(`${ART}/profiler.json`, JSON.stringify((profiler as any).exportJSON(), null, 2));
    writeFileSync(`${ART}/profiler.txt`, `${(profiler as any).exportSummary()}\n\n${(profiler as any).exportTable()}`);
    console.log(`\nProfiler artifacts written to ${ART}/profiler.json and ${ART}/profiler.txt`);
  } catch (e) {
    console.warn('profiler export failed (non-fatal):', e);
  }
  (profiler as any).disable?.();

  console.log(`\nPerf log appended to ${LOG}. ✅ Smoke test complete.`);
}

main().catch((e) => {
  console.error('\n❌ Smoke test failed:', e);
  console.error('\nTroubleshooting: run `npm run doctor`; if Vulkan errors, set QVAC_DEVICE=cpu QVAC_GPU_LAYERS=0 and retry. Ensure the GGUF downloaded (npm run models).');
  process.exit(1);
});
