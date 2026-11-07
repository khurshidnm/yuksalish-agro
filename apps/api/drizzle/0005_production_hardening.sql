CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"full_name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_audit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admin_id" uuid,
	"action" text NOT NULL,
	"target_id" text,
	"ip" text,
	"device" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_codes_codeHash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "sign_in_failures" (
	"phone" text NOT NULL,
	"address" text NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	CONSTRAINT "sign_in_failures_phone_address_pk" PRIMARY KEY("phone","address")
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"job" text NOT NULL,
	"next_due_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX "audit_logs_tenant_id_at_index";--> statement-breakpoint
DROP INDEX "events_farm_id_occurred_at_index";--> statement-breakpoint
DROP INDEX "events_farm_id_type_occurred_at_index";--> statement-breakpoint
DROP INDEX "field_operations_farm_id_date_index";--> statement-breakpoint
DROP INDEX "field_operations_field_id_date_index";--> statement-breakpoint
DROP INDEX "soil_analyses_field_id_date_index";--> statement-breakpoint
DROP INDEX "animal_exits_farm_id_date_index";--> statement-breakpoint
DROP INDEX "daily_logs_farm_id_date_index";--> statement-breakpoint
DROP INDEX "health_records_animal_id_date_index";--> statement-breakpoint
DROP INDEX "health_records_herd_id_date_index";--> statement-breakpoint
DROP INDEX "health_records_farm_id_date_index";--> statement-breakpoint
DROP INDEX "lambing_records_farm_id_date_index";--> statement-breakpoint
DROP INDEX "weight_records_animal_id_date_index";--> statement-breakpoint
DROP INDEX "stock_movements_farm_id_date_index";--> statement-breakpoint
DROP INDEX "transactions_farm_id_date_index";--> statement-breakpoint
DROP INDEX "asset_usage_logs_asset_id_date_index";--> statement-breakpoint
DROP INDEX "maintenance_records_asset_id_date_index";--> statement-breakpoint
DROP INDEX "prices_item_id_date_index";--> statement-breakpoint
DROP INDEX "sales_farm_id_date_index";--> statement-breakpoint
DROP INDEX "notifications_tenant_id_created_at_index";--> statement-breakpoint
DROP INDEX "webhook_deliveries_subscription_id_created_at_index";--> statement-breakpoint
DROP INDEX "ai_insights_farm_id_created_at_index";--> statement-breakpoint
DROP INDEX "import_jobs_farm_id_created_at_index";--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "repeats" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_last_step" integer;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "dedup_key" text;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "undelivered_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_audit" ADD CONSTRAINT "platform_audit_admin_id_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invitations_phone_index" ON "invitations" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "invitations_tenant_id_index" ON "invitations" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_pending_idx" ON "invitations" USING btree ("farm_id","phone") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "platform_audit_created_at_index" ON "platform_audit" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "recovery_codes_user_id_index" ON "recovery_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sign_in_failures_window_started_at_index" ON "sign_in_failures" USING btree ("window_started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_runs_farm_id_job_index" ON "job_runs" USING btree ("farm_id","job");--> statement-breakpoint
CREATE INDEX "events_device_feed_index" ON "events" USING btree ("farm_id","occurred_at") WHERE source in ('camera', 'sensor');--> statement-breakpoint
CREATE INDEX "events_notable_index" ON "events" USING btree ("farm_id","severity","occurred_at") WHERE severity <> 'info';--> statement-breakpoint
CREATE UNIQUE INDEX "events_device_dedup_idx" ON "events" USING btree ("device_id","dedup_key") WHERE dedup_key is not null;--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_id_at_index" ON "audit_logs" USING btree ("tenant_id","at");--> statement-breakpoint
CREATE INDEX "events_farm_id_occurred_at_index" ON "events" USING btree ("farm_id","occurred_at");--> statement-breakpoint
CREATE INDEX "events_farm_id_type_occurred_at_index" ON "events" USING btree ("farm_id","type","occurred_at");--> statement-breakpoint
CREATE INDEX "field_operations_farm_id_date_index" ON "field_operations" USING btree ("farm_id","date");--> statement-breakpoint
CREATE INDEX "field_operations_field_id_date_index" ON "field_operations" USING btree ("field_id","date");--> statement-breakpoint
CREATE INDEX "soil_analyses_field_id_date_index" ON "soil_analyses" USING btree ("field_id","date");--> statement-breakpoint
CREATE INDEX "animal_exits_farm_id_date_index" ON "animal_exits" USING btree ("farm_id","date");--> statement-breakpoint
CREATE INDEX "daily_logs_farm_id_date_index" ON "daily_logs" USING btree ("farm_id","date");--> statement-breakpoint
CREATE INDEX "health_records_animal_id_date_index" ON "health_records" USING btree ("animal_id","date");--> statement-breakpoint
CREATE INDEX "health_records_herd_id_date_index" ON "health_records" USING btree ("herd_id","date");--> statement-breakpoint
CREATE INDEX "health_records_farm_id_date_index" ON "health_records" USING btree ("farm_id","date");--> statement-breakpoint
CREATE INDEX "lambing_records_farm_id_date_index" ON "lambing_records" USING btree ("farm_id","date");--> statement-breakpoint
CREATE INDEX "weight_records_animal_id_date_index" ON "weight_records" USING btree ("animal_id","date");--> statement-breakpoint
CREATE INDEX "stock_movements_farm_id_date_index" ON "stock_movements" USING btree ("farm_id","date");--> statement-breakpoint
CREATE INDEX "transactions_farm_id_date_index" ON "transactions" USING btree ("farm_id","date");--> statement-breakpoint
CREATE INDEX "asset_usage_logs_asset_id_date_index" ON "asset_usage_logs" USING btree ("asset_id","date");--> statement-breakpoint
CREATE INDEX "maintenance_records_asset_id_date_index" ON "maintenance_records" USING btree ("asset_id","date");--> statement-breakpoint
CREATE INDEX "prices_item_id_date_index" ON "prices" USING btree ("item_id","date");--> statement-breakpoint
CREATE INDEX "sales_farm_id_date_index" ON "sales" USING btree ("farm_id","date");--> statement-breakpoint
CREATE INDEX "notifications_tenant_id_created_at_index" ON "notifications" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_subscription_id_created_at_index" ON "webhook_deliveries" USING btree ("subscription_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_insights_farm_id_created_at_index" ON "ai_insights" USING btree ("farm_id","created_at");--> statement-breakpoint
CREATE INDEX "import_jobs_farm_id_created_at_index" ON "import_jobs" USING btree ("farm_id","created_at");