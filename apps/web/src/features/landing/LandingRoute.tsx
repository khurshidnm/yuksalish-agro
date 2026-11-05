import type { LandingLanguage } from '@yap/shared/landing';
import { useEffect } from 'react';
import { LandingPage } from './LandingPage';

/**
 * The public page inside the app, for development and for the moment after signing out. In
 * production nginx serves the prerendered files in dist/landing, which is what search engines read.
 */
export default function LandingRoute({ language = 'uz' }: { language?: LandingLanguage }) {
  useEffect(() => {
    const theme = document.documentElement.dataset.theme;
    document.documentElement.dataset.theme = 'light';
    return () => {
      if (theme) document.documentElement.dataset.theme = theme;
    };
  }, []);
  return <LandingPage language={language} />;
}
