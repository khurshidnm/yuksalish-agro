CREATE TABLE "animal_track_days" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"animal_id" uuid NOT NULL,
	"date" date NOT NULL,
	"readings" integer NOT NULL,
	"fixes" integer NOT NULL,
	"distance_m" numeric(9, 1),
	"activity_mean" double precision,
	"temperature_median_c" numeric(4, 2),
	"temperature_max_c" numeric(4, 2)
);
--> statement-breakpoint
CREATE TABLE "animal_tracking" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"animal_id" uuid NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"position_at" timestamp with time zone,
	"temperature_c" numeric(4, 2),
	"temperature_at" timestamp with time zone,
	"activity" double precision,
	"activity_at" timestamp with time zone,
	"last_reading_at" timestamp with time zone,
	"flags" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracker_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_id" uuid NOT NULL,
	"animal_id" uuid NOT NULL,
	"fitted_on" date NOT NULL,
	"removed_on" date,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "tracker_readings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_id" uuid NOT NULL,
	"animal_id" uuid,
	"recorded_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"activity" double precision,
	"temperature_c" numeric(4, 2),
	"battery_pct" numeric(5, 2),
	"rssi" integer,
	"snr" numeric(5, 2),
	"gateway_id" text
);
--> statement-breakpoint
CREATE TABLE "tracker_state" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_id" uuid NOT NULL,
	"last_reading_at" timestamp with time zone NOT NULL,
	"battery_pct" numeric(5, 2),
	"battery_at" timestamp with time zone,
	"rssi" integer,
	"snr" numeric(5, 2),
	"gateway_id" text
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "animal_track_days" ADD CONSTRAINT "animal_track_days_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "animal_track_days" ADD CONSTRAINT "animal_track_days_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "animal_track_days" ADD CONSTRAINT "animal_track_days_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "animal_track_days" ADD CONSTRAINT "animal_track_days_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "animal_tracking" ADD CONSTRAINT "animal_tracking_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "animal_tracking" ADD CONSTRAINT "animal_tracking_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "animal_tracking" ADD CONSTRAINT "animal_tracking_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "animal_tracking" ADD CONSTRAINT "animal_tracking_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_assignments" ADD CONSTRAINT "tracker_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_assignments" ADD CONSTRAINT "tracker_assignments_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_assignments" ADD CONSTRAINT "tracker_assignments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_assignments" ADD CONSTRAINT "tracker_assignments_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_assignments" ADD CONSTRAINT "tracker_assignments_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_readings" ADD CONSTRAINT "tracker_readings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_readings" ADD CONSTRAINT "tracker_readings_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_readings" ADD CONSTRAINT "tracker_readings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_readings" ADD CONSTRAINT "tracker_readings_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_readings" ADD CONSTRAINT "tracker_readings_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_state" ADD CONSTRAINT "tracker_state_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_state" ADD CONSTRAINT "tracker_state_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_state" ADD CONSTRAINT "tracker_state_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_state" ADD CONSTRAINT "tracker_state_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "animal_track_days_animal_date" ON "animal_track_days" USING btree ("animal_id","date");--> statement-breakpoint
CREATE INDEX "animal_track_days_farm_id_date_index" ON "animal_track_days" USING btree ("farm_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "animal_tracking_animal" ON "animal_tracking" USING btree ("animal_id");--> statement-breakpoint
CREATE INDEX "animal_tracking_farm_id_index" ON "animal_tracking" USING btree ("farm_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tracker_assignments_one_open_per_device" ON "tracker_assignments" USING btree ("device_id") WHERE removed_on is null;--> statement-breakpoint
CREATE INDEX "tracker_assignments_animal_id_index" ON "tracker_assignments" USING btree ("animal_id");--> statement-breakpoint
CREATE INDEX "tracker_assignments_farm_id_removed_on_index" ON "tracker_assignments" USING btree ("farm_id","removed_on");--> statement-breakpoint
CREATE UNIQUE INDEX "tracker_readings_device_time" ON "tracker_readings" USING btree ("device_id","recorded_at");--> statement-breakpoint
CREATE INDEX "tracker_readings_farm_id_recorded_at_index" ON "tracker_readings" USING btree ("farm_id","recorded_at");--> statement-breakpoint
CREATE INDEX "tracker_readings_animal_id_recorded_at_index" ON "tracker_readings" USING btree ("animal_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tracker_state_device" ON "tracker_state" USING btree ("device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_external_id" ON "devices" USING btree ("tenant_id","external_id") WHERE external_id is not null;