import { GitBranch } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { EmptyState, ErrorCard, useUrlParam } from '@/components';
import { Alert, Badge, Card, Combobox, Label, Skeleton } from '@/components/ui';
import { useDetail } from '@/lib/query';
import { animalOptions } from './options';
import type { AncestorNode, DescendantNode, Pedigree, PedigreeBase } from './types';

function AnimalChip({ node, role }: { node: PedigreeBase; role?: string }) {
  const { t } = useTranslation('vet');
  return (
    <Link
      to={`/livestock/animals/${node.id}`}
      className="focus-ring flex min-h-11 flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 hover:border-input"
    >
      {role && <span className="text-sm text-muted-foreground">{role}</span>}
      <span className="font-semibold text-primary">{node.tag}</span>
      <Badge>{t(`enums:animalCategory.${node.category}`)}</Badge>
      {node.status !== 'active' && <Badge variant="outline">{t(`enums:animalStatus.${node.status}`)}</Badge>}
    </Link>
  );
}

function Branch({ children }: { children: ReactNode }) {
  return <ul className="mt-2 ml-3 space-y-2 border-l-2 border-border pl-3">{children}</ul>;
}

function Unknown({ role }: { role: string }) {
  const { t } = useTranslation('vet');
  return (
    <p className="flex min-h-11 items-center gap-2 rounded-lg border border-dashed border-border px-3 text-sm text-muted-foreground">
      {role}: {t('pedigree.unknown')}
    </p>
  );
}

function AncestorTree({ node }: { node: AncestorNode }) {
  const { t } = useTranslation('vet');
  const hasParents = node.dam || node.sire;
  if (!hasParents) return null;
  return (
    <Branch>
      {[
        { parent: node.dam, role: t('pedigree.dam') },
        { parent: node.sire, role: t('pedigree.sire') },
      ].map(({ parent, role }) => (
        <li key={role}>
          {parent ? (
            <>
              <AnimalChip node={parent} role={role} />
              <AncestorTree node={parent} />
            </>
          ) : (
            <Unknown role={role} />
          )}
        </li>
      ))}
    </Branch>
  );
}

function DescendantTree({ nodes }: { nodes: DescendantNode[] }) {
  if (nodes.length === 0) return null;
  return (
    <Branch>
      {nodes.map((node) => (
        <li key={node.id}>
          <AnimalChip node={node} />
          <DescendantTree nodes={node.children} />
        </li>
      ))}
    </Branch>
  );
}

export function PedigreeTab() {
  const { t } = useTranslation('vet');
  const [animalId, setAnimalId] = useUrlParam('animal');
  const pedigree = useDetail<Pedigree>(animalId ? `/livestock/pedigree/${animalId}` : null);

  return (
    <div className="space-y-4">
      <div className="max-w-md space-y-1">
        <Label htmlFor="pedigree-animal">{t('pedigree.pick')}</Label>
        <Combobox id="pedigree-animal" value={animalId || null} onChange={(value) => setAnimalId(value ?? '')} loadOptions={animalOptions()} selectedLabel={pedigree.data?.animal.tag} />
      </div>

      {!animalId && <EmptyState icon={GitBranch} title={t('pedigree.emptyTitle')} description={t('pedigree.emptyBody')} />}
      {pedigree.error && <ErrorCard error={pedigree.error} onRetry={() => void pedigree.refetch()} />}
      {animalId && pedigree.isLoading && <Skeleton className="h-48 w-full" />}

      {pedigree.data && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="p-4">
            <h3 className="mb-3 font-semibold">{t('pedigree.ancestors')}</h3>
            <AnimalChip node={pedigree.data.animal} />
            <AncestorTree node={pedigree.data.animal} />
            {!pedigree.data.animal.dam && !pedigree.data.animal.sire && <p className="mt-2 text-sm text-muted-foreground">{t('pedigree.noAncestors')}</p>}
          </Card>
          <Card className="p-4">
            <h3 className="mb-3 font-semibold">{t('pedigree.descendants')}</h3>
            {pedigree.data.descendants.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('pedigree.noDescendants')}</p>
            ) : (
              <>
                <AnimalChip node={pedigree.data.animal} />
                <DescendantTree nodes={pedigree.data.descendants} />
              </>
            )}
            {pedigree.data.truncated && (
              <Alert tone="info" className="mt-3">
                {t('pedigree.truncated')}
              </Alert>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
