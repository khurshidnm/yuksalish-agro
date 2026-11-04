// Puts the sha256 of each inline <script> in the built index.html into the CSP header, so the
// policy stays strict without having to be edited whenever that script changes.
// Usage: node infra/csp-hashes.mjs <index.html> <headers.inc>
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [html, headers] = process.argv.slice(2);
const inline = [...readFileSync(html, 'utf8').matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
const hashes = inline.map(([, body]) => `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
const filled = readFileSync(headers, 'utf8').replaceAll('__INLINE_SCRIPT_HASHES__', hashes.join(' '));
if (hashes.length === 0 || filled.includes('__INLINE_SCRIPT_HASHES__')) {
  throw new Error('CSP script hashes were not filled in: the app would be blocked or the policy invalid');
}
writeFileSync(headers, filled);
console.log(`CSP: ${hashes.length} inline script(s) hashed`);
