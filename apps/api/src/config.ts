import { z } from 'zod';

const DEV_JWT_SECRET = 'dev-only-secret-change-me-dev-only-secret-change-me';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().default(4000),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().default('postgres://yap_app:yap_app_dev@localhost:5434/yap'),
  DATABASE_OWNER_URL: z.string().default('postgres://yap:yap_dev@localhost:5434/yap'),
  /** Read-only role for the AI layer. Defaults to DATABASE_URL with the yap_ai credentials. */
  AI_DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().default('redis://localhost:6381'),
  JWT_SECRET: z.string().min(32).default(DEV_JWT_SECRET),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  BCRYPT_ROUNDS: z.coerce.number().default(10),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_DIR: z.string().default('./storage'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('yap'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  /** Telegram chat that hears about each new enquiry from the website. */
  LEADS_TELEGRAM_CHAT_ID: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  /** "true" states the key is on a billing-enabled project. See modules/ai/provider/index.ts. */
  GEMINI_PAID_TIER: z.string().optional(),
  /** "gemini" or "claude". Unset, it follows whichever key is present, Gemini first. */
  AI_PROVIDER: z.string().optional(),
  /** Set to "false" to run the API without background jobs. */
  JOBS_ENABLED: z.string().default('true'),
  /** Pinged once a minute while the deep health check passes, so an outside service notices when it stops. */
  HEARTBEAT_URL: z.string().optional(),
  /** "true" serves /api/docs in production too. Anyone can read it there, signed in or not. */
  API_DOCS: z.string().optional(),
});

const parsed = schema.parse(process.env);

if (parsed.NODE_ENV === 'production' && parsed.JWT_SECRET === DEV_JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production');
}

export const config = parsed;
export const isTest = config.NODE_ENV === 'test';
export const isProd = config.NODE_ENV === 'production';
