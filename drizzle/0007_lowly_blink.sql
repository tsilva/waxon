CREATE TABLE "auth_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	CONSTRAINT "auth_accounts_provider_nonempty_check" CHECK (length(trim("auth_accounts"."provider")) > 0),
	CONSTRAINT "auth_accounts_provider_account_id_nonempty_check" CHECK (length(trim("auth_accounts"."provider_account_id")) > 0),
	CONSTRAINT "auth_accounts_created_at_check" CHECK ("auth_accounts"."created_at" >= 0),
	CONSTRAINT "auth_accounts_updated_at_check" CHECK ("auth_accounts"."updated_at" >= "auth_accounts"."created_at")
);
--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_accounts_provider_account_idx" ON "auth_accounts" USING btree ("provider","provider_account_id");--> statement-breakpoint
CREATE INDEX "auth_accounts_user_id_idx" ON "auth_accounts" USING btree ("user_id");