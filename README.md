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

## Repository layout

Sanctum is a monorepo with two **self-contained** apps:

```
sanctum/
├── apps/
│   ├── server/        @sanctum/server — on-device inference server (@qvac/sdk, Node 22 + tsx)
│   │   ├── src/                 agent, server, corpus, search, web-agent, perf-log …
│   │   ├── scripts/             download-models.sh
│   │   ├── models/              GGUF weights (gitignored) + SHA256SUMS.txt
│   │   ├── artifacts/           forensic perf-log + profiler exports
│   │   ├── docs/sample-records/ the demo corpus the agent reads
│   │   ├── searxng/             settings for the optional self-hosted web-search service
│   │   └── Dockerfile
│   └── mobile/        @sanctum/mobile — Expo / React Native phone app (talks to the server over LAN)
├── docs/              project docs (DEMO-TEST-CASES.md)
├── docker-compose.yml server (+ optional SearXNG) orchestration
├── tsconfig.base.json shared TS config
└── package.json       root orchestrator — delegating scripts, no shared deps
```

A single `npm install` at the root installs **both** apps: the root has no dependencies of its own —
its `postinstall` runs `npm install` inside `apps/server` and `apps/mobile`, so each app gets its own
self-contained `node_modules` + lockfile. Root scripts (`npm run serve`, `npm run mobile`, …) just
`cd` into the right app, so every command below runs from the repo root.

> **Why no npm workspaces?** Expo / React Native break under dependency hoisting — Metro loads two
> copies of React ("Invalid hook call"), or `babel-preset-expo` can't resolve its `@react-native/*`
> plugins. Keeping each app as a separate install sidesteps that entirely; it's what Expo expects.

