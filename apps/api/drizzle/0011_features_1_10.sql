CREATE TABLE "groundwater_observations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"field_id" uuid NOT NULL,
	"date" date NOT NULL,
	"depth_m" numeric(6, 2) NOT NULL,
	"mineralisation_gl" numeric(6, 2),
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "animal_gradings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"animal_id" uuid NOT NULL,
	"date" date NOT NULL,
	"class_key" text NOT NULL,
	"graded_by" text,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "body_condition_scores" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"animal_id" uuid NOT NULL,
	"date" date NOT NULL,
	"score" numeric(2, 1) NOT NULL,
	"notes" text,
	CONSTRAINT "body_condition_one_per_day" UNIQUE("animal_id","date")
);
--> statement-breakpoint
CREATE TABLE "cull_marks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"animal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"marked_on" date NOT NULL,
	"cleared_on" date
);
--> statement-breakpoint
CREATE TABLE "fat_tail_measurements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"animal_id" uuid NOT NULL,
	"date" date NOT NULL,
	"width_cm" numeric(5, 1),
	"length_cm" numeric(5, 1),
	"circumference_cm" numeric(5, 1),
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "lamb_care" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lamb_id" uuid NOT NULL,
	"colostrum_at" timestamp with time zone,
	"navel_treated" boolean DEFAULT false NOT NULL,
	"mothering" text DEFAULT 'with_dam' NOT NULL,
	"foster_ewe_id" uuid,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "pen_stays" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"facility_id" uuid NOT NULL,
	"ewe_id" uuid NOT NULL,
	"lambing_id" uuid,
	"since_date" date NOT NULL,
	"planned_release_date" date NOT NULL,
	"released_date" date,
	"previous_facility_id" uuid,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "pregnancy_scans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"breeding_id" uuid NOT NULL,
	"ewe_id" uuid NOT NULL,
	"date" date NOT NULL,
	"fetus_count" integer NOT NULL,
	"scanned_by" text,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "scenarios" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"assumptions" jsonb NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "animal_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"animal_id" uuid NOT NULL,
	"counterparty_id" uuid,
	"customer_name" text,
	"customer_phone" text,
	"agreed_price" numeric(18, 2),
	"reserved_until" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"note" text,
	"sale_id" uuid,
	"request_id" uuid,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"close_reason" text
);
--> statement-breakpoint
CREATE TABLE "catalogue_listings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"animal_id" uuid NOT NULL,
	"price" numeric(18, 2)
);
--> statement-breakpoint
CREATE TABLE "catalogue_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"animal_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"wanted" text,
	"note" text,
	"language" text DEFAULT 'uz' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"submissions" integer DEFAULT 1 NOT NULL,
	"closed_by" uuid,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "geofences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'allowed' NOT NULL,
	"field_id" uuid,
	"geometry" jsonb,
	"herd_id" uuid,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grazing_cell_days" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"date" date NOT NULL,
	"herd_id" uuid,
	"cell_x" integer NOT NULL,
	"cell_y" integer NOT NULL,
	"fixes" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grazing_field_days" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"date" date NOT NULL,
	"herd_id" uuid,
	"field_id" uuid NOT NULL,
	"fixes" integer NOT NULL,
	"animals" integer NOT NULL,
	"animal_hours" numeric(10, 2) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crops" ADD COLUMN "family" text;--> statement-breakpoint
