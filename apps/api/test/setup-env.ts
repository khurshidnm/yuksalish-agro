import { inject } from 'vitest';

// Runs before any test imports src/config.ts, so the app connects to this run's database.
const name = inject('databaseName');
process.env.DATABASE_URL = `postgres://yap_app:yap_app_dev@localhost:5434/${name}`;
process.env.DATABASE_OWNER_URL = `postgres://yap:yap_dev@localhost:5434/${name}`;
