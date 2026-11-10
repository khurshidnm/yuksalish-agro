import { FERTILISER_SOURCE, SOIL_TEST_MAX_AGE_YEARS } from '@yap/shared/formulas/fertiliser';
import { useTranslation } from 'react-i18next';
import { type Column, DataTableView } from '@/components';
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui';
import { formatDate, formatNumber } from '@/lib/format';
import type { FertiliserNutrient, FieldCard, NutrientAdvice } from './types';
import { formatHa, useLocalName } from './utils';

const NUTRIENTS: readonly FertiliserNutrient[] = ['n', 'p2o5', 'k2o'];

/** Chemical notation reads the same in every script, so it stays out of the dictionaries. */
const FORMULA: Record<FertiliserNutrient, string> = { n: 'N', p2o5: 'P₂O₅', k2o: 'K₂O' };

type Row = NutrientAdvice & { nutrient: FertiliserNutrient };

/**
 * Fertiliser rate for the field's current plan, from its latest soil analysis, with every input the
 * figure rests on. A nutrient the data cannot carry shows a dash and the reason, never a guess.
 */
export function FertiliserCard({ field }: { field: FieldCard }) {
  const { t } = useTranslation('farm');
  const localName = useLocalName();
  const advice = field.fertiliser;
  const crop = field.currentCrop;
  if (!advice || !crop) return null;

  const rows: Row[] = NUTRIENTS.map((nutrient) => ({ nutrient, ...advice.nutrients[nutrient] }));
  const kgHa = (value: number | null) => (value === null ? '—' : `${formatNumber(value, 1)} ${t('fertiliser.kgHa')}`);
  const columns: Column<Row>[] = [
    { key: 'nutrient', header: t('fertiliser.nutrient'), cell: (row) => FORMULA[row.nutrient], mobile: 'title' },
    { key: 'removal', header: t('fertiliser.removal'), cell: (row) => formatNumber(row.removalPerT, 1), align: 'right' },
    { key: 'uptake', header: t('fertiliser.uptake'), cell: (row) => formatNumber(row.uptakeKgHa, 1), align: 'right' },
    { key: 'soil', header: t('fertiliser.soil'), cell: (row) => formatNumber(row.soilMgKg, 1), align: 'right' },
    { key: 'soilGives', header: t('fertiliser.soilGives'), cell: (row) => formatNumber(row.soilSupplyKgHa, 1), align: 'right' },
    { key: 'rate', header: t('fertiliser.rate'), cell: (row) => <span className="font-semibold">{kgHa(row.rateKgHa)}</span>, align: 'right' },
  ];
  const unanswered = rows.filter((row) => row.reason !== null);
  const names = (list: FertiliserNutrient[]) => list.map((nutrient) => FORMULA[nutrient]).join(', ');

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>{t('fertiliser.title')}</CardTitle>
          {advice.removalSource === 'typical' && <Badge variant="warning">{t('fertiliser.typical')}</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">
          {t('fertiliser.inputs', {
            crop: localName(crop.cropName),
            yield: advice.targetYieldTHa === null ? '—' : `${formatNumber(advice.targetYieldTHa)} ${t('unit.tHa')}`,
            date: advice.analysis ? formatDate(advice.analysis.date) : '—',
          })}
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!advice.analysis && <Alert tone="info">{t('fertiliser.noAnalysis')}</Alert>}
        {advice.analysis?.stale && (
          <Alert tone="warning" title={t('fertiliser.staleTitle')}>
            {t('fertiliser.staleBody', { date: formatDate(advice.analysis.date), years: SOIL_TEST_MAX_AGE_YEARS })}
          </Alert>
        )}
        {advice.targetYieldTHa === null && <Alert tone="info">{t('fertiliser.noYield')}</Alert>}
        <DataTableView<Row> rows={rows} rowKey={(row) => row.nutrient} columns={columns} />
        {unanswered.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
            {unanswered.map((row) => (
              <li key={row.nutrient}>
                <span className="font-medium text-foreground">{FORMULA[row.nutrient]}:</span> {t(`fertiliser.reason.${row.reason}`)}
              </li>
            ))}
          </ul>
        )}
        {advice.removalSource === 'typical' && <p className="text-sm text-muted-foreground">{t('fertiliser.typicalHint')}</p>}

        {advice.products && advice.products.products.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="font-medium">{t('fertiliser.productsTitle')}</p>
            <ul className="flex flex-col divide-y divide-border">
              {advice.products.products.map((product) => (
                <li key={product.id} className="flex flex-col gap-0.5 py-2 first:pt-0 last:pb-0">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 font-medium break-words">{product.name}</span>
                    <span className="shrink-0 font-semibold">{kgHa(product.kgHa)}</span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {t('fertiliser.productGives', {
                      n: formatNumber(product.gives.n, 1),
                      p: formatNumber(product.gives.p2o5, 1),
                      k: formatNumber(product.gives.k2o, 1),
                      nName: FORMULA.n,
                      pName: FORMULA.p2o5,
                      kName: FORMULA.k2o,
                      total: formatNumber(product.kgHa * crop.areaHa, 0),
                      area: formatHa(crop.areaHa),
                    })}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
        {advice.products && advice.products.uncovered.length > 0 && (
          <Alert tone="warning">{t('fertiliser.uncovered', { nutrients: names(advice.products.uncovered) })}</Alert>
        )}
        {advice.productsWithoutContent.length > 0 && (
          <p className="text-sm text-muted-foreground">
            {t('fertiliser.withoutContent', { names: advice.productsWithoutContent.map((product) => product.name).join(', ') })}
          </p>
        )}
        <p className="text-xs text-muted-foreground">{t('fertiliser.source', { source: FERTILISER_SOURCE })}</p>
      </CardContent>
    </Card>
  );
}