## Why this is different
- **100% on-device.** No prompt, document, embedding, or model output ever touches a network at
  runtime. See [`remote-api-calls.json`](./remote-api-calls.json) — the runtime remote **AI**-call list is
  empty and all inference is local. Verify it yourself: disconnect the network and run the demo.
  *(The optional [web-augmented mode](#web-augmented-mode-optional) is opt-in and off by default; even
  when on, only de-identified search queries — never the patient document — leave the device.)*
- **Long context on modest hardware.** Built around QVAC's TurboQuant KV-cache compression so a large
  corpus fits in context on a 4 GB GPU. *(in progress)*
- **Small model, real quality.** MedPsy-4B edges MedGemma-27B on Tether's medical benchmarks at ~7× smaller.
- **Injection-resistant by design.** Documents are untrusted input; Sanctum treats anything inside
  document delimiters as DATA, never instructions, and flags embedded prompt-injection attempts.
  (See `apps/server/docs/sample-records/03-…` for a planted injection the system refuses.)
- **Forensic-grade evidence.** Every inference call is logged (prompt hash, tokens, TTFT, tokens/sec,
  device) to `apps/server/artifacts/perf-log.jsonl`, consistent with the demo video and profiler screenshots.

## Quick start
```bash
npm install                 # installs BOTH apps (~3.7 GB — QVAC bundles all native runtimes)
npm run doctor              # optional: validate host + GPU (needs @qvac/cli)
npm run models              # downloads MedPsy-1.7B GGUF (~1.28 GB)  [DL_4B=1 to also get 4B]
npm run smoke               # Day-0 verification: load model + one logged completion
npm run ask -- "What medications were discontinued, and why? Cite documents."
```

Each root script just `cd`s into the right app. To run a command in one app directly, `cd` into it —
e.g. `cd apps/server && npm run ask -- "…"` or `cd apps/server && npm run typecheck`.

To run the phone app (Expo) against your laptop's server:
```bash
# point the app at your laptop first:  apps/mobile/.env → EXPO_PUBLIC_SERVER_URL=http://<laptop-LAN-ip>:8787
npm start                   # Expo in the FOREGROUND (scannable QR + a/i/r keys) + server in the background
                            #   server logs → sanctum-server.log ;  Ctrl+C stops both
# …or run them in two terminals:
npm run serve               # just the server (logs in the foreground); note the "on LAN" URL it prints
npm run mobile              # just `expo start` (scan the QR with Expo Go on a phone on the SAME Wi-Fi)
```
> Expo needs its own terminal (TTY) to render a scannable QR, so `npm start` runs it in the foreground
> and keeps the server in the background (logging to `sanctum-server.log`). Running it under a parallel
> runner like `concurrently` denies Expo a TTY — the QR never shows. Prefer separate windows? Run
> `npm run serve` and `npm run mobile` in two terminals.

### GPU vs CPU
QVAC's Linux GPU backend is **Vulkan** (not CUDA). Start CPU-first; once `npm run doctor` confirms
Vulkan on the GPU, offload layers:
```bash
QVAC_DEVICE=gpu QVAC_GPU_LAYERS=999 QVAC_CTX=16384 npm run ask -- "…"
```

## Run with Docker
The **server** ships as a container (the Expo app stays on a device — it isn't sensibly containerized).
The image is glibc-based (QVAC ships native runtimes, not musl) and defaults to **CPU** for portability.

```bash
npm run models                 # download weights on the HOST first — they are mounted in, not baked
docker compose up --build      # builds apps/server/Dockerfile, serves on http://localhost:8787
curl http://localhost:8787/health
```

- **Weights** are bind-mounted read-only from `apps/server/models/` (large + gitignored), so the image
  stays lean and you never rebuild to swap models.
- **Forensic logs** are written back to the host at `apps/server/artifacts/`.
- **Config** (model, device, context) comes from a root `.env` — `cp .env.example .env` and edit. The
  server's first boot loads the model before `/health` responds (hence a long healthcheck `start_period`).

**Fully-offline web search (optional).** Bring up a self-hosted SearXNG alongside the server so not even
the de-identified queries reach a third party:
```bash
docker compose --profile websearch up --build
# then in apps/server/.env:  SEARCH_PROVIDER=searxng  SEARCH_ENDPOINT=http://searxng:8080
```

**GPU in Docker** is advanced and host-specific (Vulkan passthrough via `--device /dev/dri` + the host's
ICD). The portable image is CPU-only; run natively with `QVAC_DEVICE=gpu` for GPU offload.

## Reproducibility (for judges)
- **SDK:** pinned `@qvac/sdk@0.12.2` (see `apps/server/package.json`).
- **Models:** Apache-2.0 GGUFs from `huggingface.co/qvac`; checksums in `apps/server/models/SHA256SUMS.txt`.
- **Test hardware:** Linux (Debian/Kali), Node 24.13.1, g++ 15.2, 16 GB RAM,
  NVIDIA GTX 1650 Ti (4 GB VRAM, Vulkan).
- **Standard demo run:** `npm run ask -- "<the demo question>"` with fixed
  generation params (`apps/server/src/models.ts` → `GEN_PARAMS`). The perf log + video show identical numbers.
- **Artifacts:** `apps/server/artifacts/perf-log.jsonl` (per-call metrics + model load/unload),
  `apps/server/artifacts/profiler.json` / `.txt` (native QVAC profiler export).

## How it works
1. `apps/server/src/corpus.ts` loads a folder of records and wraps each in delimited, id-tagged
   `<document>` blocks.
2. `apps/server/src/agent.ts` builds one long-context prompt (system rules + all documents + the
   question) and runs it through MedPsy via the QVAC SDK.
3. `apps/server/src/perflog.ts` streams the completion, joins the SDK's `completion().stats` (TTFT,
   tokens/sec, token counts) with model load/unload events, and writes a compliant machine-readable log.

## Web-augmented mode (optional)
Document-only analysis can't know the *latest* guidelines or drug-interaction data. The opt-in
**🌐 deep research** mode in the phone app fuses the private record with current web literature —
without ever uploading the patient's document. It runs an on-device → web → on-device agent:

1. **Analyze (on-device).** MedPsy reads the record locally and writes 1–4 **general, de-identified**
   medical search queries (`apps/server/src/webagent.ts`). The document never leaves the machine.
2. **Search (web).** Only those query *strings* go out — and each is run through a regex PHI scrubber
   (`deidentify()` in `apps/server/src/search.ts`) first. Provider is pluggable: **Tavily** (default),
   **Brave**, or a self-hosted **SearXNG** (no third party). The phone shows each query live, so you see
   exactly what left.
3. **Synthesize (on-device).** MedPsy answers from the record **plus** the web results, citing patient
   facts as `[DOC-xx]` and literature as `[WEB-n]`, with Perplexity-style clickable sources.

The server streams the agent's progress over SSE (`POST /ask/web`) so the app can show a single live
"thinking" line. **Default off** — with no key configured the mode degrades to an on-device-only answer
and makes **zero** external calls, so the offline guarantee above is untouched.

```bash
# Enable it by giving the server a search key (see apps/server/.env.example). Inference stays 100% local.
SEARCH_PROVIDER=tavily SEARCH_API_KEY=tvly-… npm run serve
```

| env var | default | meaning |
|---|---|---|
| `SEARCH_PROVIDER` | `tavily` | `tavily` \| `brave` \| `searxng` |
| `SEARCH_API_KEY` | — | Tavily/Brave key (unset ⇒ mode stays offline) |
| `SEARCH_ENDPOINT` | — | SearXNG base URL (only for `searxng`; e.g. `http://searxng:8080` in Docker) |
| `SEARCH_TIMEOUT_MS` | `6000` | per-request web-search timeout |

## Prior work disclosure
Built from scratch during the hackathon period (June 2026). No pre-existing codebase. Dependencies:
the open-source QVAC SDK and the open-source MedPsy model weights.

## ⚠️ Not medical advice
Sanctum is a **research/education** demonstration of on-device document analysis. The synthetic records
in `apps/server/docs/sample-records/` are fabricated. This is **not a medical device** and must not be
used for clinical decisions or with real patient data.

## License
[Apache-2.0](./LICENSE).
