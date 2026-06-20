/**
 * perflog.ts — the forensic evidence layer.
 *
 * WHY THIS EXISTS: the QVAC hackathon requires a machine-readable inference log capturing, per call,
 * the prompt, token counts, TTFT (time-to-first-token) and tokens/sec, plus model load/unload events.
 * Stage-2 of judging is an *artifact-consistency* review that cross-checks this log against the demo
 * video and the system-profiler screenshots. Inconsistent or incomplete logs are the #1 way teams fail.
 *
 * CRITICAL GOTCHA (verified in SDK source): the QVAC `profiler` does NOT emit TTFT or tokens/sec — it
 * only records timing PHASES and model-load gauges. The per-call generation metrics live on the value
 * returned by `completion()` (its `.stats`). So we must JOIN them ourselves into one JSONL row per call.
 *
 * Field names verified for @qvac/sdk@0.12.2 completion stats:
 *   timeToFirstToken, tokensPerSecond, promptTokens, generatedTokens, cacheTokens, backendDevice
 *   (NOTE: it is `generatedTokens`, NOT `completionTokens`/`totalTokens` — those belong to embed()).
 *
 * Every row is keyed by the SDK's own `requestId` so reviewers can trivially line up
 * log <-> video <-> profiler. Always DISPLAY the same tokensPerSecond in the video that you log here.
 */

import { completion, loadModel, unloadModel, profiler } from '@qvac/sdk';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export const SDK_VERSION = '@qvac/sdk@0.12.2';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function appendJsonl(logPath: string, row: Record<string, unknown>): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(row) + '\n');
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ProfiledCompletionParams {
  modelId: string;
  history: ChatMessage[];
  /** see GEN_PARAMS note in models.ts — location may be top-level vs nested; confirm on smoke test. */
  generationParams?: Record<string, unknown>;
  /** route <think> blocks into a separate stream so the perf log can distinguish reasoning tokens. */
  captureThinking?: boolean;
  [k: string]: unknown;
}

export interface CompletionResult {
  text: string;
  thinkingText?: string;
  stats: Record<string, unknown>;
  requestId?: string;
  stopReason?: string;
}

/**
 * Run a streamed completion and append exactly one compliant perf-log row.
 *
 * Uses the 0.12.2 legacy streaming surface (`tokenStream` + `stats`), which is verified to run on the
 * version this project pins. If you switch to @qvac/sdk@main (0.13.0, for the P2P fix), you may prefer
 * the newer `run.events` / `run.final` API — the row schema below stays identical.
 */
export async function profiledCompletion(
  params: ProfiledCompletionParams,
  opts: { logPath: string; modelName?: string },
): Promise<CompletionResult> {
  const t0 = performance.now();
  let firstTokenAt: number | undefined;

  const run: any = completion({ stream: true, ...params });

  let text = '';
  // Legacy streaming surface (0.12.2): async generator of string tokens.
  for await (const tok of run.tokenStream as AsyncIterable<string>) {
    if (firstTokenAt === undefined) firstTokenAt = performance.now();
    text += tok;
  }

  const stats = ((await run.stats) ?? {}) as Record<string, any>;
  const wallclockMs = performance.now() - t0;
  const lastUser = [...params.history].reverse().find((m) => m.role === 'user');

  // TTFT fallback: if the SDK didn't report it, use our own first-token wall-clock timestamp.
  const ttft =
    stats.timeToFirstToken ?? (firstTokenAt !== undefined ? Math.round(firstTokenAt - t0) : null);
  // tokens/sec fallback: derive from generatedTokens and the post-TTFT generation window.
  const tps =
    stats.tokensPerSecond ??
    (stats.generatedTokens && ttft != null && wallclockMs > ttft
      ? +(stats.generatedTokens / ((wallclockMs - ttft) / 1000)).toFixed(2)
      : null);

  const row = {
    ts: new Date().toISOString(),
    event: 'completion',
    sdkVersion: SDK_VERSION,
    requestId: run.requestId ?? null,
    modelId: params.modelId,
    modelName: opts.modelName ?? null,
    promptSha256: sha256(JSON.stringify(params.history)),
    promptChars: lastUser?.content.length ?? null,
    promptTokens: stats.promptTokens ?? null,
    generatedTokens: stats.generatedTokens ?? null,
    cacheTokens: stats.cacheTokens ?? null,
    ttft_ms: ttft,
    tokens_per_sec: tps,
    wallclock_ms: Math.round(wallclockMs),
    backendDevice: stats.backendDevice ?? null,
    stopReason: stats.stopReason ?? run.stopReason ?? null,
    outputChars: text.length,
  };
  appendJsonl(opts.logPath, row);

  return {
    text,
    thinkingText: run.thinkingText,
    stats,
    requestId: run.requestId,
    stopReason: row.stopReason ?? undefined,
  };
}

/** Load a model and log a `model_loaded` row, harvesting native profiler gauges if available. */
export async function loadModelLogged(
  loadOpts: Record<string, unknown>,
  logPath: string,
): Promise<string> {
  const t0 = performance.now();
  const modelId = (await loadModel(loadOpts as any)) as unknown as string;

  // Native load gauges live in the profiler's recentEvents (only when profiler is in 'verbose' mode).
  let gauges: unknown = null;
  let tags: unknown = null;
  try {
    const ev = (profiler as any)
      .exportJSON?.()
      ?.recentEvents?.find((e: any) => e.op === 'loadModel' && e.kind === 'handler');
    gauges = ev?.gauges ?? null;
    tags = ev?.tags ?? null;
  } catch {
    /* profiler not enabled / shape differs — non-fatal */
  }

  appendJsonl(logPath, {
    ts: new Date().toISOString(),
    event: 'model_loaded',
    sdkVersion: SDK_VERSION,
    modelId,
    modelSrc: (loadOpts as any).modelSrc ?? null,
    wallclock_ms: Math.round(performance.now() - t0),
    gauges,
    tags,
  });
  return modelId;
}

/** Unload a model and log a `model_unloaded` row (unloadModel returns void — we time it ourselves). */
export async function unloadModelLogged(modelId: string, logPath: string): Promise<void> {
  const t0 = performance.now();
  await unloadModel({ modelId } as any);
  appendJsonl(logPath, {
    ts: new Date().toISOString(),
    event: 'model_unloaded',
    sdkVersion: SDK_VERSION,
    modelId,
    wallclock_ms: Math.round(performance.now() - t0),
  });
}
