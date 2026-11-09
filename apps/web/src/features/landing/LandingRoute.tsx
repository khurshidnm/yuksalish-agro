import { type LandingLanguage, landingCopy } from '@yap/shared/landing';
import { useEffect } from 'react';
import { LandingPage } from './LandingPage';
import { closeMenuWhenDone } from './menu';

/** The page's own description, made if the app's page has none. Returns how to put things back. */
function describePage(text: string): () => void {
  let meta = document.head.querySelector<HTMLMetaElement>('meta[name="description"]');
  const before = meta?.content ?? null;
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'description';
    document.head.append(meta);
  }
  meta.content = text;
  const own = meta;
  return () => {
    if (before === null) own.remove();
    else own.content = before;
  };
}

/**
 * The public page inside the app, for development and for the moment after signing out. In
 * production nginx serves the prerendered files in dist/landing, which is what search engines read.
 * It says the same as those files about itself: language, title and description.
 */
export default function LandingRoute({ language = 'uz' }: { language?: LandingLanguage }) {
  useEffect(() => {
    const html = document.documentElement;
    const theme = html.dataset.theme;
    const lang = html.lang;
    const title = document.title;
    html.dataset.theme = 'light';
    html.lang = language;
    document.title = landingCopy[language].meta.title;
    const restoreDescription = describePage(landingCopy[language].meta.description);
    const stopMenu = closeMenuWhenDone();
    return () => {
      if (theme) html.dataset.theme = theme;
      html.lang = lang;
      document.title = title;
      restoreDescription();
      stopMenu();
    };
  }, [language]);
  return <LandingPage language={language} />;
}
