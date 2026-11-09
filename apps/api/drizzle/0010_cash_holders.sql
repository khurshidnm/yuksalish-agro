CREATE TABLE "cash_handovers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"holder_account_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"currency" text NOT NULL,
	"fx_rate" numeric(18, 6),
	"date" date NOT NULL,
	"source" text NOT NULL,
	"from_account_id" uuid,
	"note" text,
	"status" text DEFAULT 'sent' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"dispute_reason" text,
	"transaction_id" uuid,
	"reversed_by" uuid,
	"reversed_at" timestamp with time zone,
	"reversed_reason" text
);
--> statement-breakpoint
CREATE TABLE "cash_holders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"account_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "cash_holders_accountId_unique" UNIQUE("account_id")
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "action" jsonb;--> statement-breakpoint
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_holder_account_id_accounts_id_fk" FOREIGN KEY ("holder_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_from_account_id_accounts_id_fk" FOREIGN KEY ("from_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_reversed_by_users_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_holders" ADD CONSTRAINT "cash_holders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_holders" ADD CONSTRAINT "cash_holders_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_holders" ADD CONSTRAINT "cash_holders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_holders" ADD CONSTRAINT "cash_holders_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_holders" ADD CONSTRAINT "cash_holders_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_handovers_farm_id_status_index" ON "cash_handovers" USING btree ("farm_id","status");--> statement-breakpoint
CREATE INDEX "cash_handovers_holder_account_id_date_index" ON "cash_handovers" USING btree ("holder_account_id","date");--> statement-breakpoint
CREATE INDEX "cash_holders_farm_id_employee_id_index" ON "cash_holders" USING btree ("farm_id","employee_id");--> statement-breakpoint
INSERT INTO "finance_categories" ("id", "tenant_id", "kind", "group", "key", "name")
SELECT gen_random_uuid(), "id", 'expense', 'labor', 'casual_labour', '{"uz":"Kunlik ishchilar haqi","ru":"Оплата подённых работников","en":"Day labour"}'::jsonb
FROM "tenants"
ON CONFLICT ("tenant_id", "key") DO NOTHING;--> statement-breakpoint
INSERT INTO "finance_categories" ("id", "tenant_id", "kind", "group", "key", "name")
SELECT gen_random_uuid(), "id", 'expense', 'financial', 'cash_shortage', '{"uz":"Kassa kamomadi","ru":"Недостача в кассе","en":"Cash shortage"}'::jsonb
FROM "tenants"
ON CONFLICT ("tenant_id", "key") DO NOTHING;--> statement-breakpoint
INSERT INTO "finance_categories" ("id", "tenant_id", "kind", "group", "key", "name")
SELECT gen_random_uuid(), "id", 'income', 'other_income', 'cash_surplus', '{"uz":"Kassa ortiqchasi","ru":"Излишек в кассе","en":"Cash surplus"}'::jsonb
FROM "tenants"
ON CONFLICT ("tenant_id", "key") DO NOTHING;--> statement-breakpoint
-- The owner's own money in and out is the owner's right from now on (permissions.ts, FINANCE_CAPITAL).
UPDATE "roles" SET "permissions" = "permissions" || '["finance.capital"]'::jsonb
WHERE "key" = 'owner' AND NOT ("permissions" @> '["finance.capital"]'::jsonb);
