/**
 * Reference data for the field screens. Every answer from the server is also stored on the device,
 * and screens render from the stored copy at once, so a bad connection costs nothing but freshness.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { api } from '@/lib/api';
import { useCan, useSession } from '@/lib/auth';
import { clearMeta, idbStore, useOutbox } from '@/lib/outbox';
import type { DirectoryAnimal } from './logic';

export interface TodayLine {
  itemId: string;
  itemName: string;
  unit: string;
  plannedQty: number;
  qtyOnHand: number;
}

export interface TodayHerdLog {
  id: string;
  updatedAt: string;
  createdBy: string | null;
  headCount: number;
  waterL: number | null;
  condition: string;
  notes: string | null;
  lines: { itemId: string; actualQty: number }[];
}

export interface TodayHerd {
  id: string;
  name: string;
  state: string;
  headCount: number;
  lines: TodayLine[];
  log: TodayHerdLog | null;
}

export interface TodayTask {
  id: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  priority: string;
  status: string;
  requiresPhoto: boolean;
  requiresRecord: string | null;
  entityLabel: string | null;
}

export interface TodayData {
  date: string;
  generatedAt: string;
  tasks: TodayTask[];
  attendance: { status: string | null; checkIn: string | null; checkOut: string | null; openShift: boolean } | null;
  actions: string[];
  herds: TodayHerd[];
  feedItems: { id: string; name: string; unit: string; qtyOnHand: number; defaultWarehouseId: string | null }[];
  warehouses: { id: string; name: string; type: string }[];
}

interface Stored<T> {
  savedAt: number;
  data: T;
}

/** A hung connection should fall back to the stored copy, not leave a spinner. */
const REQUEST_TIMEOUT_MS = 10_000;

function useOwnerKey(): string {
  const session = useSession();
  return `${session.user.id}:${session.farm?.id ?? ''}`;
}

/** Stored and live data for one endpoint. */
function useStoredQuery<T>(path: string, key: string, options: { enabled?: boolean; staleTime: number }) {
  const stored = useQuery({
    queryKey: ['offline-copy', key],
    queryFn: async () => (await idbStore.getMeta<Stored<T>>(key)) ?? null,
    // TanStack pauses queries while the browser says it is offline, which is exactly when this must run.
    networkMode: 'always',
    staleTime: Number.POSITIVE_INFINITY,
  });
  const live = useQuery({
    queryKey: ['today', path, key],
    queryFn: async () => {
      const data = await api.get<T>(path, undefined, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      await idbStore.setMeta(key, { savedAt: Date.now(), data } satisfies Stored<T>);
      return data;
    },
    enabled: options.enabled ?? true,
    networkMode: 'always',
    retry: false,
    staleTime: options.staleTime,
    refetchOnReconnect: true,
  });

  const data = live.data ?? stored.data?.data ?? null;
  return {
    data,
    /** Showing a stored copy because the server could not be reached. */
    offline: live.isError,
    savedAt: live.isError || !live.data ? (stored.data?.savedAt ?? null) : live.dataUpdatedAt,
    loading: data === null && (stored.isPending || live.isPending),
    error: data === null ? live.error : null,
    refetch: live.refetch,
  };
}

export function useTodayData() {
  const key = `today:${useOwnerKey()}`;
  const result = useStoredQuery<TodayData>('/today', key, { staleTime: 15_000 });

  // A delivered record changes what the server would say, e.g. this herd is now logged.
  const { delivered } = useOutbox();
  const client = useQueryClient();
  useEffect(() => {
    if (delivered > 0) void client.invalidateQueries({ queryKey: ['today'] });
  }, [delivered, client]);

  return result;
}

interface DirectoryPayload {
  truncated: boolean;
  animals: DirectoryAnimal[];
}

/** Every animal on the farm, for finding one by tag with no connection. */
export function useAnimalDirectory() {
  const can = useCan();
  const key = `animals:${useOwnerKey()}`;
  const result = useStoredQuery<DirectoryPayload>('/today/animals', key, {
    enabled: can('livestock.view'),
    staleTime: 10 * 60_000,
  });
  const animals = useMemo(() => result.data?.animals ?? [], [result.data]);
  return { ...result, animals, known: result.data !== null };
}

export interface WatchEwe {
  breedingId: string;
  eweId: string;
  tag: string;
  expectedDate: string;
  expectedEarliest: string;
  expectedLatest: string;
  fetusCount: number | null;
  herdId: string | null;
  herdName: string | null;
  facilityId: string | null;
  facilityName: string | null;
  barnName: string | null;
  daysLeft: number;
  overdue: boolean;
  firstLambing: boolean;
  complications: { date: string; text: string }[];
  stillborn: number;
  inPen: boolean;
}

export interface WatchData {
  today: string;
  days: number;
  ewes: WatchEwe[];
  freePens: { id: string; name: string; parentName: string | null }[];
}

/** The night-watch list and the free pens, kept on the phone for the barn at night. */
export function useNightWatch() {
  const can = useCan();
  const key = `today:watch:${useOwnerKey()}`;
  const result = useStoredQuery<WatchData>('/livestock/lambing-desk/watch', key, {
    enabled: can('livestock.view') && can('livestock.create'),
    staleTime: 60_000,
  });

  // A delivered lambing takes the ewe off the list, and a delivered pen stay takes the pen.
  const { delivered } = useOutbox();
  const client = useQueryClient();
  useEffect(() => {
    if (delivered > 0) void client.invalidateQueries({ queryKey: ['today', '/livestock/lambing-desk/watch'] });
  }, [delivered, client]);

  return result;
}

/** Called on sign-out. The outbox stays: unsent work is not reference data. */
export async function clearReferenceData(): Promise<void> {
  await clearMeta('today:');
  await clearMeta('animals:');
}
