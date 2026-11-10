import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ScenarioAssumptions, runScenario } from '@yap/shared/formulas/scenario';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '@/components';
import { TooltipProvider } from '@/components/ui';
import { formatMoney, formatMonth } from '@/lib/format';
import i18n from '@/lib/i18n';
import { pathKey } from '@/lib/query';
import ScenarioPlannerPage from './ScenarioPlannerPage';
import { BASELINE_PATH, type Baseline, SCENARIOS_PATH, type SavedScenario, emptyAssumptions } from './scenarioPlan';

// sonner adds its styles to the page as it loads, and there is no page here.
vi.mock('sonner', () => ({ toast: {} }));

const auth = vi.hoisted(() => ({ permissions: new Set<string>(), modulesOff: new Set<string>() }));

vi.mock('@/lib/auth', async (original) => ({
  ...(await original<typeof import('@/lib/auth')>()),
  usePermission: (permission: string) => auth.permissions.has(permission),
  useCan: () => (permission: string) => auth.permissions.has(permission),
  useModuleEnabled: () => (module: string) => !auth.modulesOff.has(module),
}));

/**
 * The flock of 100 ewes the formula's own test works by hand (packages/shared/src/formulas/scenario.test.ts):
 * cash first goes below zero in April 2027, its lowest point is −14 744, and the plan has paid for
 * itself by September 2027.
 */
const tiny: ScenarioAssumptions = {
  startMonth: '2027-01',
  openingEwes: 100,
  openingRams: 2,
  openingReplacements: 0,
  openingLambs: 0,
  lambingMonth: 3,
  lambingShare: 0.9,
  lambsPerEweLambing: 1.2,
  lambSurvival: 0.9,
  eweDeathsPerYear: 0,
  eweCullsPerYear: 0,
  replacementShare: 0.4,
  firstLambingAgeMonths: 24,
  saleAgeMonths: 6,
  saleWeightKg: 40,
  pricePerKg: 50,
  cullEwePrice: 1000,
  feedAdultStallPerMonth: 30,
  feedAdultGrazingPerMonth: 10,
  stallMonths: [11, 12, 1, 2, 3],
  feedLambPerMonth: 8,
  otherCostPerHeadPerMonth: 2,
  fixedCostPerMonth: 1000,
  oneOffs: [{ month: 0, amount: 5000 }],
  openingCash: 20000,
};

const farm = (assumptions: ScenarioAssumptions, suggestions: Baseline['suggestions'] = {}): Baseline => ({
  asOf: '2027-01-10',
  startMonth: assumptions.startMonth,
  assumptions,
  sources: { openingEwes: { source: 'animals', basis: {} } },
  suggestions,
  costGroups: null,
});

const savedPlan: SavedScenario = {
  id: 'p1',
  name: 'Cheaper feed',
  assumptions: { ...tiny, feedAdultStallPerMonth: 20 },
  notes: null,
  createdAt: '2027-01-05T08:00:00.000Z',
  updatedAt: '2027-01-06T08:00:00.000Z',
};

/** What a person reads. A no-break space reads as a space. */
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

function page(baseline: Baseline, plans: SavedScenario[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, retryOnMount: false } } });
  client.setQueryData(pathKey(BASELINE_PATH), baseline);
  client.setQueryData(pathKey(SCENARIOS_PATH, { pageSize: 200, sort: 'name' }), { data: plans, meta: { page: 1, pageSize: 200, total: plans.length } });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>
          <ConfirmProvider>
            <ScenarioPlannerPage />
          </ConfirmProvider>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  auth.permissions.clear();
  auth.modulesOff.clear();
  await i18n.changeLanguage('en');
});

afterAll(() => {
  void i18n.changeLanguage('uz');
});

