/**
 * Sanctum — phone UI (Expo / React Native).
 *
 * The phone is a thin client: doctors pick patient documents and ask questions here, but ALL AI
 * inference runs on the Sanctum server on the laptop (src/server.ts) over the local Wi-Fi. Nothing
 * is sent to any cloud. Point EXPO_PUBLIC_SERVER_URL (mobile/.env) at the laptop's LAN IP:port.
 *
 * Files (PDF / Word / .txt / .md) are read as raw bytes here and the TEXT is extracted on the laptop
 * (POST /extract) — phones can't reliably parse PDFs/DOCX. You get an instant per-file confirmation
 * (char count) before asking, so you can see the upload worked.
 */
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { File as FsFile, UploadType } from 'expo-file-system';
import { readAsStringAsync } from 'expo-file-system/legacy';

const SERVER = process.env.EXPO_PUBLIC_SERVER_URL || 'http://192.168.1.14:8787';

/** Server's per-file extraction result (from POST /upload). */
type UploadResult = { title?: string; content?: string; chars?: number; ok?: boolean; error?: string };

type Asset = { uri: string; name?: string; mimeType?: string };

/**
 * PRIMARY upload path — expo-file-system's NATIVE multipart uploader (`File.upload`).
 *
 * Why not the obvious `fetch` + `FormData` with a `{ uri, name, type }` file part? Under Expo SDK 56
 * the global `fetch` is Expo's WinterCG implementation, whose multipart encoder REJECTS React Native's
 * file-URI parts with "Unsupported FormDataPart implementation" (it only accepts strings / Blobs /
 * objects with a bytes() method — never a file URI). That is exactly the recurring upload error.
 *
 * `File.upload` sidesteps it entirely: it streams the file straight from disk to the server's busboy
 * `/upload`, never routing through the WinterCG FormData encoder and never pulling the bytes into the
 * JS heap. expo-file-system is a first-party Expo SDK module (in `expo/bundledNativeModules.json`), so
 * this runs in Expo Go as well as dev/standalone builds.
 */
async function uploadViaNative(asset: Asset): Promise<UploadResult> {
  const result = await new FsFile(asset.uri).upload(`${SERVER}/upload`, {
    httpMethod: 'POST',
    uploadType: UploadType.MULTIPART,
    fieldName: 'file', // matches the server's busboy file part
    mimeType: asset.mimeType || 'application/octet-stream', // server routes extraction by this (+ magic bytes)
    headers: { Accept: 'application/json' },
  });
  let data: UploadResult;
  try {
    data = JSON.parse(result.body) as UploadResult;
  } catch {
    throw new Error(`Server ${result.status}: unreadable response`);
  }
  // `File.upload` resolves for any HTTP status (incl. 4xx/5xx), so check it ourselves.
  if (result.status < 200 || result.status >= 300) throw new Error(data?.error ?? `Server ${result.status}`);
  return data;
}

/**
 * FALLBACK upload path — read the file as base64 and POST it as plain JSON to `/extract`.
 *
 * This has a different failure mode than the native uploader (it reads bytes in JS instead of streaming
 * natively), so it's a useful safety net if `File.upload` is ever unavailable. A JSON *string* body is
 * fine under WinterCG fetch — only the FormData/multipart path is broken. The server's `/extract`
 * accepts `{ documents: [{ name, mimeType, base64 }] }` and returns the same per-file shape as `/upload`.
 */
