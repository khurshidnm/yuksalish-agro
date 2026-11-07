import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Checkbox, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Label, Select } from '@/components/ui';
import { canGroupBy } from './format';
import type { CatalogReport } from './types';

export interface CustomizeResult {
  columns: string[] | null;
  groupBy: string | null;
}

export interface CustomizeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  report: CatalogReport;
  columns: string[] | null;
  groupBy: string | null;
  onApply: (result: CustomizeResult) => void;
  onSave: (result: CustomizeResult) => void;
}

function Body({ report, columns, groupBy, onApply, onSave, onOpenChange }: Omit<CustomizeDialogProps, 'open'>) {
  const { t } = useTranslation('reports');
  const all = report.columns.map((c) => c.key);
  const [chosen, setChosen] = useState<string[]>(columns ?? all);
  const [group, setGroup] = useState(groupBy ?? '');

  const everything = chosen.length === all.length;
  // Keep the report's own column order, whatever order the boxes were ticked in.
  const ordered = all.filter((key) => chosen.includes(key));
  const result = (): CustomizeResult => ({ columns: everything ? null : ordered, groupBy: group || null });
  const groupOptions = report.columns.filter(canGroupBy).map((c) => ({ value: c.key, label: c.label }));

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('builder.title')}</DialogTitle>
        <DialogDescription>{t('builder.description')}</DialogDescription>
      </DialogHeader>

      <DialogBody className="space-y-4">
        <div className="space-y-1.5">
          <div className="flex min-h-11 items-center justify-between gap-3">
            <span className="text-sm font-medium">{t('builder.columns')}</span>
            <Label className="flex min-h-11 cursor-pointer items-center gap-2 font-normal">
              <Checkbox checked={everything} onCheckedChange={(checked) => setChosen(checked ? all : [all[0]])} />
              {t('builder.selectAll')}
            </Label>
          </div>
          <ul className="grid grid-cols-1 max-h-64 gap-1 overflow-y-auto rounded-lg border border-border p-2 sm:grid-cols-2">
            {report.columns.map((column) => (
              <li key={column.key}>
                <Label className="flex min-h-11 cursor-pointer items-center gap-3 font-normal">
                  <Checkbox
                    checked={chosen.includes(column.key)}
                    disabled={chosen.length === 1 && chosen[0] === column.key}
                    onCheckedChange={(checked) =>
                      setChosen(checked ? [...chosen, column.key] : chosen.filter((key) => key !== column.key))
                    }
                  />
                  <span className="min-w-0">{column.label}</span>
                </Label>
              </li>
            ))}
          </ul>
        </div>

        {groupOptions.length > 0 && (
          <div className="space-y-1.5">
            <Label htmlFor="report-group">{t('builder.groupBy')}</Label>
            <Select
              id="report-group"
              value={group}
              placeholder={t('builder.noGrouping')}
              options={groupOptions}
              onChange={(event) => setGroup(event.target.value)}
            />
            {group && <p className="text-sm text-muted-foreground">{t('builder.groupHint')}</p>}
          </div>
        )}
      </DialogBody>

      <DialogFooter>
        <Button variant="outline" onClick={() => onSave(result())}>
          {t('builder.saveAs')}
        </Button>
        <Button
          onClick={() => {
            onApply(result());
            onOpenChange(false);
          }}
        >
          {t('builder.apply')}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Choices apply to the URL, so they show at once and travel with a shared link. */
export function CustomizeDialog({ open, onOpenChange, ...props }: CustomizeDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* Mounted only while open, so it always starts from what is currently applied. */}
        {open && <Body {...props} onOpenChange={onOpenChange} />}
      </DialogContent>
    </Dialog>
  );
}
