# Data model

Generated from `apps/api/src/db/schema` by `apps/api/src/db/erd.ts`. Do not edit by hand; run
`pnpm --filter @yap/api exec tsx src/db/erd.ts` after a schema change. 104 tables.

Links to `tenants`, `farms` and `users` (`tenant_id`, `farm_id`, `created_by`) are on almost every
table and are left out of the lines to keep the diagrams readable. A table from another domain appears
as an empty box. Beyond the Drizzle schema, `post-schema.sql` adds PostGIS `geom` columns on `fields`
and `facilities`, row-level security, audit triggers, and a composite `(tenant_id, id)` twin for every
foreign key between tenant tables.

## Platform and identity

```mermaid
erDiagram
  api_keys {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    text name
    text key_hash
    text key_prefix
    jsonb scopes
    timestamp_with_time_zone last_used_at
    timestamp_with_time_zone expires_at
    timestamp_with_time_zone revoked_at
    uuid created_by FK
    timestamp_with_time_zone created_at
  }
  farms {
    uuid id PK
    uuid tenant_id FK
    text name
    text region
    text district
    text address
    numeric total_area_ha
    double_precision lat
    double_precision lng
    double_precision elevation_m
    text cadastre_number
    jsonb passport
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
  }
  idempotency_keys {
    uuid tenant_id FK
    text key
    text path
    uuid user_id
    integer status_code
    jsonb response
    timestamp_with_time_zone created_at
  }
  invitations {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid role_id FK
    text phone
    text full_name
    text status
    timestamp_with_time_zone expires_at
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
  }
  leads {
    uuid id PK
    text full_name
    text phone
    text farm_name
    text region
    text farm_type
    text farm_size
    text message
    text language
    text source
    jsonb utm
    text status
    text notes
    integer submissions
    jsonb repeats
    timestamp_with_time_zone consent_at
    timestamp_with_time_zone contacted_at
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
  }
  memberships {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid user_id FK
    uuid role_id FK
    text status
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
  }
  plans {
    uuid id PK
    text key
    text name
    jsonb modules
    numeric price_monthly
    boolean active
    timestamp_with_time_zone created_at
  }
  platform_audit {
    uuid id PK
    uuid admin_id FK
    text action
    text target_id
    text ip
    text device
    timestamp_with_time_zone created_at
  }
  recovery_codes {
    uuid id PK
    uuid user_id FK
    text code_hash
    timestamp_with_time_zone used_at
    timestamp_with_time_zone created_at
  }
  refresh_tokens {
    uuid id PK
    uuid user_id FK
    uuid membership_id FK
    text token_hash
    uuid family_id
    timestamp_with_time_zone expires_at
    timestamp_with_time_zone rotated_at
    timestamp_with_time_zone revoked_at
    text user_agent
    text ip
    timestamp_with_time_zone created_at
  }
  roles {
    uuid id PK
    uuid tenant_id FK
    text key
    text name
    jsonb permissions
    boolean is_system
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
  }
  sign_in_failures {
    text phone
    text address
    integer failures
    timestamp_with_time_zone window_started_at
    timestamp_with_time_zone locked_until
  }
  tenants {
    uuid id PK
    text name
    text legal_name
    text tin
    text legal_form
    text tax_regime
    text currency
    text timezone
    text locale
    uuid plan_id FK
    jsonb modules
    jsonb settings
    text status
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
  }
  users {
    uuid id PK
    text phone
    text email
    text full_name
    text password_hash
    boolean must_change_password
    text locale
    text status
    text totp_secret
    boolean totp_enabled
    integer totp_last_step
    boolean is_platform_admin
    text telegram_chat_id
    uuid telegram_membership_id FK
    timestamp_with_time_zone last_login_at
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
  }
  memberships ||--o{ refresh_tokens : "membership_id"
  memberships ||--o{ users : "telegram_membership_id"
  plans ||--o{ tenants : "plan_id"
  roles ||--o{ invitations : "role_id"
  roles ||--o{ memberships : "role_id"
```

## Core: journal, audit, files, reference data

