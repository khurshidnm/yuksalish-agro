CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"phone" text NOT NULL,
	"farm_name" text,
	"region" text,
	"farm_type" text,
	"farm_size" text,
	"message" text,
	"language" text DEFAULT 'uz' NOT NULL,
	"source" text,
	"utm" jsonb,
	"status" text DEFAULT 'new' NOT NULL,
	"notes" text,
	"submissions" integer DEFAULT 1 NOT NULL,
	"consent_at" timestamp with time zone NOT NULL,
	"contacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "leads_status_created_at_index" ON "leads" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "leads_phone_index" ON "leads" USING btree ("phone");