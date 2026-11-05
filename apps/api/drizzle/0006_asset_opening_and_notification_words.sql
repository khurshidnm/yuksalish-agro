ALTER TABLE "assets" ADD COLUMN "opening_depreciation" numeric(18, 2) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "opening_depreciation_date" date;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "texts" jsonb;