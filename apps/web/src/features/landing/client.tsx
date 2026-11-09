import '@fontsource-variable/manrope';
import '@fontsource-variable/onest';
import '@/index.css';
import type { LandingCopy, LandingLanguage } from '@yap/shared/landing';
import { hydrateRoot } from 'react-dom/client';
import { LeadForm } from './LeadForm';
import { closeMenuWhenDone } from './menu';
import { CONTACT_PHONE } from './site';

/**
 * The page itself is finished HTML. Only the contact form needs a script, and its text comes from
 * the page, so a visitor never downloads the other languages. The header menu only needs closing.
 */
closeMenuWhenDone();

const root = document.getElementById('lead-form');
const form = root?.querySelector<HTMLElement>('[data-form]');
if (root && form) {
  const language = root.dataset.language as LandingLanguage;
  const copy = JSON.parse(root.dataset.copy ?? '{}') as LandingCopy['form'];
  hydrateRoot(form, <LeadForm copy={copy} language={language} phone={CONTACT_PHONE || undefined} />);
}