```mermaid
erDiagram
  audit_logs {
    uuid id PK
    uuid tenant_id
    uuid user_id
    text entity
    text entity_id
    text action
    jsonb before
    jsonb after
    text ip
    text device
    timestamp_with_time_zone at
  }
  breeds {
    uuid id PK
    uuid tenant_id FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid species_id FK
    text key
    jsonb name
    boolean active
  }
  crops {
    uuid id PK
    uuid tenant_id FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text key
    jsonb name
    boolean is_feed
    text default_yield_t_ha
    boolean active
  }
  divisions {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text key
    text name
  }
  documents {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text type
    text title
    text number
    uuid file_id FK
    date issue_date
    date expiry_date
    text entity_type
    uuid entity_id
    text notes
  }
  events {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    timestamp_with_time_zone occurred_at
    text source
    text type
    text severity
    text entity_type
    uuid entity_id
    jsonb data
    uuid photo_file_id
    uuid device_id
    text dedup_key
    uuid created_by FK
    timestamp_with_time_zone created_at
  }
  files {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text storage_key
    text name
    text mime_type
    bigint size_bytes
  }
  species {
    uuid id PK
    uuid tenant_id FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text key
    jsonb name
    integer gestation_days
    integer gestation_min_days
    integer gestation_max_days
    boolean active
  }
  files ||--o{ documents : "file_id"
  species ||--o{ breeds : "species_id"
```

## Land and crops

```mermaid
erDiagram
  crop_plans {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid season_id FK
    uuid field_id FK
    uuid crop_id FK
    uuid tech_card_id
    text variety
    numeric area_ha
    date sowing_date_plan
    date sowing_date_fact
    numeric seed_rate_kg_ha
    numeric expected_yield_t_ha
    numeric planned_cost
    numeric own_use_pct
    text status
    text notes
  }
  facilities {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text type
    text name
    integer capacity
    text capacity_unit
    uuid parent_id
    jsonb boundary
    double_precision lat
    double_precision lng
    numeric area_ha
    text status
    text notes
  }
  field_operation_materials {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid operation_id FK
    uuid item_id FK
    uuid warehouse_id FK
    numeric qty
    numeric norm_per_ha
    numeric total_cost
  }
  field_operations {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text type
    text status
    date date
    date planned_date
    uuid field_id FK
    uuid crop_plan_id FK
    uuid asset_id FK
    uuid employee_id FK
    numeric area_done_ha
    numeric water_m3
    numeric duration_h
    numeric fuel_l
    jsonb details
    double_precision lat
    double_precision lng
    jsonb photo_file_ids
    jsonb weather
    text notes
  }
  field_vegetation {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid field_id FK
    uuid scene_id FK
    date date
    numeric clear_pct
    integer cell_count
    numeric ndvi_mean
    numeric ndvi_p10
    numeric ndvi_p50
    numeric ndvi_p90
    jsonb grid
    jsonb weak_zones
  }
  fields {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text number
    text name
    text land_use
    numeric area_ha
    jsonb boundary
    text soil_type
    text soil_texture
    text salinity_level
    text irrigation_source
    uuid cost_center_id
    text status
    text notes
  }
  harvests {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid field_id FK
    uuid crop_plan_id FK
    date date
    numeric gross_t
    numeric moisture_pct
    text quality
    uuid asset_id FK
    uuid item_id FK
    uuid warehouse_id FK
    uuid batch_id FK
    text notes
  }
  irrigation_nodes {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text type
    text name
    numeric capacity_m3h
    numeric limit_m3
    jsonb geometry
    jsonb field_ids
    text notes
  }
  pasture_samples {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid field_id FK
    date date
    numeric biomass_kg_ha
    numeric ndvi
    text notes
  }
  satellite_scenes {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text scene_id
    date date
    text source
    numeric tile_cloud_pct
    numeric clear_pct
    text status
  }
  seasons {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text name
    text kind
    date start_date
    date end_date
    boolean is_current
  }
  soil_analyses {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid field_id FK
    date date
    numeric n
    numeric p
    numeric k
    numeric ph
    numeric humus
    numeric salinity
    text lab
    uuid file_id FK
    text notes
  }
  tech_cards {
    uuid id PK
    uuid tenant_id FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid crop_id FK
    text name
    jsonb lines
    numeric expected_yield_t_ha
  }
  weather_daily {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    date date
    numeric temp_min
    numeric temp_max
    numeric precipitation_mm
    numeric wind_max_kmh
    integer weather_code
    numeric rh_mean_pct
    numeric dew_point_c
    numeric wind_mean_ms
    numeric solar_mj
    boolean is_forecast
    text source
    timestamp_with_time_zone fetched_at
  }
  weather_hourly {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    timestamp_with_time_zone time
    integer period_hours
    numeric temp_c
    numeric rh_pct
    numeric wind_ms
    numeric precip_mm
    integer weather_code
    timestamp_with_time_zone fetched_at
  }
  assets ||--o{ field_operations : "asset_id"
  assets ||--o{ harvests : "asset_id"
  crop_plans ||--o{ field_operations : "crop_plan_id"
  crop_plans ||--o{ harvests : "crop_plan_id"
  crops ||--o{ crop_plans : "crop_id"
  crops ||--o{ tech_cards : "crop_id"
  employees ||--o{ field_operations : "employee_id"
  field_operations ||--o{ field_operation_materials : "operation_id"
  fields ||--o{ crop_plans : "field_id"
  fields ||--o{ field_operations : "field_id"
  fields ||--o{ field_vegetation : "field_id"
  fields ||--o{ harvests : "field_id"
  fields ||--o{ pasture_samples : "field_id"
  fields ||--o{ soil_analyses : "field_id"
  files ||--o{ soil_analyses : "file_id"
  items ||--o{ field_operation_materials : "item_id"
  items ||--o{ harvests : "item_id"
  satellite_scenes ||--o{ field_vegetation : "scene_id"
  seasons ||--o{ crop_plans : "season_id"
  stock_batches ||--o{ harvests : "batch_id"
  warehouses ||--o{ field_operation_materials : "warehouse_id"
  warehouses ||--o{ harvests : "warehouse_id"
```

