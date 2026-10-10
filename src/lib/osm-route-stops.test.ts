import assert from "node:assert/strict";
import { test } from "node:test";

import { type OsmNodeForStop, extractRelationStops, isStopMemberRole } from "./osm-route-stops.js";

test("isStopMemberRole: stop and platform", () => {
  assert.equal(isStopMemberRole("stop"), true);
  assert.equal(isStopMemberRole("platform"), true);
  assert.equal(isStopMemberRole("forward:stop"), true);
  assert.equal(isStopMemberRole(""), false);
  assert.equal(isStopMemberRole("forward"), false);
});

test("extractRelationStops: member order and naming", () => {
  const nodes = new Map<number, OsmNodeForStop>([
    [1, { lng: 121.0, lat: 14.6, tags: { name: "Monumento" } }],
    [2, { lng: 121.01, lat: 14.61, tags: {} }],
  ]);
  const stops = extractRelationStops(
    [
      { type: "way", ref: 99, role: "" },
      { type: "node", ref: 1, role: "stop" },
      { type: "node", ref: 2, role: "platform" },
    ],
    nodes,
  );
  assert.equal(stops.length, 2);
  assert.equal(stops[0]?.name, "Monumento");
  assert.equal(stops[0]?.seq, 1);
  assert.equal(stops[1]?.name, "Stop 2");
});