describe('who opens the planner', () => {
  it('is closed to a person with no finance right', () => {
    const read = text(page(farm(tiny)));
    expect(read).toContain('No access');
    expect(read).not.toContain('Break-even price per kg');
  });

  it('is closed when the finance module is switched off', () => {
    auth.permissions.add('finance.view');
    auth.modulesOff.add('finance');
    expect(text(page(farm(tiny)))).not.toContain('Break-even price per kg');
  });

  it('shows an investor the plan and the saved plans, with nothing to save, rename or delete', () => {
    auth.permissions.add('finance.summary');
    const markup = page(farm(tiny), [savedPlan]);
    const read = text(markup);
    expect(read).toContain('Break-even price per kg');
    expect(read).toContain('Cheaper feed');
    expect(read).toContain("Reset to the farm's figures");
    expect(read).not.toContain('Save as a new plan');
    expect(markup).not.toContain('aria-label="Rename Cheaper feed"');
    expect(markup).not.toContain('aria-label="Delete Cheaper feed"');
  });

  it('gives each write its own right', () => {
    auth.permissions.add('finance.view');
    auth.permissions.add('finance.create');
    let markup = page(farm(tiny), [savedPlan]);
    expect(text(markup)).toContain('Save as a new plan');
    expect(markup).not.toContain('aria-label="Rename Cheaper feed"');
    expect(markup).not.toContain('aria-label="Delete Cheaper feed"');

    auth.permissions.add('finance.update');
    auth.permissions.add('finance.delete');
    markup = page(farm(tiny), [savedPlan]);
    expect(markup).toContain('aria-label="Rename Cheaper feed"');
    expect(markup).toContain('aria-label="Delete Cheaper feed"');
  });
});

describe('what the planner shows', () => {
  beforeEach(() => {
    auth.permissions.add('finance.view');
  });

  it('shows the figures the shared formula gives, and calls out the month cash runs short', () => {
    const read = text(page(farm(tiny)));
    const { summary } = runScenario(tiny);
    expect(summary.lowestCash).toBeCloseTo(-14744, 6);
    expect(read).toContain(text(formatMoney(summary.breakEvenPricePerKg)));
    expect(read).toContain(text(formatMoney(-14744)));
    expect(read).toContain(`Cash goes below zero in ${formatMonth('2027-04')}`);
    expect(read).toContain(formatMonth('2027-09'));
    expect(read).toContain('covers it');
    expect(read).not.toContain('Some figures cannot be worked out');
  });

  it('says the price does not cover the cost when it is below break-even', () => {
    // Break-even for this flock is about 15.5 a kg.
    expect(text(page(farm({ ...tiny, pricePerKg: 12 })))).toContain('does not cover it');
  });

  it('shows dashes on a farm with no figures, and names the empty assumptions', () => {
    const read = text(page(farm(emptyAssumptions('2027-01'), { eweDeathsPerYear: { value: 0.03, source: 'default' } })));
    expect(read).toContain('Some figures cannot be worked out');
    expect(read).toContain('They show a dash because these assumptions are empty:');
    expect(read).toContain('Price per kg of live weight');
    expect(read).toContain('Break-even price per kg —');
    expect(read).toContain('No sale price is set');
    expect(read).not.toContain('Cash goes below zero');
    expect(read).not.toContain('Cash stays above zero');
    // The app's own starting value is offered apart, never shown as the farm's.
    expect(read).toContain('Empty assumptions the app has a starting value for: 1');
    expect(read).toContain("No figure in the farm's records. The app's starting value: 3%");
  });

  it('does not work out a plan that holds a figure outside its limits', () => {
    const read = text(page(farm({ ...tiny, lambSurvival: 1.4 })));
    expect(read).toContain('The plan cannot be worked out yet');
    expect(read).toContain('Lambs alive at weaning');
    expect(read).not.toContain('Year by year');
  });

  it('has every string in each language', async () => {
    for (const language of ['uz', 'ru', 'en']) {
      await i18n.changeLanguage(language);
      for (const baseline of [farm(tiny), farm(emptyAssumptions('2027-01'), { stallMonths: { value: [11, 12, 1, 2, 3], source: 'default' } })]) {
        const markup = page(baseline, [savedPlan]);
        expect(markup, language).not.toMatch(/scenarios\.[a-z]/i);
        expect(markup, language).not.toContain('{{');
      }
    }
  });
});