## Livestock and veterinary

```mermaid
erDiagram
  animal_exits {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid animal_id FK
    text type
    date date
    numeric live_weight_kg
    numeric carcass_weight_kg
    numeric price_per_kg
    numeric amount
    uuid counterparty_id FK
    text reason
    text vet_conclusion
    numeric loss_amount
    uuid transaction_id FK
    uuid batch_id FK
    jsonb photo_file_ids
    text notes
  }
  animal_identifiers {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid animal_id FK
    text type
    text value
    boolean active
  }
  animals {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text tag
    uuid species_id FK
    uuid breed_id FK
    text sex
    text category
    date birth_date
    boolean birth_date_estimated
    text origin
    uuid dam_id FK
    uuid sire_id FK
    date purchase_date
    numeric purchase_price
    uuid seller_id FK
    uuid herd_id FK
    uuid facility_id FK
    text status
    date quarantine_until
    numeric current_weight_kg
    date last_weighed_on
    numeric birth_weight_kg
    uuid photo_file_id FK
    date exit_date
    text notes
  }
  breeding_records {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid ewe_id FK
    uuid ram_id FK
    text source
    date mating_date
    date expected_date
    date expected_earliest
    date expected_latest
    text status
    text notes
  }
  daily_log_lines {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid log_id FK
    uuid item_id FK
    uuid warehouse_id FK
    numeric planned_qty
    numeric actual_qty
    numeric total_cost
  }
  daily_logs {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid herd_id FK
    date date
    integer head_count
    numeric water_l
    text condition
    jsonb photo_file_ids
    text notes
  }
  health_records {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text type
    uuid animal_id FK
    uuid herd_id FK
    date date
    text diagnosis
    uuid item_id FK
    uuid warehouse_id FK
    numeric dose
    text dose_unit
    numeric qty_used
    integer course_days
    uuid vet_employee_id FK
    text result
    integer withdrawal_days
    date withdrawal_until
    integer head_count
    numeric total_cost
    date next_due_date
    uuid vaccination_plan_id
    text report_status
    date ended_on
    jsonb photo_file_ids
    text notes
  }
  herd_transfers {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid animal_id FK
    uuid from_herd_id FK
    uuid to_herd_id FK
    date date
    text reason
  }
  herds {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text name
    text state
    uuid facility_id FK
    uuid ration_id FK
    uuid cost_center_id
    text status
    text notes
  }
  lambing_records {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid breeding_id FK
    uuid ewe_id FK
    date date
    integer lambs_born
    integer lambs_alive
    jsonb lambs
    text complications
    text notes
  }
  pasture_moves {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid herd_id FK
    uuid field_id FK
    date out_date
    date return_date
    text notes
  }
  shearing_records {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid animal_id FK
    uuid herd_id FK
    date date
    numeric wool_kg
    text quality
    uuid batch_id FK
    text notes
  }
  vaccination_plans {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text name
    uuid item_id FK
    uuid species_id FK
    text category
    integer age_days
    integer interval_days
    boolean mandatory
    boolean active
    text notes
  }
  weighing_campaigns {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid herd_id FK
    date date
    text name
    text status
  }
  weight_records {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid animal_id FK
    date date
    numeric weight_kg
    text method
    uuid campaign_id FK
    text notes
  }
  animals ||--o{ animal_exits : "animal_id"
  animals ||--o{ animal_identifiers : "animal_id"
  animals ||--o{ animals : "dam_id"
  animals ||--o{ animals : "sire_id"
  animals ||--o{ breeding_records : "ewe_id"
  animals ||--o{ breeding_records : "ram_id"
  animals ||--o{ health_records : "animal_id"
  animals ||--o{ herd_transfers : "animal_id"
  animals ||--o{ lambing_records : "ewe_id"
  animals ||--o{ shearing_records : "animal_id"
  animals ||--o{ weight_records : "animal_id"
  breeding_records ||--o{ lambing_records : "breeding_id"
  breeds ||--o{ animals : "breed_id"
  counterparties ||--o{ animal_exits : "counterparty_id"
  counterparties ||--o{ animals : "seller_id"
  daily_logs ||--o{ daily_log_lines : "log_id"
  employees ||--o{ health_records : "vet_employee_id"
  facilities ||--o{ animals : "facility_id"
  facilities ||--o{ herds : "facility_id"
  fields ||--o{ pasture_moves : "field_id"
  files ||--o{ animals : "photo_file_id"
  herds ||--o{ animals : "herd_id"
  herds ||--o{ daily_logs : "herd_id"
  herds ||--o{ health_records : "herd_id"
  herds ||--o{ herd_transfers : "from_herd_id"
  herds ||--o{ herd_transfers : "to_herd_id"
  herds ||--o{ pasture_moves : "herd_id"
  herds ||--o{ shearing_records : "herd_id"
  herds ||--o{ weighing_campaigns : "herd_id"
  items ||--o{ daily_log_lines : "item_id"
  items ||--o{ health_records : "item_id"
  items ||--o{ vaccination_plans : "item_id"
  rations ||--o{ herds : "ration_id"
  species ||--o{ animals : "species_id"
  species ||--o{ vaccination_plans : "species_id"
  stock_batches ||--o{ animal_exits : "batch_id"
  stock_batches ||--o{ shearing_records : "batch_id"
  transactions ||--o{ animal_exits : "transaction_id"
  warehouses ||--o{ daily_log_lines : "warehouse_id"
  warehouses ||--o{ health_records : "warehouse_id"
  weighing_campaigns ||--o{ weight_records : "campaign_id"
```

