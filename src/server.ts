/**
 * server.ts — Sanctum local inference server (runs on the LAPTOP).
 *
 * Keeps a QVAC model loaded in memory and answers questions over documents that the phone app
 * uploads over the LOCAL network. ALL inference happens on this machine via @qvac/sdk — nothing
 * is sent to any cloud. The phone <-> laptop hop stays on your local WiFi (disclose it in
 * remote-api-calls.json as a local, non-cloud transport).
 *
 *   npm run serve
 *   QVAC_DEVICE=gpu QVAC_GPU_LAYERS=999 SANCTUM_MODEL=medpsy-4b npm run serve
 *
 * Endpoints (CORS-open for the Expo app):
 *   GET  /health  -> { ok, model, device, ctx }
 *   POST /extract -> { documents:[{name?,title?,mimeType?,base64}] }   (.pdf/.docx/.doc/.txt/.md → text)
 *               <- { documents:[{title, content, chars, ok, error?}] }
 *   POST /upload  -> multipart/form-data with one "file" part (phone uploads; Expo-Go-safe)
 *               <- { title, content, chars, ok, error? }
 *   POST /ask     -> { question, documents:[{id?,title?,content}] }
 *               <- { answer, citations:["DOC-01",...], requestId, stats, injectionSuspected }
 *
 * Design notes:
 *  - The model is loaded ONCE at startup (verified: ~54 tok/s warm on the iGPU vs reloading per call).
 *  - A single loaded model can only run one completion at a time, so requests are SERIALIZED through
 *    a tiny promise-chain queue — concurrent phone requests wait instead of colliding.
 *  - Every request still writes a forensic row to artifacts/perf-log.jsonl via perflog.ts.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { loadModelLogged, profiledCompletion, unloadModelLogged } from './perflog';
import { resolveModel, MODEL_CONFIG, GEN_PARAMS } from './models';
import busboy from 'busboy';
import { buildLongContextPrompt, type Doc } from './corpus';
import { extractDoc, extractBuffer, type RawDoc } from './extract';

const PORT = Number(process.env.PORT ?? 8787);
const LOG = 'artifacts/perf-log.jsonl';
const model = resolveModel();

/** Serialize completions: one loaded model = one inference at a time. */
let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(() => undefined, () => undefined);
  return run as Promise<T>;
}

function lanIp(): string {
  for (const ifs of Object.values(networkInterfaces())) {
    for (const i of ifs ?? []) {
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('172.')) return i.address;
    }
  }
  return 'localhost';
}

function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res: ServerResponse, code: number, body: unknown): void {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((ok, fail) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 32_000_000) fail(new Error('payload too large')); // ~32 MB cap (base64 file uploads)
    });
    req.on('end', () => {
      try {
        ok(raw ? JSON.parse(raw) : {});
      } catch {
        fail(new Error('invalid JSON body'));
      }
    });
    req.on('error', fail);
  });
}

type UploadedFile = { filename: string; mimeType: string; buffer: Buffer };

/**
 * Parse a single-file multipart/form-data upload into bytes. The phone uploads files this way
 * (FormData + fetch) because reading file bytes in JS is blocked in Expo Go — React Native's native
 * networking streams the file straight to us, so we just reassemble it here.
 */
function parseUpload(req: IncomingMessage): Promise<UploadedFile | null> {
  return new Promise((ok, fail) => {
    let bb: ReturnType<typeof busboy>;
    try {
      bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: 32 * 1024 * 1024 } });
    } catch (e) {
      return fail(e instanceof Error ? e : new Error('bad multipart request'));
    }
    let result: UploadedFile | null = null;
    let tooLarge = false;
    bb.on('file', (_field, stream, info) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('limit', () => {
        tooLarge = true;
        stream.resume();
      });
      stream.on('end', () => {
        result = { filename: info.filename ?? 'upload.bin', mimeType: info.mimeType ?? '', buffer: Buffer.concat(chunks) };
      });
    });
    bb.on('error', (e: unknown) => fail(e instanceof Error ? e : new Error('multipart parse error')));
    bb.on('close', () => (tooLarge ? fail(new Error('file too large (max 32 MB)')) : ok(result)));
    req.pipe(bb);
  });
}

/**
 * Trim document content so the whole prompt fits the model's context window (which must hold the
 * prompt AND the generated answer). Without this, a multi-page PDF makes the SDK hard-error with
 * "prompt exceeds the model's context window". We trim each doc proportionally and flag it so the
 * phone can show that the answer is based on a truncated view. (Proper fix for huge corpora: RAG.)
 */
function fitDocs(docs: Doc[], budgetChars: number): { docs: Doc[]; truncated: boolean } {
  const total = docs.reduce((n, d) => n + d.content.length, 0);
  if (total <= budgetChars) return { docs, truncated: false };
  const fitted = docs.map((d) => {
    const share = Math.max(300, Math.floor((d.content.length / total) * budgetChars));
    const content =
      d.content.length > share ? `${d.content.slice(0, share)}\n…[truncated to fit the model context]` : d.content;
    return { ...d, content };
  });
  return { docs: fitted, truncated: true };
}

/** Map uploaded {title,content} objects to id-tagged Docs (DOC-01, DOC-02, …). */
function toDocs(documents: unknown): Doc[] {
  if (!Array.isArray(documents)) return [];
  return documents
    .filter((d) => d && typeof d.content === 'string' && d.content.trim())
    .map((d, i) => ({
      id: typeof d.id === 'string' && d.id ? d.id : `DOC-${String(i + 1).padStart(2, '0')}`,
      title: typeof d.title === 'string' && d.title ? d.title.slice(0, 80) : `Document ${i + 1}`,
      content: String(d.content).trim(),
    }));
}

