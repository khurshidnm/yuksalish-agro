import type { ReactNode } from 'react';
import { useCallback } from 'react';
import { useSearchParams } from 'react-router';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui';

/** A string value kept in the query string, so filters and tabs survive reload and can be shared. */
export function useUrlParam(name: string, defaultValue = ''): [string, (value: string) => void] {
  const [params, setParams] = useSearchParams();
  const value = params.get(name) ?? defaultValue;
  const set = useCallback(
    (next: string) => {
      setParams(
        (prev) => {
          const updated = new URLSearchParams(prev);
          if (next === defaultValue || next === '') updated.delete(name);
          else updated.set(name, next);
          return updated;
        },
        { replace: true },
      );
    },
    [name, defaultValue, setParams],
  );
  return [value, set];
}

export interface UrlTab {
  value: string;
  label: ReactNode;
  content: ReactNode;
  hidden?: boolean;
}

export interface UrlTabsProps {
  tabs: UrlTab[];
  /** Query parameter; change it when a page has two tab sets. */
  param?: string;
  className?: string;
}

/** Tabs whose active tab lives in the URL. Only the active tab's content mounts. */
export function UrlTabs({ tabs, param = 'tab', className }: UrlTabsProps) {
  const visible = tabs.filter((tab) => !tab.hidden);
  const first = visible[0]?.value ?? '';
  const [active, setActive] = useUrlParam(param, first);
  const current = visible.some((tab) => tab.value === active) ? active : first;

  return (
    <Tabs value={current} onValueChange={setActive} className={className}>
      <TabsList>
        {visible.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {visible.map((tab) => (
        <TabsContent key={tab.value} value={tab.value}>
          {tab.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}