## Inventory and feed

```mermaid
erDiagram
  items {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text name
    text category
    text unit
    text sku
    text barcode
    numeric dry_matter_pct
    numeric min_qty
    numeric min_days
    uuid default_warehouse_id FK
    numeric withdrawal_days
    numeric transfer_price
    numeric kg_per_unit
    uuid crop_id FK
    boolean active
    text notes
  }
  ration_lines {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid ration_id FK
    uuid item_id FK
    numeric kg_per_head_day
  }
  rations {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text name
    text state
    boolean active
    text notes
  }
  stock_batches {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid item_id FK
    uuid warehouse_id FK
    text batch_no
    text invoice_no
    date received_date
    numeric qty_received
    numeric qty_remaining
    numeric unit_cost
    date expiry_date
    text source
    uuid counterparty_id FK
    uuid field_id FK
    text notes
  }
  stock_count_lines {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid count_id FK
    uuid item_id FK
    numeric system_qty
    numeric actual_qty
    numeric diff_qty
    numeric diff_cost
  }
  stock_counts {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid warehouse_id FK
    date date
    text doc_no
    text status
    text notes
    uuid approved_by FK
    timestamp_with_time_zone approved_at
  }
  stock_movements {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text type
    date date
    uuid item_id FK
    uuid batch_id FK
    uuid warehouse_id FK
    numeric qty
    numeric unit_cost
    numeric total_cost
    uuid cost_center_id FK
    text reason
    text doc_no
    text ref_type
    uuid ref_id
    text notes
  }
  warehouses {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text name
    text type
    uuid facility_id FK
    boolean active
    text notes
  }
  cost_centers ||--o{ stock_movements : "cost_center_id"
  counterparties ||--o{ stock_batches : "counterparty_id"
  crops ||--o{ items : "crop_id"
  facilities ||--o{ warehouses : "facility_id"
  fields ||--o{ stock_batches : "field_id"
  items ||--o{ ration_lines : "item_id"
  items ||--o{ stock_batches : "item_id"
  items ||--o{ stock_count_lines : "item_id"
  items ||--o{ stock_movements : "item_id"
  rations ||--o{ ration_lines : "ration_id"
  stock_batches ||--o{ stock_movements : "batch_id"
  stock_counts ||--o{ stock_count_lines : "count_id"
  warehouses ||--o{ items : "default_warehouse_id"
  warehouses ||--o{ stock_batches : "warehouse_id"
  warehouses ||--o{ stock_counts : "warehouse_id"
  warehouses ||--o{ stock_movements : "warehouse_id"
```

