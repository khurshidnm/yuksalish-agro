import type { FastifyInstance } from 'fastify';
import ai from './ai';
import alerts from './alerts';
import assets from './assets';
import auth from './auth';
import crops from './crops';
import dashboard from './dashboard';
import devices from './devices';
import farm from './farm';
import feed from './feed';
import files from './files';
import finance from './finance';
import hr from './hr';
import importModule from './import';
import inventory from './inventory';
import livestock from './livestock';
import notifications from './notifications';
import platform from './platform';
import reports from './reports';
import sales from './sales';
import settings from './settings';
import tasks from './tasks';
import today from './today';

export const MODULE_PLUGINS: Record<string, (app: FastifyInstance) => Promise<void>> = {
  auth,
  files,
  farm,
  crops,
  assets,
  livestock,
  inventory,
  feed,
  finance,
  sales,
  hr,
  tasks,
  alerts,
  notifications,
  devices,
  dashboard,
  reports,
  ai,
  import: importModule,
  settings,
  platform,
  today,
};
