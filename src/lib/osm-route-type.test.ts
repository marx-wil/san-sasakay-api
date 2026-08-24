import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyStoredRoute, codePrefixFor, pickType } from "./osm-route-type.js";

test("pickType: share_taxi / UV Express name → uv_express", () => {
  assert.equal(pickType({ route: "share_taxi" }), "uv_express");
  assert.equal(pickType({ route: "share_taxi" }), "uv_express");
  assert.equal(pickType({ route: "bus", name: "Lawton–Paliparan Site UV Express" }), "uv_express");
});

test("pickType: Carousel in the name beats network=NCR bus", () => {
  assert.equal(
    pickType({
      route: "bus",
      network: "LTFRB National Capital Region",
      name: "Route 1: EDSA Carousel",
    }),
    "carousel",
  );
});

test("pickType: interregional / Region III networks", () => {
  assert.equal(
    pickType({ route: "bus", network: "LTFRB Interregional Bus", name: "PITX–Dagupan" }),
    "interregional_bus",
  );
  assert.equal(
    pickType({
      route: "bus",
      network: "LTFRB Inter-Regional Inter-Provincial Bus",
      name: "Manila–Tuguegarao City",
    }),
    "interregional_bus",
  );
  assert.equal(
    pickType({ route: "bus", network: "LTFRB Region III", name: "Cubao–San Miguel, Bulacan" }),
    "interregional_bus",
  );
});

test("pickType: PUB network or Bus in the name → p2p_bus", () => {
  assert.equal(
    pickType({ route: "bus", network: "LTFRB PUB", name: "Cubao–San Fernando, Pampanga" }),
    "p2p_bus",
  );
  assert.equal(
    pickType({
      route: "bus",
      network: "LTFRB National Capital Region",
      name: "BGC Bus N: North Route",
    }),
    "p2p_bus",
  );
});

test("pickType: PUJ and leftover NCR bus/minibus → jeepney", () => {
  assert.equal(
    pickType({ route: "bus", network: "LTFRB PUJ", name: "Jeepney Route 207" }),
    "jeepney",
  );
  assert.equal(
    pickType({
      route: "bus",
      network: "LTFRB National Capital Region",
      name: "Route 23: Alabang–Plaza Lawton",
    }),
    "jeepney",
  );
  assert.equal(pickType({ route: "minibus" }), "jeepney");
});

test("pickType: ignores trains and other modes", () => {
  assert.equal(pickType({ route: "subway", name: "LRT Line 1" }), null);
});

test("classifyStoredRoute reuses GeoJSON type as the route hint", () => {
  assert.equal(
    classifyStoredRoute({
      type: "jeepney",
      network: "LTFRB Interregional Bus",
      name: "PITX–Batangas City",
    }),
    "interregional_bus",
  );
  assert.equal(
    classifyStoredRoute({
      type: "uv_express",
      network: "LTFRB–National Capital Region",
      name: "Cubao–Calumpang",
    }),
    "uv_express",
  );
});

test("codePrefixFor keeps JEEP codes when type is refined", () => {
  assert.equal(codePrefixFor("jeepney"), "JEEP");
  assert.equal(codePrefixFor("carousel"), "JEEP");
  assert.equal(codePrefixFor("p2p_bus"), "JEEP");
  assert.equal(codePrefixFor("interregional_bus"), "JEEP");
  assert.equal(codePrefixFor("uv_express"), "UV");
});