## Finance

```mermaid
erDiagram
  accounts {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text name
    text type
    text currency
    numeric opening_balance
    date opening_date
    text bank_name
    text account_number
    boolean active
  }
  budgets {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text month
    uuid category_id FK
    uuid cost_center_id FK
    numeric amount
    text notes
  }
  contracts {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid counterparty_id FK
    text number
    text title
    date start_date
    date end_date
    numeric amount
    text currency
    text terms
    uuid file_id FK
    text status
  }
  cost_centers {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text type
    uuid ref_id
    text name
    boolean active
  }
  counterparties {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text name
    text tin
    text type
    text phone
    text address
    text contact_person
    jsonb bank_details
    text notes
    boolean active
  }
  finance_categories {
    uuid id PK
    uuid tenant_id FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text kind
    text group
    text key
    jsonb name
    boolean active
  }
  fx_rates {
    uuid tenant_id FK
    date date
    text currency
    numeric rate
  }
  grant_applications {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text title
    text program
    text kind
    numeric amount
    text status
    date submitted_on
    date decision_on
    text notes
  }
  loan_instalments {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid loan_id FK
    integer period
    date due_date
    numeric principal
    numeric interest
    numeric payment
    numeric balance
    date paid_date
    uuid transaction_id FK
  }
  loans {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid counterparty_id FK
    text name
    numeric principal
    numeric annual_rate
    integer term_months
    date start_date
    text method
    boolean preferential
    text terms
    text status
  }
  transactions {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    date date
    text type
    uuid category_id FK
    numeric amount
    text currency
    numeric fx_rate
    numeric amount_base
    text payment_method
    uuid account_id FK
    uuid to_account_id FK
    uuid counterparty_id FK
    uuid cost_center_id FK
    text cost_treatment
    text status
    text description
    date due_date
    uuid file_id FK
    text source_type
    uuid source_id
    uuid approved_by FK
    timestamp_with_time_zone approved_at
    text rejected_reason
  }
  accounts ||--o{ transactions : "account_id"
  accounts ||--o{ transactions : "to_account_id"
  cost_centers ||--o{ budgets : "cost_center_id"
  cost_centers ||--o{ transactions : "cost_center_id"
  counterparties ||--o{ contracts : "counterparty_id"
  counterparties ||--o{ loans : "counterparty_id"
  counterparties ||--o{ transactions : "counterparty_id"
  files ||--o{ contracts : "file_id"
  files ||--o{ transactions : "file_id"
  finance_categories ||--o{ budgets : "category_id"
  finance_categories ||--o{ transactions : "category_id"
  loans ||--o{ loan_instalments : "loan_id"
  transactions ||--o{ loan_instalments : "transaction_id"
```

