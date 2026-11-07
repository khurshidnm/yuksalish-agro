CREATE TABLE "field_vegetation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"field_id" uuid NOT NULL,
	"scene_id" uuid NOT NULL,
	"date" date NOT NULL,
	"clear_pct" numeric(5, 2) NOT NULL,
	"cell_count" integer NOT NULL,
	"ndvi_mean" numeric(5, 3),
	"ndvi_p_10" numeric(5, 3),
	"ndvi_p_50" numeric(5, 3),
	"ndvi_p_90" numeric(5, 3),
	"grid" jsonb,
	"weak_zones" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "field_vegetation_fieldId_sceneId_unique" UNIQUE("field_id","scene_id")
);
--> statement-breakpoint
CREATE TABLE "pasture_samples" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"field_id" uuid NOT NULL,
	"date" date NOT NULL,
	"biomass_kg_ha" numeric(10, 1) NOT NULL,
	"ndvi" numeric(5, 3),
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "satellite_scenes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scene_id" text NOT NULL,
	"date" date NOT NULL,
	"source" text DEFAULT 'sentinel-2' NOT NULL,
	"tile_cloud_pct" numeric(5, 2),
	"clear_pct" numeric(5, 2),
	"status" text DEFAULT 'done' NOT NULL,
	CONSTRAINT "satellite_scenes_farmId_sceneId_unique" UNIQUE("farm_id","scene_id")
);
--> statement-breakpoint
CREATE TABLE "weather_hourly" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"period_hours" integer DEFAULT 1 NOT NULL,
	"temp_c" numeric(5, 2),
	"rh_pct" numeric(5, 2),
	"wind_ms" numeric(5, 2),
	"precip_mm" numeric(7, 2),
	"weather_code" integer,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weather_hourly_farmId_time_unique" UNIQUE("farm_id","time")
);
--> statement-breakpoint
ALTER TABLE "weather_daily" ALTER COLUMN "source" SET DEFAULT 'met-norway';--> statement-breakpoint
ALTER TABLE "farms" ADD COLUMN "elevation_m" double precision;--> statement-breakpoint
ALTER TABLE "fields" ADD COLUMN "soil_texture" text;--> statement-breakpoint
ALTER TABLE "weather_daily" ADD COLUMN "rh_mean_pct" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "weather_daily" ADD COLUMN "dew_point_c" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "weather_daily" ADD COLUMN "wind_mean_ms" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "weather_daily" ADD COLUMN "solar_mj" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "field_vegetation" ADD CONSTRAINT "field_vegetation_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_vegetation" ADD CONSTRAINT "field_vegetation_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_vegetation" ADD CONSTRAINT "field_vegetation_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_vegetation" ADD CONSTRAINT "field_vegetation_field_id_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."fields"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_vegetation" ADD CONSTRAINT "field_vegetation_scene_id_satellite_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."satellite_scenes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pasture_samples" ADD CONSTRAINT "pasture_samples_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pasture_samples" ADD CONSTRAINT "pasture_samples_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pasture_samples" ADD CONSTRAINT "pasture_samples_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pasture_samples" ADD CONSTRAINT "pasture_samples_field_id_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."fields"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "satellite_scenes" ADD CONSTRAINT "satellite_scenes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "satellite_scenes" ADD CONSTRAINT "satellite_scenes_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "satellite_scenes" ADD CONSTRAINT "satellite_scenes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weather_hourly" ADD CONSTRAINT "weather_hourly_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weather_hourly" ADD CONSTRAINT "weather_hourly_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weather_hourly" ADD CONSTRAINT "weather_hourly_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "field_vegetation_field_id_date_index" ON "field_vegetation" USING btree ("field_id","date");--> statement-breakpoint
CREATE INDEX "pasture_samples_field_id_date_index" ON "pasture_samples" USING btree ("field_id","date");--> statement-breakpoint
CREATE INDEX "satellite_scenes_farm_id_date_index" ON "satellite_scenes" USING btree ("farm_id","date");