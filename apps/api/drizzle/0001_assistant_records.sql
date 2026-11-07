CREATE TABLE "ai_aliases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"phrase" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	CONSTRAINT "ai_aliases_farmId_targetType_phrase_unique" UNIQUE("farm_id","target_type","phrase")
);
--> statement-breakpoint
CREATE TABLE "ai_proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"channel" text DEFAULT 'web' NOT NULL,
	"source_text" text NOT NULL,
	"fields" jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"needs_duplicate_confirmation" boolean DEFAULT false NOT NULL,
	"learn" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"undo_until" timestamp with time zone,
	"result_type" text,
	"result_id" uuid,
	"result_status" text
);
--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD COLUMN "channel" text DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_aliases" ADD CONSTRAINT "ai_aliases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_aliases" ADD CONSTRAINT "ai_aliases_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_aliases" ADD CONSTRAINT "ai_aliases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_proposals" ADD CONSTRAINT "ai_proposals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_proposals" ADD CONSTRAINT "ai_proposals_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_proposals" ADD CONSTRAINT "ai_proposals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_proposals" ADD CONSTRAINT "ai_proposals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_proposals" ADD CONSTRAINT "ai_proposals_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_proposals_user_id_status_index" ON "ai_proposals" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "ai_proposals_conversation_id_index" ON "ai_proposals" USING btree ("conversation_id");