## HR and payroll

```mermaid
erDiagram
  employees {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid user_id FK
    text full_name
    text position
    text division
    text phone
    text passport
    date hire_date
    date termination_date
    text pay_type
    numeric base_rate
    jsonb piece_rates
    uuid herd_id FK
    text status
    uuid contract_file_id FK
    date contract_end_date
    date medical_check_date
    text notes
  }
  kpi_rules {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text name
    text metric
    text position
    numeric threshold
    text reward_type
    numeric amount
    boolean active
  }
  payroll_advances {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid employee_id FK
    date date
    text month
    numeric amount
    uuid account_id FK
    uuid transaction_id FK
    text notes
  }
  payroll_lines {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid run_id FK
    uuid employee_id FK
    numeric days_worked
    numeric base
    numeric piecework
    numeric bonus
    numeric advance
    numeric deductions
    numeric net
    jsonb allocation
    jsonb overrides
    jsonb basis
  }
  payroll_runs {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text month
    text status
    numeric total_gross
    numeric total_net
    uuid prepared_by FK
    uuid approved_by FK
    timestamp_with_time_zone approved_at
    text returned_reason
    timestamp_with_time_zone paid_at
    uuid payment_transaction_id FK
    text notes
  }
  safety_instructions {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid employee_id FK
    text title
    date signed_on
    date valid_until
  }
  timesheets {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid employee_id FK
    date date
    text status
    timestamp_with_time_zone check_in
    timestamp_with_time_zone check_out
    numeric hours
    double_precision lat
    double_precision lng
    double_precision check_out_lat
    double_precision check_out_lng
    text notes
  }
  accounts ||--o{ payroll_advances : "account_id"
  employees ||--o{ payroll_advances : "employee_id"
  employees ||--o{ payroll_lines : "employee_id"
  employees ||--o{ safety_instructions : "employee_id"
  employees ||--o{ timesheets : "employee_id"
  files ||--o{ employees : "contract_file_id"
  herds ||--o{ employees : "herd_id"
  payroll_runs ||--o{ payroll_lines : "run_id"
  transactions ||--o{ payroll_advances : "transaction_id"
  transactions ||--o{ payroll_runs : "payment_transaction_id"
```

## Machinery

```mermaid
erDiagram
  asset_usage_logs {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid asset_id FK
    date date
    uuid operator_employee_id FK
    uuid field_id FK
    uuid operation_id
    text work_type
    numeric moto_hours
    numeric volume_ha
    numeric fuel_l
    uuid fuel_item_id FK
    uuid fuel_warehouse_id FK
    numeric fuel_cost
    uuid billed_transaction_id FK
    text notes
  }
  assets {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text name
    text type
    text inventory_no
    date purchase_date
    numeric purchase_price
    numeric purchase_amount
    text purchase_currency
    numeric purchase_fx_rate
    text status
    numeric useful_life_months
    numeric salvage_value
    text depreciation_method
    numeric total_units
    numeric opening_depreciation
    date opening_depreciation_date
    numeric moto_hours
    numeric fuel_norm_l_per_hour
    numeric fuel_norm_l_per_ha
    uuid cost_center_id
    boolean rented
    uuid rental_counterparty_id FK
    uuid rental_contract_id FK
    numeric rental_price
    text rental_unit
    text notes
  }
  depreciation_entries {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid asset_id FK
    text month
    numeric amount
    uuid transaction_id FK
  }
  maintenance_records {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid asset_id FK
    date date
    text type
    text description
    numeric cost
    date next_due_date
    numeric next_due_moto_hours
    numeric downtime_hours
    uuid transaction_id FK
  }
  assets ||--o{ asset_usage_logs : "asset_id"
  assets ||--o{ depreciation_entries : "asset_id"
  assets ||--o{ maintenance_records : "asset_id"
  contracts ||--o{ assets : "rental_contract_id"
  counterparties ||--o{ assets : "rental_counterparty_id"
  employees ||--o{ asset_usage_logs : "operator_employee_id"
  fields ||--o{ asset_usage_logs : "field_id"
  items ||--o{ asset_usage_logs : "fuel_item_id"
  transactions ||--o{ asset_usage_logs : "billed_transaction_id"
  transactions ||--o{ depreciation_entries : "transaction_id"
  transactions ||--o{ maintenance_records : "transaction_id"
  warehouses ||--o{ asset_usage_logs : "fuel_warehouse_id"
```

