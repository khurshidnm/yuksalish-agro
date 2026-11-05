import { LANGUAGES, resources } from '@yap/shared/i18n';
import { LANDING_LANGUAGES } from '@yap/shared/landing';
import { renderToString } from 'react-dom/server';
import { LandingPage } from './LandingPage';
import { headFor, robotsTxt, sitemapXml } from './seo';
import { LANDING_PATHS, SITE_URL } from './site';

/** What scripts/prerender.mjs turns into static files at build time. */
export function renderPages() {
  return LANDING_LANGUAGES.map((language) => ({
    language,
    path: LANDING_PATHS[language],
    head: headFor(language),
    body: renderToString(<LandingPage language={language} />),
  }));
}

/** The words index.html shows by itself when the app cannot start. */
export function bootWords() {
  return Object.fromEntries(LANGUAGES.map(({ code }) => [code, (resources[code].common as { boot: Record<string, string> }).boot]));
}

export { robotsTxt, sitemapXml, SITE_URL };