ALTER TABLE "crops" ADD COLUMN "removal_n_kg_t" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "crops" ADD COLUMN "removal_p_2o5_kg_t" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "crops" ADD COLUMN "removal_k_2o_kg_t" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "facilities" ADD COLUMN "lambing_pen" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "field_vegetation" ADD COLUMN "ndmi_mean" numeric(5, 3);--> statement-breakpoint
ALTER TABLE "breeding_records" ADD COLUMN "fetus_count" integer;--> statement-breakpoint
ALTER TABLE "breeding_records" ADD COLUMN "scan_date" date;--> statement-breakpoint
ALTER TABLE "lambing_records" ADD COLUMN "born_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "me_mj_per_kg_dm" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "crude_protein_pct_dm" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "calcium_g_per_kg_dm" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "phosphorus_g_per_kg_dm" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "is_roughage" boolean;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "n_pct" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "p2o5_pct" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "k2o_pct" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "alert_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "link" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "completion_source" text;--> statement-breakpoint
ALTER TABLE "groundwater_observations" ADD CONSTRAINT "groundwater_observations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groundwater_observations" ADD CONSTRAINT "groundwater_observations_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groundwater_observations" ADD CONSTRAINT "groundwater_observations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groundwater_observations" ADD CONSTRAINT "groundwater_observations_field_id_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."fields"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "animal_gradings" ADD CONSTRAINT "animal_gradings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "animal_gradings" ADD CONSTRAINT "animal_gradings_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "animal_gradings" ADD CONSTRAINT "animal_gradings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "animal_gradings" ADD CONSTRAINT "animal_gradings_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "body_condition_scores" ADD CONSTRAINT "body_condition_scores_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "body_condition_scores" ADD CONSTRAINT "body_condition_scores_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "body_condition_scores" ADD CONSTRAINT "body_condition_scores_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "body_condition_scores" ADD CONSTRAINT "body_condition_scores_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cull_marks" ADD CONSTRAINT "cull_marks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cull_marks" ADD CONSTRAINT "cull_marks_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cull_marks" ADD CONSTRAINT "cull_marks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cull_marks" ADD CONSTRAINT "cull_marks_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fat_tail_measurements" ADD CONSTRAINT "fat_tail_measurements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fat_tail_measurements" ADD CONSTRAINT "fat_tail_measurements_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fat_tail_measurements" ADD CONSTRAINT "fat_tail_measurements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fat_tail_measurements" ADD CONSTRAINT "fat_tail_measurements_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lamb_care" ADD CONSTRAINT "lamb_care_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lamb_care" ADD CONSTRAINT "lamb_care_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lamb_care" ADD CONSTRAINT "lamb_care_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lamb_care" ADD CONSTRAINT "lamb_care_lamb_id_animals_id_fk" FOREIGN KEY ("lamb_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lamb_care" ADD CONSTRAINT "lamb_care_foster_ewe_id_animals_id_fk" FOREIGN KEY ("foster_ewe_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pen_stays" ADD CONSTRAINT "pen_stays_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pen_stays" ADD CONSTRAINT "pen_stays_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pen_stays" ADD CONSTRAINT "pen_stays_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pen_stays" ADD CONSTRAINT "pen_stays_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pen_stays" ADD CONSTRAINT "pen_stays_ewe_id_animals_id_fk" FOREIGN KEY ("ewe_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pen_stays" ADD CONSTRAINT "pen_stays_lambing_id_lambing_records_id_fk" FOREIGN KEY ("lambing_id") REFERENCES "public"."lambing_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pen_stays" ADD CONSTRAINT "pen_stays_previous_facility_id_facilities_id_fk" FOREIGN KEY ("previous_facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pregnancy_scans" ADD CONSTRAINT "pregnancy_scans_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pregnancy_scans" ADD CONSTRAINT "pregnancy_scans_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pregnancy_scans" ADD CONSTRAINT "pregnancy_scans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pregnancy_scans" ADD CONSTRAINT "pregnancy_scans_breeding_id_breeding_records_id_fk" FOREIGN KEY ("breeding_id") REFERENCES "public"."breeding_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pregnancy_scans" ADD CONSTRAINT "pregnancy_scans_ewe_id_animals_id_fk" FOREIGN KEY ("ewe_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "animal_reservations" ADD CONSTRAINT "animal_reservations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "animal_reservations" ADD CONSTRAINT "animal_reservations_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "animal_reservations" ADD CONSTRAINT "animal_reservations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "animal_reservations" ADD CONSTRAINT "animal_reservations_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "animal_reservations" ADD CONSTRAINT "animal_reservations_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "animal_reservations" ADD CONSTRAINT "animal_reservations_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "animal_reservations" ADD CONSTRAINT "animal_reservations_request_id_catalogue_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."catalogue_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "animal_reservations" ADD CONSTRAINT "animal_reservations_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalogue_listings" ADD CONSTRAINT "catalogue_listings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalogue_listings" ADD CONSTRAINT "catalogue_listings_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalogue_listings" ADD CONSTRAINT "catalogue_listings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalogue_listings" ADD CONSTRAINT "catalogue_listings_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalogue_requests" ADD CONSTRAINT "catalogue_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalogue_requests" ADD CONSTRAINT "catalogue_requests_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalogue_requests" ADD CONSTRAINT "catalogue_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalogue_requests" ADD CONSTRAINT "catalogue_requests_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geofences" ADD CONSTRAINT "geofences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geofences" ADD CONSTRAINT "geofences_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geofences" ADD CONSTRAINT "geofences_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geofences" ADD CONSTRAINT "geofences_field_id_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geofences" ADD CONSTRAINT "geofences_herd_id_herds_id_fk" FOREIGN KEY ("herd_id") REFERENCES "public"."herds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grazing_cell_days" ADD CONSTRAINT "grazing_cell_days_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grazing_cell_days" ADD CONSTRAINT "grazing_cell_days_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grazing_cell_days" ADD CONSTRAINT "grazing_cell_days_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grazing_cell_days" ADD CONSTRAINT "grazing_cell_days_herd_id_herds_id_fk" FOREIGN KEY ("herd_id") REFERENCES "public"."herds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grazing_field_days" ADD CONSTRAINT "grazing_field_days_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grazing_field_days" ADD CONSTRAINT "grazing_field_days_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grazing_field_days" ADD CONSTRAINT "grazing_field_days_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grazing_field_days" ADD CONSTRAINT "grazing_field_days_herd_id_herds_id_fk" FOREIGN KEY ("herd_id") REFERENCES "public"."herds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grazing_field_days" ADD CONSTRAINT "grazing_field_days_field_id_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "groundwater_observations_field_id_date_index" ON "groundwater_observations" USING btree ("field_id","date");--> statement-breakpoint
CREATE INDEX "animal_gradings_animal_id_date_index" ON "animal_gradings" USING btree ("animal_id","date");--> statement-breakpoint
CREATE INDEX "animal_gradings_farm_id_class_key_index" ON "animal_gradings" USING btree ("farm_id","class_key");--> statement-breakpoint
CREATE INDEX "body_condition_scores_farm_id_date_index" ON "body_condition_scores" USING btree ("farm_id","date");--> statement-breakpoint
CREATE INDEX "cull_marks_farm_id_cleared_on_index" ON "cull_marks" USING btree ("farm_id","cleared_on");--> statement-breakpoint
CREATE INDEX "cull_marks_animal_id_index" ON "cull_marks" USING btree ("animal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cull_marks_one_open_per_animal" ON "cull_marks" USING btree ("animal_id") WHERE cleared_on is null;--> statement-breakpoint
CREATE INDEX "fat_tail_measurements_animal_id_date_index" ON "fat_tail_measurements" USING btree ("animal_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "lamb_care_one_per_lamb" ON "lamb_care" USING btree ("lamb_id");--> statement-breakpoint
CREATE INDEX "lamb_care_farm_id_mothering_index" ON "lamb_care" USING btree ("farm_id","mothering");--> statement-breakpoint
CREATE INDEX "pen_stays_farm_id_facility_id_index" ON "pen_stays" USING btree ("farm_id","facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pen_stays_one_open_per_ewe" ON "pen_stays" USING btree ("ewe_id") WHERE released_date is null;--> statement-breakpoint
CREATE INDEX "pregnancy_scans_breeding_id_index" ON "pregnancy_scans" USING btree ("breeding_id");--> statement-breakpoint
CREATE INDEX "pregnancy_scans_farm_id_date_index" ON "pregnancy_scans" USING btree ("farm_id","date");--> statement-breakpoint
CREATE INDEX "scenarios_farm_id_name_index" ON "scenarios" USING btree ("farm_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "animal_reservations_one_open_per_animal" ON "animal_reservations" USING btree ("animal_id") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "animal_reservations_farm_id_status_reserved_until_index" ON "animal_reservations" USING btree ("farm_id","status","reserved_until");--> statement-breakpoint
CREATE INDEX "animal_reservations_counterparty_id_index" ON "animal_reservations" USING btree ("counterparty_id");--> statement-breakpoint
CREATE INDEX "animal_reservations_sale_id_index" ON "animal_reservations" USING btree ("sale_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalogue_listings_animal" ON "catalogue_listings" USING btree ("animal_id");--> statement-breakpoint
CREATE INDEX "catalogue_listings_farm_id_index" ON "catalogue_listings" USING btree ("farm_id");--> statement-breakpoint
CREATE INDEX "catalogue_requests_farm_id_status_index" ON "catalogue_requests" USING btree ("farm_id","status");--> statement-breakpoint
CREATE INDEX "catalogue_requests_tenant_id_phone_index" ON "catalogue_requests" USING btree ("tenant_id","phone");--> statement-breakpoint
CREATE INDEX "geofences_farm_id_index" ON "geofences" USING btree ("farm_id");--> statement-breakpoint
CREATE INDEX "grazing_cell_days_farm_id_date_index" ON "grazing_cell_days" USING btree ("farm_id","date");--> statement-breakpoint
CREATE INDEX "grazing_field_days_farm_id_date_index" ON "grazing_field_days" USING btree ("farm_id","date");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_catalogue_slug" ON "tenants" USING btree ((settings #>> '{catalogue,slug}'));--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_open_alert_idx" ON "tasks" USING btree ("alert_id") WHERE alert_id IS NOT NULL AND status NOT IN ('done', 'cancelled');