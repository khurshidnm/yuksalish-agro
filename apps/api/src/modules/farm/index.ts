import type { FastifyInstance } from 'fastify';
import { registerDocuments } from './documents.routes';
import { registerFacilities } from './facilities.routes';
import { registerFields } from './fields.routes';
import { registerPassport } from './passport.routes';
import { registerWeather } from './weather.routes';

export default async function farmModule(app: FastifyInstance) {
  registerPassport(app);
  registerFields(app);
  registerFacilities(app);
  registerDocuments(app);
  registerWeather(app);
}