async function uploadViaExtract(asset: Asset): Promise<UploadResult> {
  const base64 = await readAsStringAsync(asset.uri, { encoding: 'base64' });
  const r = await fetch(`${SERVER}/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ documents: [{ name: asset.name, mimeType: asset.mimeType, base64 }] }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error ?? `Server ${r.status}`);
  const doc = data?.documents?.[0] as UploadResult | undefined;
  if (!doc) throw new Error('no extraction result');
  return doc;
}

/**
 * Upload ONE picked file to the laptop for text extraction. Tries the native streaming uploader first
 * and falls back to base64 + JSON `/extract`. Either way the server routes extraction by mime type
 * (passed here) with a magic-byte + extension fallback, so PDF / DOCX / DOC / TXT / MD all work.
 *
 * Note: a genuinely unsupported/unreadable file comes back from the server as `{ ok: false, error }`
 * (HTTP 200), which we return as-is — we only fall back on a thrown error (native uploader missing,
 * malformed multipart, transport failure), never on a legitimate extraction failure.
 */
async function uploadDoc(asset: Asset): Promise<UploadResult> {
  try {
    return await uploadViaNative(asset);
  } catch (primaryErr: any) {
    try {
      return await uploadViaExtract(asset);
    } catch (fallbackErr: any) {
      throw new Error(primaryErr?.message ?? fallbackErr?.message ?? 'upload failed');
    }
  }
}

type PickedDoc = { name: string; chars: number; ok: boolean; error?: string; content: string };
type Health = { model: string; device: string } | null;
type Stats = { tokensPerSecond?: number; timeToFirstToken?: number; backendDevice?: string } | null;

const fmtChars = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k chars` : `${n} chars`);

/** Render the answer, highlighting [DOC-xx] citation tags. */
function AnswerText({ text }: { text: string }) {
  const parts = text.split(/(\[DOC-[^\]]+\])/g);
  return (
    <Text style={styles.answer}>
      {parts.map((p, i) =>
        /^\[DOC-/.test(p) ? (
          <Text key={i} style={styles.cite}>
            {p}
          </Text>
        ) : (
          <Text key={i}>{p}</Text>
        ),
      )}
    </Text>
  );
}

export default function App() {
  const [health, setHealth] = useState<Health>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [docs, setDocs] = useState<PickedDoc[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [citations, setCitations] = useState<string[]>([]);
  const [injection, setInjection] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [stats, setStats] = useState<Stats>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Probe the laptop server on mount so the doctor sees the connection + model up front.
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${SERVER}/health`);
        const h = await r.json();
        setHealth({ model: h.model, device: h.device });
        setOnline(true);
      } catch {
        setOnline(false);
      }
    })();
  }, []);

  async function pickDocs() {
    setError('');
    try {
      const res = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true, // gives a stable file:// uri the native uploader can stream
        type: '*/*', // most permissive — never greys out .txt/.md on Android (server validates type)
      });
      if (res.canceled) return;

      setExtracting(true);
      // Upload each file as multipart so RN's native networking reads it (Expo-Go-safe); the laptop
      // extracts the text (pdf/docx/doc/txt/md) and returns it.
      const parsed: PickedDoc[] = await Promise.all(
        res.assets.map(async (a): Promise<PickedDoc> => {
          try {
            const d = await uploadDoc(a);
            return {
              name: d.title || a.name || 'Document',
              chars: d.chars ?? 0,
              ok: !!d.ok,
              error: d.error,
              content: d.content ?? '',
            };
          } catch (e: any) {
            return { name: a.name || 'Document', chars: 0, ok: false, error: e?.message ?? 'upload failed', content: '' };
          }
        }),
      );
      setDocs((prev) => [...prev, ...parsed]);

      const failed = parsed.filter((d) => !d.ok);
      if (failed.length) setError(`Couldn't read: ${failed.map((d) => `${d.name} (${d.error ?? 'failed'})`).join('; ')}`);
    } catch (e: any) {
      setError(`${e?.message ?? 'document pick failed'}\nIs the laptop server running and on the same Wi-Fi? (${SERVER})`);
    } finally {
      setExtracting(false);
    }
  }

  async function analyze() {
    const okDocs = docs.filter((d) => d.ok && d.content.trim());
    if (!question.trim() || okDocs.length === 0) return;
    setLoading(true);
    setAnswer('');
    setCitations([]);
    setInjection(false);
    setTruncated(false);
    setStats(null);
    setError('');
    try {
      const res = await fetch(`${SERVER}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: question.trim(),
          documents: okDocs.map((d) => ({ title: d.name, content: d.content })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Server ${res.status}`);
      setAnswer(data.answer ?? '');
      setCitations(data.citations ?? []);
      setInjection(!!data.injectionSuspected);
      setTruncated(!!data.truncated);
      setStats(data.stats ?? null);
    } catch (e: any) {
      setError(`${e?.message ?? 'request failed'}\nCheck the laptop server and that you're on the same Wi-Fi (${SERVER}).`);
    } finally {
      setLoading(false);
    }
  }

  const okCount = docs.filter((d) => d.ok).length;
  const canAsk = !!question.trim() && okCount > 0 && !loading && !extracting;

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {/* Header */}
        <Text style={styles.brand}>Sanctum</Text>
        <Text style={styles.tagline}>Private clinical document analyst · runs on your own machine</Text>

        {/* Connection status */}
        <View style={[styles.statusPill, online === false && styles.statusBad]}>
          <View style={[styles.dot, { backgroundColor: online ? '#34d399' : online === false ? '#f87171' : '#9ca3af' }]} />
          <Text style={styles.statusText}>
            {online === null
              ? 'Connecting to server…'
              : online
                ? `${health?.model ?? 'model'} · ${health?.device ?? '—'}`
                : 'Server offline — start it on the laptop'}
          </Text>
        </View>

        {/* Documents */}
        <Text style={styles.section}>Patient documents</Text>
        <Pressable style={[styles.btn, extracting && styles.disabled]} onPress={pickDocs} disabled={extracting}>
          {extracting ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator color="#fff" />
              <Text style={styles.btnText}>  Reading & extracting…</Text>
            </View>
          ) : (
            <Text style={styles.btnText}>+ Add documents</Text>
          )}
        </Pressable>
        <Text style={styles.hint}>PDF · Word (.docx/.doc) · .txt · .md — extracted on your laptop</Text>

        <View style={styles.chips}>
          {docs.length === 0 ? (
            <Text style={styles.muted}>No documents added yet.</Text>
          ) : (
            docs.map((d, i) => (
              <View key={i} style={[styles.chip, !d.ok && styles.chipBad]}>
                <Text style={[styles.chipText, !d.ok && styles.chipTextBad]} numberOfLines={1}>
                  {d.ok ? '✓ ' : '⚠ '}
                  {d.name}
                  <Text style={styles.chipMeta}>{d.ok ? `  ·  ${fmtChars(d.chars)}` : `  ·  ${d.error ?? 'failed'}`}</Text>
                </Text>
              </View>
            ))
          )}
        </View>
        {docs.length > 0 && (
          <Pressable onPress={() => setDocs([])}>
            <Text style={styles.clear}>Clear documents</Text>
          </Pressable>
        )}

        {/* Question */}
        <Text style={styles.section}>Question</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. What medications were discontinued, and why? Cite documents."
          placeholderTextColor="#5b647a"
          value={question}
          onChangeText={setQuestion}
          multiline
        />

        <Pressable style={[styles.analyze, !canAsk && styles.disabled]} onPress={analyze} disabled={!canAsk}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.analyzeText}>Analyze on-device</Text>}
        </Pressable>

        {!!error && <Text style={styles.error}>{error}</Text>}

        {/* Answer */}
        {(loading || answer) && (
          <View style={styles.card}>
            {injection && (
              <View style={styles.warn}>
                <Text style={styles.warnText}>
                  ⚠ Possible prompt-injection detected in a document. It was treated as data and ignored.
                </Text>
              </View>
            )}
            {truncated && (
              <View style={styles.note}>
                <Text style={styles.noteText}>
                  ℹ Document(s) were long — only the portion that fits the model's context window was analyzed.
                </Text>
              </View>
            )}
            {loading && !answer ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator color="#60a5fa" />
                <Text style={styles.muted}>  Reasoning over your documents, locally…</Text>
              </View>
            ) : (
              <AnswerText text={answer} />
            )}

            {citations.length > 0 && (
              <View style={styles.citeRow}>
                {citations.map((c) => (
                  <View key={c} style={styles.citeChip}>
                    <Text style={styles.citeChipText}>{c}</Text>
                  </View>
                ))}
              </View>
            )}

            {stats && (
              <Text style={styles.perf}>
                {stats.backendDevice ?? '—'} · {stats.tokensPerSecond ? `${stats.tokensPerSecond.toFixed(1)} tok/s` : ''}
                {stats.timeToFirstToken ? ` · TTFT ${Math.round(stats.timeToFirstToken)}ms` : ''}
              </Text>
            )}
          </View>
        )}

        <Text style={styles.footer}>🔒 Inference runs on your laptop. Nothing leaves your local network — no cloud.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0c11' },
  scroll: { padding: 20, paddingBottom: 48 },
  brand: { color: '#fff', fontSize: 32, fontWeight: '800', letterSpacing: 0.5 },
  tagline: { color: '#8a93a6', marginTop: 2, marginBottom: 16 },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#11151c',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginBottom: 20,
  },
  statusBad: { backgroundColor: '#2a1416' },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  statusText: { color: '#cbd5e1', fontSize: 12, fontWeight: '600' },
  section: { color: '#e5e7eb', fontSize: 15, fontWeight: '700', marginTop: 8, marginBottom: 8 },
  btn: { backgroundColor: '#1f2937', padding: 14, borderRadius: 12 },
  btnText: { color: '#fff', textAlign: 'center', fontWeight: '600' },
  hint: { color: '#5b647a', fontSize: 12, marginTop: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 12, gap: 8 },
  chip: { backgroundColor: '#172554', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, maxWidth: '100%' },
  chipBad: { backgroundColor: '#3a1a1a' },
  chipText: { color: '#bfdbfe', fontSize: 12 },
  chipTextBad: { color: '#fca5a5' },
  chipMeta: { color: '#7c93c2', fontSize: 11 },
  clear: { color: '#f87171', fontSize: 12, marginTop: 8 },
  muted: { color: '#5b647a', fontSize: 13 },
  input: {
    backgroundColor: '#11151c',
    color: '#fff',
    borderRadius: 12,
    padding: 14,
    minHeight: 80,
    textAlignVertical: 'top',
    borderWidth: 1,
    borderColor: '#1e2733',
  },
  analyze: { backgroundColor: '#2563eb', padding: 16, borderRadius: 12, marginTop: 16 },
  analyzeText: { color: '#fff', textAlign: 'center', fontWeight: '700', fontSize: 16 },
  disabled: { opacity: 0.4 },
  error: { color: '#fca5a5', marginTop: 12, fontSize: 13 },
  card: { backgroundColor: '#11151c', borderRadius: 14, padding: 16, marginTop: 20, borderWidth: 1, borderColor: '#1e2733' },
  warn: { backgroundColor: '#3a2a08', borderRadius: 8, padding: 10, marginBottom: 12 },
  warnText: { color: '#fcd34d', fontSize: 12 },
  note: { backgroundColor: '#0e2433', borderRadius: 8, padding: 10, marginBottom: 12 },
  noteText: { color: '#93c5fd', fontSize: 12 },
  loadingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  answer: { color: '#e5e7eb', lineHeight: 23, fontSize: 15 },
  cite: { color: '#60a5fa', fontWeight: '700' },
  citeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 14 },
  citeChip: { backgroundColor: '#0b3b2e', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  citeChipText: { color: '#6ee7b7', fontSize: 11, fontWeight: '700' },
  perf: { color: '#5b647a', fontSize: 11, marginTop: 12, fontFamily: 'monospace' },
  footer: { color: '#475065', fontSize: 11, textAlign: 'center', marginTop: 28 },
});