## Sales and purchasing

```mermaid
erDiagram
  prices {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid item_id FK
    date date
    numeric price
    text kind
    text source
  }
  purchase_requests {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid item_id FK
    numeric qty
    numeric expected_price
    uuid counterparty_id FK
    text status
    date needed_by
    uuid approved_by FK
    timestamp_with_time_zone approved_at
    text rejected_reason
    uuid transaction_id FK
    numeric paid_amount
    numeric unit_cost
    uuid warehouse_id FK
    numeric received_qty
    date received_on
    uuid batch_id FK
    text quality
    numeric diff_qty
    numeric diff_amount
    text notes
  }
  sale_lines {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid sale_id FK
    uuid item_id FK
    uuid warehouse_id FK
    uuid animal_id FK
    text description
    numeric qty
    text unit
    numeric price
    numeric amount
    numeric cost_amount
    uuid category_id FK
    uuid cost_center_id FK
    text previous_status
    uuid previous_herd_id
  }
  sales {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text number
    date date
    uuid counterparty_id FK
    text status
    numeric total_amount
    text currency
    numeric fx_rate
    date delivery_date
    date due_date
    text payment_method
    uuid account_id FK
    uuid transaction_id FK
    uuid confirmed_by FK
    timestamp_with_time_zone confirmed_at
    text rejected_reason
    uuid cancelled_by FK
    timestamp_with_time_zone cancelled_at
    text cancel_reason
    text notes
  }
  state_reports {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text title
    text authority
    text period
    date due_date
    text status
    date submitted_on
    uuid file_id FK
    text notes
  }
  accounts ||--o{ sales : "account_id"
  animals ||--o{ sale_lines : "animal_id"
  cost_centers ||--o{ sale_lines : "cost_center_id"
  counterparties ||--o{ purchase_requests : "counterparty_id"
  counterparties ||--o{ sales : "counterparty_id"
  files ||--o{ state_reports : "file_id"
  finance_categories ||--o{ sale_lines : "category_id"
  items ||--o{ prices : "item_id"
  items ||--o{ purchase_requests : "item_id"
  items ||--o{ sale_lines : "item_id"
  sales ||--o{ sale_lines : "sale_id"
  stock_batches ||--o{ purchase_requests : "batch_id"
  transactions ||--o{ purchase_requests : "transaction_id"
  transactions ||--o{ sales : "transaction_id"
  warehouses ||--o{ purchase_requests : "warehouse_id"
  warehouses ||--o{ sale_lines : "warehouse_id"
```

## Tasks, alerts, notifications

