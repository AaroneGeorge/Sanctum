/**
 * env.ts — tiny, dependency-free .env loader (side-effect import).
 *
 * `npm run serve` (tsx) does NOT auto-load .env, so the web-search keys in .env were being ignored —
 * the server reported "web search not configured" even with SEARCH_API_KEY set. Importing this module
 * FIRST (before ./search, which reads process.env at module-load time) populates process.env from .env
 * so the configured provider is actually used. Existing real env vars always win over the file.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

function loadEnv(file = resolve(process.cwd(), '.env')): void {
  if (!existsSync(file)) return;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue; // real env wins
    let val = line.slice(eq + 1).trim();
    // strip surrounding quotes if present
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

loadEnv();
