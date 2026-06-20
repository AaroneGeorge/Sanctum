// word-extractor ships no TypeScript types and there is no @types/word-extractor package.
// Minimal ambient declaration for the API we use (extract → Document.getBody()).
declare module 'word-extractor' {
  class Document {
    getBody(): string;
    getHeaders(options?: { includeFooters?: boolean }): string;
    getFooters(): string;
    getFootnotes(): string;
    getEndnotes(): string;
    getAnnotations(): string;
    getTextboxes(options?: { includeHeadersAndFooters?: boolean; includeBody?: boolean }): string;
  }
  export default class WordExtractor {
    extract(source: string | Buffer): Promise<Document>;
  }
}
