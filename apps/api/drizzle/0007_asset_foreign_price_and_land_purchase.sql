ALTER TABLE "assets" ADD COLUMN "purchase_amount" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "purchase_currency" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "purchase_fx_rate" numeric(18, 6);--> statement-breakpoint
INSERT INTO "finance_categories" ("id", "tenant_id", "kind", "group", "key", "name")
SELECT gen_random_uuid(), "id", 'expense', 'investment', 'land_purchase', '{"uz":"Yer xaridi","ru":"Покупка земли","en":"Land purchase"}'::jsonb
FROM "tenants"
ON CONFLICT ("tenant_id", "key") DO NOTHING;
