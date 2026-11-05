// Tells the service worker what this build is, so that it can refuse to take over until all of it has
// arrived (public/sw.js). Runs last in the build: see the build script in package.json.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER_PLACEHOLDER = "const BUILD = { version: 'unbuilt', required: [], files: [] };";

/** Every file a start of these Vite manifest entries needs: their own code, what it imports, and the styles. */
export function requiredFiles(manifest, entries) {
  const files = new Set();
  const seen = new Set();
  const visit = (key) => {
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = manifest[key];
    if (!chunk) throw new Error(`${key} is not in the build: update src/features/today/offline-screens.json`);
    files.add(chunk.file);
    for (const css of chunk.css ?? []) files.add(css);
    for (const dependency of chunk.imports ?? []) visit(dependency);
  };
  entries.forEach(visit);
  return [...files].map((file) => `/${file}`).sort();
}

/** A build's identity: the same inputs give the same version, so a rebuild with no change updates nobody. */
export function stampBuild({ html, worker, manifest, offlineScreens, assets }) {
  if (!worker.includes(WORKER_PLACEHOLDER)) throw new Error('public/sw.js has lost its BUILD line');
  if (!html.includes('</head>')) throw new Error('index.html has no </head>');
  const files = assets.map((file) => `/assets/${file}`).sort();
  const required = requiredFiles(manifest, ['index.html', ...offlineScreens]);
  const version = createHash('sha256').update(html).update(worker).update(files.join('\n')).digest('hex').slice(0, 16);
  return {
    version,
    required,
    html: html.replace('</head>', () => `  <meta name="yap-build" content="${version}" />\n  </head>`),
    worker: worker.replace(WORKER_PLACEHOLDER, () => `const BUILD = ${JSON.stringify({ version, required, files })};`),
  };
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const dist = join(root, 'dist');
  const page = join(dist, 'index.html');
  const script = join(dist, 'sw.js');
  const stamped = stampBuild({
    html: readFileSync(page, 'utf8'),
    worker: readFileSync(script, 'utf8'),
    manifest: JSON.parse(readFileSync(join(dist, '.vite/manifest.json'), 'utf8')),
    offlineScreens: JSON.parse(readFileSync(join(root, 'src/features/today/offline-screens.json'), 'utf8')),
    assets: readdirSync(join(dist, 'assets')),
  });
  writeFileSync(page, stamped.html);
  writeFileSync(script, stamped.worker);
  // Only this script needs it, and nginx would otherwise serve it to anyone who asks.
  if (existsSync(join(dist, '.vite'))) rmSync(join(dist, '.vite'), { recursive: true });
  console.log(`Build ${stamped.version}: ${stamped.required.length} files needed to start and to work offline.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
