import type { FastifyInstance } from 'fastify';
import { registerGeofences } from './geofences.routes';
import { registerIngest } from './ingest.routes';
import { registerTrackers } from './trackers.routes';
import { registerTracking } from './tracking.routes';

/** Live location and health of animals from collars and boluses (docs/tracking.md). */
export default async function trackingModule(app: FastifyInstance) {
  registerIngest(app);
  registerTrackers(app);
  registerTracking(app);
  registerGeofences(app);
}
