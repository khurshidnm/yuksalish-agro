// Writes the public pages as finished HTML, so search engines and slow connections get real content
// instead of an empty app shell. Runs after both Vite builds: see the build script in package.json.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const ssr = join(root, 'dist-ssr');

const { renderPages, robotsTxt, sitemapXml, SITE_URL } = await import(pathToFileURL(join(ssr, 'server.js')).href);

const template = readFileSync(join(dist, 'landing.html'), 'utf8');
if (!template.includes('<!--landing-head-->') || !template.includes('<!--landing-body-->')) {
  throw new Error('landing.html has lost its placeholders');
}

// Latin Uzbek and English are the most common pages: fetch their font before the first paint.
const fonts = readdirSync(join(dist, 'assets')).filter((file) => /^manrope-latin-wght-normal.*\.woff2$/.test(file));
const preload = fonts.map((file) => `<link rel="preload" href="/assets/${file}" as="font" type="font/woff2" crossorigin />`).join('\n    ');

mkdirSync(join(dist, 'landing'), { recursive: true });
const seen = [];
for (const page of renderPages()) {
  // Plain functions, not strings: `$` in the text must never be read as a replacement pattern.
  const html = template
    .replace('<html lang="uz"', () => `<html lang="${page.language}"`)
    .replace('<!--landing-head-->', () => [page.head, preload].filter(Boolean).join('\n    '))
    .replace('<!--landing-body-->', () => page.body);
  const file = `${page.path === '/' ? 'uz' : page.path.slice(1)}.html`;
  writeFileSync(join(dist, 'landing', file), html);
  seen.push(`${page.path} -> landing/${file} (${Math.round(html.length / 1024)} KB)`);
}

writeFileSync(join(dist, 'robots.txt'), robotsTxt());
if (SITE_URL) writeFileSync(join(dist, 'sitemap.xml'), sitemapXml());
else console.warn('VITE_SITE_URL is not set: no canonical links, hreflang, structured data or sitemap in this build.');

rmSync(join(dist, 'landing.html'));
if (existsSync(ssr)) rmSync(ssr, { recursive: true });
console.log(`Prerendered:\n  ${seen.join('\n  ')}`);
