# Sanctum — your private records, analyzed on-device

**A fully-offline, long-context analyst for your most sensitive documents. Sanctum answers complex
questions across an entire private archive — running a small QVAC model on your own laptop, with zero
bytes leaving the device.**

> Submission for the Tether **QVAC "Unleash Edge AI"** hackathon · Track: **General Purpose** ·
> Built entirely on [`@qvac/sdk`](https://github.com/tetherto/qvac).

Intelligence shouldn't be rented. Sanctum proves that private, local-first, decentralized AI is
production-ready *today*: a 1.7B–4B MedPsy model — small enough to run on a 4 GB consumer GPU — reasons
over a whole corpus of records and returns **cited** answers, fully offline.

---

## Why this is different
- **100% on-device.** No prompt, document, embedding, or model output ever touches a network at
  runtime. See [`remote-api-calls.json`](./remote-api-calls.json) — the runtime remote-call list is empty.
  Verify it yourself: disconnect the network and run the demo.
- **Long context on modest hardware.** Built around QVAC's TurboQuant KV-cache compression so a large
  corpus fits in context on a 4 GB GPU. *(in progress — see PLAN.md)*
- **Small model, real quality.** MedPsy-4B edges MedGemma-27B on Tether's medical benchmarks at ~7× smaller.
- **Injection-resistant by design.** Documents are untrusted input; Sanctum treats anything inside
  document delimiters as DATA, never instructions, and flags embedded prompt-injection attempts.
  (See `docs/sample-records/03-…` for a planted injection the system refuses.)
- **Forensic-grade evidence.** Every inference call is logged (prompt hash, tokens, TTFT, tokens/sec,
  device) to `artifacts/perf-log.jsonl`, consistent with the demo video and profiler screenshots.

## Quick start
```bash
npm install                 # ~3.7 GB (QVAC bundles all native runtimes)
npm run doctor              # optional: validate host + GPU (needs @qvac/cli)
npm run models              # downloads MedPsy-1.7B GGUF (~1.28 GB)  [DL_4B=1 to also get 4B]
npm run smoke               # Day-0 verification: load model + one logged completion
npm run ask -- "What medications were discontinued, and why? Cite documents."
```

### GPU vs CPU
QVAC's Linux GPU backend is **Vulkan** (not CUDA). Start CPU-first; once `npm run doctor` confirms
Vulkan on the GTX 1650 Ti, offload layers:
```bash
QVAC_DEVICE=gpu QVAC_GPU_LAYERS=999 QVAC_CTX=16384 npm run ask -- "…"
```

## Reproducibility (for judges)
- **SDK:** pinned `@qvac/sdk@0.12.2` (see `package.json`).
- **Models:** Apache-2.0 GGUFs from `huggingface.co/qvac`; checksums in `models/SHA256SUMS.txt`.
- **Test hardware:** Linux (Debian/Kali), Node 24.13.1, g++ 15.2, 16 GB RAM,
  NVIDIA GTX 1650 Ti (4 GB VRAM, Vulkan). System-profiler screenshots in `artifacts/` *(to add)*.
- **Standard demo run:** `npm run ask -- "<the demo question>"` with fixed
  generation params (`src/models.ts` → `GEN_PARAMS`). The perf log + video show identical numbers.
- **Artifacts:** `artifacts/perf-log.jsonl` (per-call metrics + model load/unload),
  `artifacts/profiler.json` / `.txt` (native QVAC profiler export).

## How it works
1. `corpus.ts` loads a folder of records and wraps each in delimited, id-tagged `<document>` blocks.
2. `agent.ts` builds one long-context prompt (system rules + all documents + the question) and runs it
   through MedPsy via the QVAC SDK.
3. `perflog.ts` streams the completion, joins the SDK's `completion().stats` (TTFT, tokens/sec,
   token counts) with model load/unload events, and writes a compliant machine-readable log.

## Prior work disclosure
Built from scratch during the hackathon period (June 2026). No pre-existing codebase. Dependencies:
the open-source QVAC SDK and the open-source MedPsy model weights.

## ⚠️ Not medical advice
Sanctum is a **research/education** demonstration of on-device document analysis. The synthetic records
in `docs/sample-records/` are fabricated. This is **not a medical device** and must not be used for
clinical decisions or with real patient data.

## License
[Apache-2.0](./LICENSE).
