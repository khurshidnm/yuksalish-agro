ALTER TABLE "idempotency_keys" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "telegram_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "permission" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_telegram_membership_id_memberships_id_fk" FOREIGN KEY ("telegram_membership_id") REFERENCES "public"."memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_proposals" DROP COLUMN "needs_duplicate_confirmation";