```mermaid
erDiagram
  alerts {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text source
    text rule_key
    text dedup_key
    text severity
    text status
    text title
    text body
    jsonb data
    text link
    text entity_type
    uuid entity_id
    timestamp_with_time_zone last_seen_at
    uuid acknowledged_by FK
    timestamp_with_time_zone acknowledged_at
    timestamp_with_time_zone resolved_at
    integer notify_count
    timestamp_with_time_zone next_notify_at
    timestamp_with_time_zone undelivered_since
    jsonb notify_roles
    text permission
  }
  calendar_events {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text title
    date date
    date end_date
    text kind
    uuid responsible_user_id FK
    text division
    text entity_type
    uuid entity_id
    text notes
  }
  job_runs {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text job
    timestamp_with_time_zone next_due_at
    timestamp_with_time_zone last_run_at
  }
  notification_prefs {
    uuid id PK
    uuid tenant_id FK
    uuid user_id FK
    text event_type
    jsonb channels
  }
  notifications {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid user_id FK
    text event_type
    text severity
    text title
    text body
    jsonb texts
    text link
    uuid alert_id
    text permission
    jsonb deliveries
    timestamp_with_time_zone read_at
    timestamp_with_time_zone created_at
  }
  tasks {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text title
    text description
    uuid assignee_user_id FK
    date due_date
    text priority
    text status
    text division
    text entity_type
    uuid entity_id
    text recurrence
    uuid template_id
    boolean requires_photo
    text requires_record
    timestamp_with_time_zone completed_at
    uuid completed_by FK
    text completion_note
    uuid completion_photo_file_id FK
    uuid completion_record_id
  }
  telegram_link_codes {
    text code PK
    uuid user_id FK
    timestamp_with_time_zone expires_at
    timestamp_with_time_zone used_at
  }
  files ||--o{ tasks : "completion_photo_file_id"
```

## Devices

```mermaid
erDiagram
  devices {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text type
    text name
    uuid facility_id FK
    double_precision lat
    double_precision lng
    text stream_url
    text onvif_url
    text stream_credentials
    text status
    timestamp_with_time_zone last_seen_at
    uuid api_key_id FK
    jsonb config
    text notes
  }
  webhook_deliveries {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid subscription_id FK
    uuid event_id
    text event_type
    jsonb payload
    text status
    integer attempts
    timestamp_with_time_zone next_attempt_at
    integer last_status_code
    text last_error
    timestamp_with_time_zone delivered_at
  }
  webhook_subscriptions {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text url
    text description
    jsonb event_types
    text secret
    boolean active
    uuid cursor
  }
  api_keys ||--o{ devices : "api_key_id"
  facilities ||--o{ devices : "facility_id"
  webhook_subscriptions ||--o{ webhook_deliveries : "subscription_id"
```

## AI

```mermaid
erDiagram
  ai_aliases {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text phrase
    text target_type
    uuid target_id
  }
  ai_conversations {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid user_id FK
    text title
    text channel
  }
  ai_insights {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text type
    text dedup_key
    text title
    text body
    real confidence
    jsonb sources
    jsonb data
    boolean contains_money
    text entity_type
    uuid entity_id
    date period_from
    date period_to
    text model
    text decision
    uuid decided_by FK
    timestamp_with_time_zone decided_at
    text decision_note
    text outcome
    timestamp_with_time_zone notified_at
  }
  ai_messages {
    uuid id PK
    uuid tenant_id FK
    uuid conversation_id FK
    text role
    jsonb content
    timestamp_with_time_zone created_at
  }
  ai_proposals {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid user_id FK
    uuid conversation_id FK
    text kind
    text status
    text channel
    text source_text
    jsonb fields
    jsonb warnings
    jsonb learn
    timestamp_with_time_zone expires_at
    timestamp_with_time_zone confirmed_at
    timestamp_with_time_zone undo_until
    text result_type
    uuid result_id
    text result_status
  }
  ai_conversations ||--o{ ai_messages : "conversation_id"
  ai_conversations ||--o{ ai_proposals : "conversation_id"
```

## Reports and import

```mermaid
erDiagram
  import_jobs {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text template
    text file_name
    text status
    text lang
    integer total_rows
    integer imported_rows
    jsonb summary
    jsonb errors
    jsonb warnings
    jsonb rows
  }
  saved_reports {
    uuid id PK
    uuid tenant_id FK
    uuid farm_id FK
    uuid created_by FK
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    text name
    text report_key
    jsonb config
    text schedule
    jsonb channels
    jsonb recipients
    timestamp_with_time_zone last_sent_at
  }
```
