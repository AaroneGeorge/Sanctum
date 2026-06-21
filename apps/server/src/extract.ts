/**
 * extract.ts — turn an uploaded file into plain text (runs on the LAPTOP).
 *
 * The phone is a thin client: it can't reliably parse PDFs or Word docs. So it sends the RAW file
 * bytes (base64) over the local network and this module extracts the text here, where mature pure-JS
 * libraries are available. Everything stays on the laptop — no cloud, no native binaries:
 *   - .pdf            → unpdf (bundled serverless PDF.js)
 *   - .docx           → mammoth.extractRawText
 *   - .doc (legacy)   → word-extractor
 *   - .txt/.md/etc.   → utf-8 decode
 * Format is decided by file extension with a magic-byte fallback, so a mislabeled/unknown file still
 * routes correctly (and a scanned/image-only PDF is reported instead of returning silent garbage).
 */
import { extractText as pdfExtractText, getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';

/** A document as it arrives from the phone (or the legacy plain-text path). */
export interface RawDoc {
  name?: string;
  title?: string;
  mimeType?: string;
  base64?: string;
  /** Pre-extracted text — if present we trust it and skip parsing (back-compat with /ask). */
  content?: string;
}

/** Soft cap so a giant PDF can't blow up memory / the model context. ~50k tokens. */
const MAX_CHARS = 200_000;

const wordExtractor = new WordExtractor();
const NUL = new RegExp(String.fromCharCode(0), "g");

function extOf(name = ''): string {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  return m?.[1]?.toLowerCase() ?? '';
}

async function pdfToText(buf: Buffer): Promise<string> {
  // unpdf wants a Uint8Array; PDF.js may detach the buffer, so hand it its own view.
  const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const pdf = await getDocumentProxy(data);
  const { text } = await pdfExtractText(pdf, { mergePages: true });
  return text;
}

async function docxToText(buf: Buffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer: buf });
  return value;
}

async function docToText(buf: Buffer): Promise<string> {
  const doc = await wordExtractor.extract(buf);
  return doc.getBody();
}

/** Cheap heuristic: does this look like decodable UTF-8 text (vs. a binary blob)? */
function looksLikeText(buf: Buffer): boolean {
  const n = Math.min(buf.length, 1024);
  if (n === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const c = buf[i]!;
    if (c === 0) return false; // a NUL byte → binary
    if (c < 9 || (c > 13 && c < 32)) suspicious++;
  }
  return suspicious / n < 0.1;
}

function clip(s: string): string {
  return s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}\n…[truncated for length]` : s;
}

const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'mdown', 'text', 'csv', 'tsv', 'json', 'log', 'xml', 'yaml', 'yml']);

/**
 * Extract plain text from raw file bytes (the multipart /upload path). Routes by file extension with
 * a magic-byte fallback. Throws a human-readable Error on unsupported/unreadable files.
 */
export async function extractBuffer(buf: Buffer, name = '', mimeType = ''): Promise<string> {
  if (!buf.length) throw new Error('empty file');

  const ext = extOf(name);
  const mime = mimeType.toLowerCase();

  // Magic bytes — trusted over a possibly-wrong/absent extension or mime.
  const isPdf = buf.subarray(0, 5).toString('latin1') === '%PDF-';
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b; // 'PK' → .docx (OOXML zip)
  const isOle = buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0; // .doc (OLE2)

  let text: string;
  if (ext === 'pdf' || isPdf || mime.includes('pdf')) {
    text = await pdfToText(buf);
  } else if (ext === 'docx' || mime.includes('wordprocessingml') || (isZip && ext !== 'doc')) {
    text = await docxToText(buf);
  } else if (ext === 'doc' || isOle || mime === 'application/msword') {
    text = await docToText(buf);
  } else if (TEXT_EXTS.has(ext) || mime.startsWith('text/') || looksLikeText(buf)) {
    text = buf.toString('utf8');
  } else {
    throw new Error(`unsupported file type${ext ? ` (.${ext})` : ''} — use .txt, .md, .pdf, .docx, or .doc`);
  }

  text = text.replace(NUL, '').trim();
  if (!text) throw new Error('no extractable text (a scanned/image-only PDF has no text layer)');
  return clip(text);
}

/**
 * Extract plain text from a document delivered as base64 (JSON /extract path) or already-extracted
 * text (/ask path). Delegates byte parsing to extractBuffer.
 */
export async function extractDoc(d: RawDoc): Promise<string> {
  // Back-compat: the /ask path already sends extracted text.
  if (typeof d.content === 'string' && d.content.trim()) return clip(d.content.trim());
  if (!d.base64) throw new Error('no file content');
  return extractBuffer(Buffer.from(d.base64, 'base64'), d.name ?? d.title ?? '', d.mimeType ?? '');
}
