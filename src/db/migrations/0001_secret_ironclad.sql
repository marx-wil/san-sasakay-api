CREATE TABLE IF NOT EXISTS "trip_feedback" (
	"id" uuid DEFAULT gen_random_uuid(),
	"client_uuid" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"trip_issue" text NOT NULL,
	"others_text" text,
	"trip_speed" text NOT NULL,
	"passenger_level" text NOT NULL,
	"location" "geography(Point,4326)" NOT NULL,
	"weight" real DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trip_feedback_id_created_at_pk" PRIMARY KEY("id","created_at"),
	CONSTRAINT "trip_feedback_user_client_uq" UNIQUE("user_id","client_uuid")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trip_feedback" ADD CONSTRAINT "trip_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trip_feedback" ADD CONSTRAINT "trip_feedback_route_id_transit_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."transit_routes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trip_feedback_route_time_idx" ON "trip_feedback" USING btree ("route_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trip_feedback_created_at_idx" ON "trip_feedback" USING btree ("created_at");