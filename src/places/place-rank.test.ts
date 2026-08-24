import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyPlaceKind,
  placeSubtitle,
  rankPlaces,
  type RankablePlace,
} from "./place-rank.js";

test("classifyPlaceKind maps OSM class/type to commute kinds", () => {
  assert.equal(classifyPlaceKind("shop", "mall"), "mall");
  assert.equal(classifyPlaceKind("highway", "bus_stop"), "bus_stop");
  assert.equal(classifyPlaceKind("public_transport", "platform"), "bus_stop");
  assert.equal(classifyPlaceKind("railway", "station"), "station");
  assert.equal(classifyPlaceKind("highway", "residential"), "street");
  assert.equal(classifyPlaceKind("building", "yes"), "building");
  assert.equal(classifyPlaceKind("place", "suburb"), "place");
});

test("placeSubtitle strips the title and trailing country / Metro Manila", () => {
  assert.equal(
    placeSubtitle(
      "One Ayala",
      "One Ayala, EDSA Busway, San Lorenzo, Makati, Metro Manila, Philippines",
    ),
    "EDSA Busway, San Lorenzo, Makati",
  );
});

test("rankPlaces collapses clones of the same kind within 80m", () => {
  const hits: RankablePlace[] = [
    {
      id: "N1",
      name: "One Ayala",
      displayName: "One Ayala, Ayala Avenue, Makati, Metro Manila, Philippines",
      lat: 14.5494,
      lng: 121.0273,
      osmClass: "shop",
      osmType: "mall",
    },
    {
      id: "W2",
      name: "One Ayala",
      displayName: "One Ayala, 1, San Lorenzo, Makati, Metro Manila, Philippines",
      lat: 14.5495,
      lng: 121.0274,
      osmClass: "shop",
      osmType: "mall",
    },
  ];
  const out = rankPlaces(hits, 8);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.id, "N1");
  assert.equal(out[0]?.kind, "mall");
});

test("rankPlaces keeps mall and bus stop variants of the same name", () => {
  const hits: RankablePlace[] = [
    {
      id: "N1",
      name: "One Ayala",
      displayName: "One Ayala, Ayala Avenue, Makati, Metro Manila, Philippines",
      lat: 14.5494,
      lng: 121.0273,
      osmClass: "shop",
      osmType: "mall",
    },
    {
      id: "N2",
      name: "One Ayala",
      displayName: "One Ayala, EDSA Busway, San Lorenzo, Makati, Metro Manila, Philippines",
      lat: 14.5496,
      lng: 121.0275,
      osmClass: "highway",
      osmType: "bus_stop",
    },
    {
      id: "W3",
      name: "One Ayala",
      displayName: "One Ayala, Ayala Avenue, San Lorenzo, Makati, Metro Manila, Philippines",
      lat: 14.5493,
      lng: 121.028,
      osmClass: "highway",
      osmType: "primary",
    },
  ];
  const out = rankPlaces(hits, 8);
  assert.equal(out.length, 3);
  assert.deepEqual(
    out.map((p) => p.kind),
    ["mall", "bus_stop", "street"],
  );
  assert.equal(out[1]?.subtitle, "EDSA Busway, San Lorenzo, Makati");
});
