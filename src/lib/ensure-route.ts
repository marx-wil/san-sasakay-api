import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { transitRoutes } from "../db/schema.js";
import { NotFound } from "./errors.js";

/** Reject writes that reference a route id missing from transit_routes. */
export async function ensureTransitRouteExists(routeId: string): Promise<void> {
  const [row] = await db
    .select({ id: transitRoutes.id })
    .from(transitRoutes)
    .where(eq(transitRoutes.id, routeId))
    .limit(1);
  if (!row) {
    throw NotFound("ROUTE_NOT_FOUND", "Route does not exist");
  }
}