async function main() {
  console.log(`Loading ${model.name} (device=${MODEL_CONFIG.device}, ctx=${MODEL_CONFIG.ctx_size}) …`);
  const modelId = await loadModelLogged(
    { modelSrc: resolve(model.path), modelType: 'llm', modelConfig: MODEL_CONFIG },
    LOG,
  );
  console.log(`Model loaded (modelId=${modelId}).`);

  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      cors(res);
      res.writeHead(204);
      return res.end();
    }

    if (req.method === 'GET' && req.url === '/health') {
      return json(res, 200, {
        ok: true,
        model: model.name,
        device: MODEL_CONFIG.device,
        ctx: MODEL_CONFIG.ctx_size,
      });
    }

    // Turn uploaded files (base64) into plain text. CPU/IO only — no model — so it runs
    // concurrently and never blocks the inference queue. One bad file fails only its own entry.
    if (req.method === 'POST' && req.url === '/extract') {
      let body: any;
      try {
        body = await readJson(req);
      } catch (e: any) {
        return json(res, 400, { error: e?.message ?? 'bad request' });
      }
      const items: RawDoc[] = Array.isArray(body.documents) ? body.documents : [];
      if (!items.length) return json(res, 400, { error: 'no documents to extract' });
      const documents = await Promise.all(
        items.map(async (d) => {
          const title =
            (typeof d.title === 'string' && d.title) || (typeof d.name === 'string' && d.name) || 'Document';
          try {
            const content = await extractDoc(d);
            return { title: title.slice(0, 80), content, chars: content.length, ok: true as const };
          } catch (e: any) {
            return { title: title.slice(0, 80), content: '', chars: 0, ok: false as const, error: e?.message ?? 'could not read file' };
          }
        }),
      );
      return json(res, 200, { documents });
    }

    // Multipart upload of ONE file (the phone's Expo-Go-safe path). Native networking streamed the
    // raw bytes here; we extract its text and return the same shape as one /extract document.
    if (req.method === 'POST' && req.url === '/upload') {
      let file: UploadedFile | null;
      try {
        file = await parseUpload(req);
      } catch (e: any) {
        return json(res, 400, { error: e?.message ?? 'upload failed' });
      }
      if (!file) return json(res, 400, { error: 'no file in upload' });
      const title = (file.filename || 'Document').slice(0, 80);
      try {
        const content = await extractBuffer(file.buffer, file.filename, file.mimeType);
        return json(res, 200, { title, content, chars: content.length, ok: true });
      } catch (e: any) {
        return json(res, 200, { title, content: '', chars: 0, ok: false, error: e?.message ?? 'could not read file' });
      }
    }

    if (req.method === 'POST' && req.url === '/ask') {
      let body: any;
      try {
        body = await readJson(req);
      } catch (e: any) {
        return json(res, 400, { error: e?.message ?? 'bad request' });
      }
      const question = typeof body.question === 'string' ? body.question.trim() : '';
      const docs = toDocs(body.documents);
      if (!question) return json(res, 400, { error: 'question is required' });
      if (!docs.length) return json(res, 400, { error: 'at least one document with content is required' });

      // Reserve room for the generated answer (predict) + system/question overhead; assume a
      // conservative ~3 chars/token so dense clinical text never overflows the context window.
      const budgetChars = Math.max(2000, Math.floor((MODEL_CONFIG.ctx_size - (GEN_PARAMS.predict ?? 1024) - 512) * 3));
      const fitted = fitDocs(docs, budgetChars);
      const messages = buildLongContextPrompt(fitted.docs, question);
      try {
        const result = await enqueue(() =>
          profiledCompletion(
            { modelId, history: messages, generationParams: GEN_PARAMS, captureThinking: true },
            { logPath: LOG, modelName: model.name },
          ),
        );
        const answer = result.text.trim();
        const citations = [...new Set(answer.match(/DOC-\d+/g) ?? [])];
        // Heuristic flag: a doc literally trying to instruct the model is a possible injection.
        const injectionSuspected = docs.some((d) =>
          /ignore (all )?(previous |prior )?instructions|system prompt|you are now/i.test(d.content),
        );
        return json(res, 200, {
          answer,
          citations,
          injectionSuspected,
          truncated: fitted.truncated,
          requestId: result.requestId ?? null,
          stats: result.stats ?? null,
        });
      } catch (e: any) {
        console.error('ask error:', e);
        return json(res, 500, { error: e?.message ?? 'inference failed' });
      }
    }

    return json(res, 404, { error: 'not found' });
  });

  server.listen(PORT, '0.0.0.0', () => {
    const ip = lanIp();
    console.log(`\nSanctum server listening:`);
    console.log(`  • local:   http://localhost:${PORT}`);
    console.log(`  • on LAN:  http://${ip}:${PORT}   ← point the phone app here`);
    console.log(`  health:    curl http://${ip}:${PORT}/health\n`);
  });

  const shutdown = async () => {
    console.log('\nShutting down — unloading model …');
    try {
      await unloadModelLogged(modelId, LOG);
    } catch {
      /* best effort */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('\n❌ Sanctum server failed to start:', e);
  process.exit(1);
});
