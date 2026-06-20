/**
 * Model configuration for Sanctum.
 *
 * Hardware target (this machine): 16 GB RAM, NVIDIA GTX 1650 Ti (4 GB VRAM, Vulkan), Linux, Node 24.
 *
 * QVAC's Linux GPU backend is VULKAN (not CUDA). The 1650 Ti supports Vulkan 1.3 via the NVIDIA
 * driver. With only 4 GB VRAM:
 *   - MedPsy-1.7B Q4_K_M (~1.28 GB) fits in VRAM with room for a moderate KV cache -> primary model.
 *   - MedPsy-4B  Q4_K_M (~2.72 GB) will NOT fully fit 4 GB VRAM -> run on CPU (16 GB RAM is plenty)
 *     or partial GPU offload. Use as the "quality tier" comparison clip only.
 *
 * Start CPU-first for reliability; switch to GPU offload after `npm run doctor` confirms Vulkan.
 * Control at runtime with env vars: QVAC_DEVICE=gpu|cpu  QVAC_GPU_LAYERS=<n>  QVAC_CTX=<tokens>
 */

export interface SanctumModel {
  key: string;
  /** Path to the GGUF on disk (downloaded by scripts/download-models.sh). NOTE the -imat suffix. */
  path: string;
  name: string;
  approxBytes: number;
}

export const SANCTUM_MODELS: Record<string, SanctumModel> = {
  'medpsy-1.7b': {
    key: 'medpsy-1.7b',
    path: 'models/medpsy-1.7b-q4_k_m-imat.gguf',
    name: 'MedPsy-1.7B Q4_K_M',
    approxBytes: 1_282_439_360,
  },
  'medpsy-4b': {
    key: 'medpsy-4b',
    path: 'models/medpsy-4b-q4_k_m-imat.gguf',
    name: 'MedPsy-4B Q4_K_M',
    approxBytes: 2_716_068_640,
  },
};

export const DEFAULT_MODEL_KEY = process.env.SANCTUM_MODEL ?? 'medpsy-1.7b';

/**
 * loadModel() modelConfig. Verified keys for @qvac/sdk@0.12.2: ctx_size, gpu_layers, device, verbosity.
 * Defaults are CPU-first + 8k context; bump QVAC_CTX high (e.g. 32768) for the TurboQuant long-context demo.
 */
export const MODEL_CONFIG = {
  ctx_size: Number(process.env.QVAC_CTX ?? 8192),
  // 0 = CPU only. Once Vulkan is confirmed, offload layers (e.g. 999 = all that fit) for the 1.7B model.
  gpu_layers: Number(process.env.QVAC_GPU_LAYERS ?? 0),
  device: (process.env.QVAC_DEVICE ?? 'cpu') as 'cpu' | 'gpu',
  verbosity: 1,
};

/**
 * Generation params. MedPsy is fine-tuned from Qwen3-*Thinking*, so it emits <think>...</think> before
 * the answer. `predict` (the token budget) MUST be high (>=2048) or the response truncates INSIDE the
 * reasoning block and comes back empty — the single most common reason a casual MedPsy demo "doesn't work".
 *
 * VERIFIED against @qvac/sdk@0.12.2 (schemas/completion-stream.d.ts → `generationParamsSchema`, a STRICT
 * Zod object). Params are nested under `generationParams` on completion(); the only accepted keys are:
 *   temp, top_p, top_k, predict, seed, frequency_penalty, presence_penalty, repeat_penalty, reasoning_budget.
 * Gotcha: it is `temp` (NOT `temperature`) and `predict` (NOT `n_predict`/`max_tokens`) — any unknown key
 * is rejected at runtime with a ZodError. Set QVAC_SEED for a deterministic run so the perf-log / video /
 * screenshots show identical numbers (the reproducibility claim in the README).
 */
export const GEN_PARAMS: Record<string, number> = {
  temp: 0.6,
  top_p: 0.95,
  top_k: 20,
  predict: Number(process.env.QVAC_PREDICT ?? 2048),
  ...(process.env.QVAC_SEED ? { seed: Number(process.env.QVAC_SEED) } : {}),
};

export function resolveModel(key = DEFAULT_MODEL_KEY): SanctumModel {
  const m = SANCTUM_MODELS[key];
  if (!m) throw new Error(`Unknown model '${key}'. Options: ${Object.keys(SANCTUM_MODELS).join(', ')}`);
  return m;
}
