import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calculateRouteWithTraffic,
  projectSegmentsOntoPolyline,
  segmentsFromTomTomRoute,
} from "./tomtom-routing.js";

test("segmentsFromTomTomRoute groups traffic sections by severity", () => {
  const route = {
    legs: [
      {
        points: [
          { latitude: 14.6, longitude: 121.0 },
          { latitude: 14.61, longitude: 121.01 },
          { latitude: 14.62, longitude: 121.02 },
          { latitude: 14.63, longitude: 121.03 },
        ],
      },
    ],
    sections: [
      {
        sectionType: "TRAFFIC",
        startPointIndex: 0,
        endPointIndex: 1,
        simpleCategory: "OTHER",
      },
      {
        sectionType: "TRAFFIC",
        startPointIndex: 2,
        endPointIndex: 3,
        simpleCategory: "JAM",
      },
    ],
    summary: { travelTimeInSeconds: 600, trafficDelayInSeconds: 120, lengthInMeters: 4000 },
  };

  const segments = segmentsFromTomTomRoute(route);
  assert.ok(segments.length >= 2);
  assert.equal(segments[0]?.level, "light");
  assert.equal(
    segments.some((s) => s.level === "heavy"),
    true,
  );
});

test("calculateRouteWithTraffic parses mocked TomTom HTTP", async () => {
  const mockBody = {
    routes: [
      {
        summary: {
          travelTimeInSeconds: 1800,
          trafficDelayInSeconds: 300,
          lengthInMeters: 12000,
        },
        legs: [
          {
            points: [
              { latitude: 14.6, longitude: 121.0 },
              { latitude: 14.65, longitude: 121.05 },
            ],
          },
        ],
        sections: [],
      },
    ],
  };

  const fetchFn = async () => new Response(JSON.stringify(mockBody), { status: 200 });

  const result = await calculateRouteWithTraffic({
    apiKey: "test-key",
    origin: { lat: 14.6, lng: 121.0 },
    dest: { lat: 14.65, lng: 121.05 },
    supportingPoints: [
      [121.0, 14.6],
      [121.05, 14.65],
    ],
    fetchFn,
  });

  assert.equal(result.etaSeconds, 1800);
  assert.equal(result.trafficDelaySeconds, 300);
  assert.equal(result.segments.length, 1);
});

test("projectSegmentsOntoPolyline maps levels onto target polyline", () => {
  const target: [number, number][] = [
    [121.0, 14.6],
    [121.02, 14.61],
    [121.04, 14.62],
  ];
  const projected = projectSegmentsOntoPolyline(target, [
    {
      coordinates: [
        [121.0, 14.6],
        [121.02, 14.61],
      ],
      level: "moderate",
    },
    {
      coordinates: [
        [121.02, 14.61],
        [121.04, 14.62],
      ],
      level: "heavy",
    },
  ]);
  assert.ok(projected.length >= 1);
  assert.ok(projected.every((s) => s.coordinates.length >= 2));
});
