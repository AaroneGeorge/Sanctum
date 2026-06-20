/**
 * Sanctum — phone UI (Expo / React Native).
 *
 * A continuous, on-device chat: doctors add patient documents once, then ask as many questions as
 * they like in one session — follow-ups keep context. The phone is a thin client; ALL AI inference
 * runs on the Sanctum server on the laptop (src/server.ts) over the local Wi-Fi. Nothing is sent to
 * any cloud. Point EXPO_PUBLIC_SERVER_URL (mobile/.env) at the laptop's LAN IP:port.
 *
 * Files (PDF / Word / .txt / .md) are read as raw bytes here and the TEXT is extracted on the laptop
 * (POST /upload) — phones can't reliably parse PDFs/DOCX. You get an instant per-file confirmation
 * (char count) before asking, so you can see the upload worked.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
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

/** One bubble in the conversation. Assistant bubbles carry the answer's metadata (citations, flags). */
type Msg = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  pending?: boolean;
  error?: boolean;
  citations?: string[];
  injection?: boolean;
  truncated?: boolean;
  stats?: Stats;
};

const fmtChars = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

/** Render an answer, highlighting [DOC-xx] citation tags inline. */
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

/** One chat bubble (user question or assistant answer, including pending / error states). */
function Bubble({ msg }: { msg: Msg }) {
  if (msg.role === 'user') {
    return (
      <View style={styles.userRow}>
        <View style={styles.userBubble}>
          <Text style={styles.userText}>{msg.text}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.botRow}>
      <View style={[styles.botBubble, msg.error && styles.botBubbleError]}>
        {msg.pending ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color="#60a5fa" />
            <Text style={styles.muted}>  Reasoning over your documents, locally…</Text>
          </View>
        ) : msg.error ? (
          <Text style={styles.errorText}>{msg.text}</Text>
        ) : (
          <>
            {msg.injection && (
              <View style={styles.warn}>
                <Text style={styles.warnText}>⚠ Possible prompt-injection in a document — treated as data and ignored.</Text>
              </View>
            )}
            {msg.truncated && (
              <View style={styles.note}>
                <Text style={styles.noteText}>ℹ Long documents — only the portion that fits the context window was analyzed.</Text>
              </View>
            )}
            <AnswerText text={msg.text} />
            {!!msg.citations?.length && (
              <View style={styles.citeRow}>
                {msg.citations.map((c) => (
                  <View key={c} style={styles.citeChip}>
                    <Text style={styles.citeChipText}>{c}</Text>
                  </View>
                ))}
              </View>
            )}
            {msg.stats && (
              <Text style={styles.perf}>
                {msg.stats.backendDevice ?? '—'}
                {msg.stats.tokensPerSecond ? ` · ${msg.stats.tokensPerSecond.toFixed(1)} tok/s` : ''}
                {msg.stats.timeToFirstToken ? ` · TTFT ${Math.round(msg.stats.timeToFirstToken)}ms` : ''}
              </Text>
            )}
          </>
        )}
      </View>
    </View>
  );
}

