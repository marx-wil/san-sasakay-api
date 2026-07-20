CREATE TABLE IF NOT EXISTS "identity_proofs" (
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"identifier_hash" text NOT NULL,
	"encrypted_identifier" text,
	"is_primary" integer DEFAULT 1 NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_proofs_user_id_provider_identifier_hash_pk" PRIMARY KEY("user_id","provider","identifier_hash"),
	CONSTRAINT "identity_proofs_provider_hash_uq" UNIQUE("provider","identifier_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "magic_link_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"email_hash" text NOT NULL,
	"user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "points_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"delta" integer NOT NULL,
	"ref_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reports" (
	"id" uuid DEFAULT gen_random_uuid(),
	"client_uuid" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"status" text NOT NULL,
	"crowd_level" text,
	"location" "geography(Point,4326)" NOT NULL,
	"weight" real DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_id_created_at_pk" PRIMARY KEY("id","created_at"),
	CONSTRAINT "reports_user_client_uq" UNIQUE("user_id","client_uuid")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "route_status" (
	"route_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'hindi_alam' NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"report_count" integer DEFAULT 0 NOT NULL,
	"last_report_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"route_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"name" text NOT NULL,
	"location" "geography(Point,4326)" NOT NULL,
	CONSTRAINT "stops_route_seq_uq" UNIQUE("route_id","seq")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transit_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"geometry" "geography(LineString,4326)",
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transit_routes_code_uq" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_saved_routes" (
	"user_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_saved_routes_user_id_route_id_pk" PRIMARY KEY("user_id","route_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"first_name" text,
	"last_name" text,
	"display_name" text,
	"credibility_score" real DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"early_adopter_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "waitlist_signups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_hash" text NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_signups_email_hash_uq" UNIQUE("email_hash")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "identity_proofs" ADD CONSTRAINT "identity_proofs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "magic_link_tokens" ADD CONSTRAINT "magic_link_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "points_events" ADD CONSTRAINT "points_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reports" ADD CONSTRAINT "reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reports" ADD CONSTRAINT "reports_route_id_transit_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."transit_routes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "route_status" ADD CONSTRAINT "route_status_route_id_transit_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."transit_routes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stops" ADD CONSTRAINT "stops_route_id_transit_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."transit_routes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_saved_routes" ADD CONSTRAINT "user_saved_routes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_saved_routes" ADD CONSTRAINT "user_saved_routes_route_id_transit_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."transit_routes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_proofs_user_idx" ON "identity_proofs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "magic_link_tokens_expires_idx" ON "magic_link_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "magic_link_tokens_email_idx" ON "magic_link_tokens" USING btree ("email_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "points_events_user_time_idx" ON "points_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reports_route_time_idx" ON "reports" USING btree ("route_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reports_created_at_idx" ON "reports" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transit_routes_type_idx" ON "transit_routes" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_saved_routes_user_idx" ON "user_saved_routes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_created_at_idx" ON "users" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "waitlist_signups_created_at_idx" ON "waitlist_signups" USING btree ("created_at");