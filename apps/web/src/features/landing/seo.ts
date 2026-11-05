import { LANDING_LANGUAGES, type LandingLanguage, landingCopy } from '@yap/shared/landing';
import { CONTACT_PHONE, LANDING_PATHS, OG_LOCALES, SITE_NAME, SITE_URL } from './site';

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Text inside a <script> must never be able to close it. */
const jsonLd = (data: unknown): string => JSON.stringify(data).replace(/</g, '\\u003c');

const absolute = (path: string): string => `${SITE_URL}${path}`;

const ogImage = (language: LandingLanguage): string => `/og/${language === 'uz-Cyrl' ? 'uz' : language}.png`;

function structuredData(language: LandingLanguage): unknown {
  const copy = landingCopy[language];
  const url = absolute(LANDING_PATHS[language]);
  const organization = {
    '@type': 'Organization',
    '@id': `${SITE_URL}/#organization`,
    name: SITE_NAME,
    url: SITE_URL,
    logo: absolute('/icons/icon-512.png'),
    ...(CONTACT_PHONE
      ? { contactPoint: { '@type': 'ContactPoint', telephone: CONTACT_PHONE.replace(/\s/g, ''), contactType: 'sales', availableLanguage: ['uz', 'ru'] } }
      : {}),
  };
  return {
    '@context': 'https://schema.org',
    '@graph': [
      organization,
      { '@type': 'WebSite', '@id': `${SITE_URL}/#website`, url: SITE_URL, name: SITE_NAME, publisher: { '@id': `${SITE_URL}/#organization` } },
      {
        '@type': 'SoftwareApplication',
        name: SITE_NAME,
        url,
        description: copy.meta.description,
        applicationCategory: 'BusinessApplication',
        applicationSubCategory: 'Farm management',
        operatingSystem: 'Web',
        inLanguage: language,
        publisher: { '@id': `${SITE_URL}/#organization` },
      },
      {
        '@type': 'FAQPage',
        inLanguage: language,
        mainEntity: copy.faq.items.map((item) => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: item.a },
        })),
      },
    ],
  };
}

/** Everything a page needs in <head>. Addresses that must be absolute appear only with a site URL. */
export function headFor(language: LandingLanguage): string {
  const { meta } = landingCopy[language];
  const tags = [
    `<title>${escapeHtml(meta.title)}</title>`,
    `<meta name="description" content="${escapeHtml(meta.description)}" />`,
    `<meta name="keywords" content="${escapeHtml(meta.keywords)}" />`,
    '<meta name="robots" content="index, follow, max-image-preview:large" />',
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:locale" content="${OG_LOCALES[language]}" />`,
    `<meta property="og:title" content="${escapeHtml(meta.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(meta.description)}" />`,
    '<meta property="og:image:width" content="1200" />',
    '<meta property="og:image:height" content="630" />',
    `<meta property="og:image:alt" content="${escapeHtml(meta.ogImageAlt)}" />`,
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:title" content="${escapeHtml(meta.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(meta.description)}" />`,
  ];
  if (SITE_URL) {
    tags.push(
      `<link rel="canonical" href="${absolute(LANDING_PATHS[language])}" />`,
      ...LANDING_LANGUAGES.map((code) => `<link rel="alternate" hreflang="${code}" href="${absolute(LANDING_PATHS[code])}" />`),
      `<link rel="alternate" hreflang="x-default" href="${absolute('/')}" />`,
      `<meta property="og:url" content="${absolute(LANDING_PATHS[language])}" />`,
      `<meta property="og:image" content="${absolute(ogImage(language))}" />`,
      `<meta name="twitter:image" content="${absolute(ogImage(language))}" />`,
      `<script type="application/ld+json">${jsonLd(structuredData(language))}</script>`,
    );
  }
  return tags.join('\n    ');
}

/** The sitemap lists every language of the page, with each one pointing at the others. */
export function sitemapXml(): string {
  const links = LANDING_LANGUAGES.map((code) => `    <xhtml:link rel="alternate" hreflang="${code}" href="${absolute(LANDING_PATHS[code])}" />`).join('\n');
  const urls = LANDING_LANGUAGES.map(
    (code) => `  <url>\n    <loc>${absolute(LANDING_PATHS[code])}</loc>\n${links}\n    <xhtml:link rel="alternate" hreflang="x-default" href="${absolute('/')}" />\n  </url>`,
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`;
}

export function robotsTxt(): string {
  const lines = ['User-agent: *', 'Allow: /', 'Disallow: /api/'];
  if (SITE_URL) lines.push('', `Sitemap: ${absolute('/sitemap.xml')}`);
  return `${lines.join('\n')}\n`;
}
