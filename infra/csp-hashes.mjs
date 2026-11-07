// Puts the sha256 of each inline <script> in the built pages into the CSP header, so the policy
// stays strict without having to be edited whenever one of those scripts changes.
// Usage: node infra/csp-hashes.mjs <headers.inc> <page.html> [more pages...]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [headers, ...pages] = process.argv.slice(2);
const scripts = pages.flatMap((page) => [...readFileSync(page, 'utf8').matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)]);
// Structured data is not code: browsers never run it, and it differs on every page.
const code = scripts.filter(([, attributes]) => !attributes.includes('application/ld+json')).map(([, , body]) => body);
const hashes = [...new Set(code.map((body) => `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`))];
const filled = readFileSync(headers, 'utf8').replaceAll('__INLINE_SCRIPT_HASHES__', hashes.join(' '));
if (hashes.length === 0 || filled.includes('__INLINE_SCRIPT_HASHES__')) {
  throw new Error('CSP script hashes were not filled in: the app would be blocked or the policy invalid');
}
writeFileSync(headers, filled);
console.log(`CSP: ${hashes.length} inline script(s) hashed from ${pages.length} page(s)`);
