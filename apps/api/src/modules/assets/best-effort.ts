import { tx } from '../../core/context';

/**
 * Run something the record does not depend on: a weather snapshot or a fuel alert is a useful
 * extra, the field work itself is not optional. Returns null when it fails.
 *
 * It runs in a savepoint, because a failed statement would otherwise abort the whole request
 * transaction and take the user's record down with it.
 */
export async function bestEffort<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await tx().transaction(() => fn());
  } catch {
    return null;
  }
}
