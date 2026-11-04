import { latest } from './alerts.service';

/** Unresolved alerts this user may see, most severe first. */
export const openAlerts = (limit: number) => latest(limit);