function Chat() {
  const insets = useSafeAreaInsets();
  const [health, setHealth] = useState<Health>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [docs, setDocs] = useState<PickedDoc[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const scrollRef = useRef<ScrollView>(null);
  const idRef = useRef(0);
  const nextId = () => `m${idRef.current++}`;

  // Probe the laptop server for the connection + model. Runs on mount, and again whenever the doctor
  // taps the status pill — so an "Offline" reading can be retried once the laptop comes up.
  const checkHealth = useCallback(async () => {
    setOnline(null);
    try {
      const r = await fetch(`${SERVER}/health`);
      const h = await r.json();
      setHealth({ model: h.model, device: h.device });
      setOnline(true);
    } catch {
      setOnline(false);
    }
  }, []);

  useEffect(() => {
    checkHealth();
  }, [checkHealth]);

  // (Auto-scroll is handled by the thread's onContentSizeChange — see the conversation ScrollView.)

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
      setError(`${e?.message ?? 'document pick failed'} — is the laptop server running on the same Wi-Fi? (${SERVER})`);
    } finally {
      setExtracting(false);
    }
  }

  function removeDoc(i: number) {
    setDocs((prev) => prev.filter((_, j) => j !== i));
  }

  function newChat() {
    setMessages([]);
    setError('');
  }

  async function send() {
    const q = input.trim();
    const okDocs = docs.filter((d) => d.ok && d.content.trim());
    if (!q || okDocs.length === 0 || sending) return;
    setError('');

    // Prior turns (questions + answers) so the model can resolve follow-ups; the server caps/trims
    // history and re-sends the documents, so we just forward the successful turns so far.
    const history = messages
      .filter((m) => !m.pending && !m.error)
      .map((m) => ({ role: m.role, content: m.text }));

    const userMsg: Msg = { id: nextId(), role: 'user', text: q };
    const pendingId = nextId();
    setMessages((prev) => [...prev, userMsg, { id: pendingId, role: 'assistant', text: '', pending: true }]);
    setInput('');
    setSending(true);

    try {
      const res = await fetch(`${SERVER}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: q,
          documents: okDocs.map((d) => ({ title: d.name, content: d.content })),
          history,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Server ${res.status}`);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === pendingId
            ? {
                ...m,
                pending: false,
                text: data.answer ?? '',
                citations: data.citations ?? [],
                injection: !!data.injectionSuspected,
                truncated: !!data.truncated,
                stats: data.stats ?? null,
              }
            : m,
        ),
      );
    } catch (e: any) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === pendingId
            ? { ...m, pending: false, error: true, text: `${e?.message ?? 'request failed'} — check the laptop server and Wi-Fi (${SERVER}).` }
            : m,
        ),
      );
    } finally {
      setSending(false);
    }
  }

  const okCount = docs.filter((d) => d.ok).length;
  const canSend = !!input.trim() && okCount > 0 && !sending && !extracting;

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
        {/* Header: brand + live connection / model / device (paddingTop clears the status bar) */}
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          <View style={styles.flex}>
            <Text style={styles.brand}>🔒 Sanctum</Text>
            <Text style={styles.tagline}>On-device · nothing leaves your network</Text>
          </View>
          <View style={styles.headerRight}>
            {/* Tap to re-probe the laptop (useful after an "Offline" reading). */}
            <Pressable onPress={checkHealth} hitSlop={8} style={[styles.statusPill, online === false && styles.statusBad]}>
              <View style={[styles.dot, { backgroundColor: online ? '#34d399' : online === false ? '#f87171' : '#9ca3af' }]} />
              <Text style={styles.statusText} numberOfLines={1}>
                {online === null
                  ? 'Connecting…'
                  : online
                    ? `${health?.model ?? 'model'} · ${health?.device ?? '—'}`
                    : 'Offline · tap to retry'}
              </Text>
            </Pressable>
            {messages.length > 0 && (
              <Pressable onPress={newChat} hitSlop={8}>
                <Text style={styles.newChat}>New chat</Text>
              </Pressable>
            )}
          </View>
        </View>

        {/* Documents strip — the loaded corpus, with per-file status; tap × to remove */}
        {docs.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.docsBar}
            contentContainerStyle={styles.docsBarContent}
            keyboardShouldPersistTaps="handled"
          >
            {docs.map((d, i) => (
              <View key={i} style={[styles.docChip, !d.ok && styles.docChipBad]}>
                <Text style={[styles.docChipText, !d.ok && styles.docChipTextBad]} numberOfLines={1}>
                  {d.ok ? '✓ ' : '⚠ '}
                  {d.name}
                  <Text style={styles.docChipMeta}>{d.ok ? `  ${fmtChars(d.chars)}` : `  ${d.error ?? 'failed'}`}</Text>
                </Text>
                <Pressable onPress={() => removeDoc(i)} hitSlop={8}>
                  <Text style={styles.docChipX}>×</Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
        )}

        {/* Conversation */}
        <ScrollView
          ref={scrollRef}
          style={styles.flex}
          contentContainerStyle={styles.thread}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        >
          {messages.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>🔒</Text>
              <Text style={styles.emptyTitle}>Private, on-device analysis</Text>
              <Text style={styles.emptyBody}>
                {docs.length === 0
                  ? 'Tap + to add patient records (PDF · Word · .txt · .md), then ask a question. Ask as many follow-ups as you like — the conversation keeps context.'
                  : 'Ask a question about the documents above. Follow-up questions keep context, and every answer cites its sources.'}
              </Text>
              <Text style={styles.emptyNote}>Your documents and questions never leave your local network — no cloud.</Text>
            </View>
          ) : (
            messages.map((m) => <Bubble key={m.id} msg={m} />)
          )}
        </ScrollView>

        {!!error && <Text style={styles.error}>{error}</Text>}

        {/* Composer: + to add documents · text · send (paddingBottom clears the nav/gesture bar) */}
        <View style={[styles.composer, { paddingBottom: insets.bottom + 12 }]}>
          <Pressable style={[styles.attach, extracting && styles.disabled]} onPress={pickDocs} disabled={extracting}>
            {extracting ? <ActivityIndicator color="#cbd5e1" size="small" /> : <Text style={styles.attachText}>＋</Text>}
          </Pressable>
          <TextInput
            style={styles.input}
            placeholder={okCount > 0 ? 'Ask about these records…' : 'Add a document with + to begin'}
            placeholderTextColor="#5b647a"
            value={input}
            onChangeText={setInput}
            multiline
            editable={!sending}
          />
          <Pressable style={[styles.send, !canSend && styles.sendDisabled]} onPress={send} disabled={!canSend}>
            {sending ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.sendText}>↑</Text>}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Chat />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0c11' },
  flex: { flex: 1 },

  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 16,
    paddingBottom: 12, // paddingTop is applied inline from the safe-area top inset
    borderBottomWidth: 1,
    borderBottomColor: '#161b24',
  },
  brand: { color: '#fff', fontSize: 22, fontWeight: '800', letterSpacing: 0.3 },
  tagline: { color: '#5b647a', fontSize: 12, marginTop: 1 },
  headerRight: { alignItems: 'flex-end', gap: 6, maxWidth: '52%' },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#11151c',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  statusBad: { backgroundColor: '#2a1416' },
  dot: { width: 7, height: 7, borderRadius: 4, marginRight: 6 },
  statusText: { color: '#cbd5e1', fontSize: 11, fontWeight: '600' },
  newChat: { color: '#60a5fa', fontSize: 12, fontWeight: '600' },

  docsBar: { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: '#161b24' },
  docsBarContent: { paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  docChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#172554',
    borderRadius: 8,
    paddingLeft: 10,
    paddingRight: 6,
    paddingVertical: 6,
    maxWidth: 240,
  },
  docChipBad: { backgroundColor: '#3a1a1a' },
  docChipText: { color: '#bfdbfe', fontSize: 12, flexShrink: 1 },
  docChipTextBad: { color: '#fca5a5' },
  docChipMeta: { color: '#7c93c2', fontSize: 11 },
  docChipX: { color: '#7c93c2', fontSize: 18, paddingHorizontal: 4, lineHeight: 18 },

  thread: { padding: 16, paddingBottom: 8, flexGrow: 1 },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, paddingTop: 60 },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyTitle: { color: '#e5e7eb', fontSize: 17, fontWeight: '700', marginBottom: 8 },
  emptyBody: { color: '#8a93a6', fontSize: 14, textAlign: 'center', lineHeight: 21 },
  emptyNote: { color: '#475065', fontSize: 12, textAlign: 'center', marginTop: 16 },

  userRow: { alignItems: 'flex-end', marginBottom: 12 },
  userBubble: { backgroundColor: '#2563eb', borderRadius: 16, borderBottomRightRadius: 4, paddingHorizontal: 14, paddingVertical: 10, maxWidth: '88%' },
  userText: { color: '#fff', fontSize: 15, lineHeight: 21 },

  botRow: { alignItems: 'flex-start', marginBottom: 12 },
  botBubble: {
    backgroundColor: '#11151c',
    borderRadius: 16,
    borderBottomLeftRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 12,
    maxWidth: '92%',
    borderWidth: 1,
    borderColor: '#1e2733',
  },
  botBubbleError: { backgroundColor: '#1f1416', borderColor: '#3a1a1a' },
  answer: { color: '#e5e7eb', lineHeight: 23, fontSize: 15 },
  cite: { color: '#60a5fa', fontWeight: '700' },
  errorText: { color: '#fca5a5', fontSize: 14, lineHeight: 20 },

  loadingRow: { flexDirection: 'row', alignItems: 'center' },
  muted: { color: '#5b647a', fontSize: 13 },

  warn: { backgroundColor: '#3a2a08', borderRadius: 8, padding: 10, marginBottom: 10 },
  warnText: { color: '#fcd34d', fontSize: 12, lineHeight: 17 },
  note: { backgroundColor: '#0e2433', borderRadius: 8, padding: 10, marginBottom: 10 },
  noteText: { color: '#93c5fd', fontSize: 12, lineHeight: 17 },

  citeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12 },
  citeChip: { backgroundColor: '#0b3b2e', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  citeChipText: { color: '#6ee7b7', fontSize: 11, fontWeight: '700' },
  perf: { color: '#475065', fontSize: 10, marginTop: 10, fontFamily: 'monospace' },

  error: { color: '#fca5a5', fontSize: 12, paddingHorizontal: 16, paddingBottom: 6 },

  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingTop: 8, // paddingBottom is applied inline from the safe-area bottom inset
    borderTopWidth: 1,
    borderTopColor: '#161b24',
    gap: 8,
  },
  attach: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#1f2937', alignItems: 'center', justifyContent: 'center' },
  attachText: { color: '#cbd5e1', fontSize: 24, lineHeight: 26 },
  input: {
    flex: 1,
    backgroundColor: '#11151c',
    color: '#fff',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    maxHeight: 120,
    fontSize: 15,
    borderWidth: 1,
    borderColor: '#1e2733',
  },
  send: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#2563eb', alignItems: 'center', justifyContent: 'center' },
  sendDisabled: { backgroundColor: '#1e2733' },
  sendText: { color: '#fff', fontSize: 20, fontWeight: '800', lineHeight: 22 },
  disabled: { opacity: 0.5 },
});
