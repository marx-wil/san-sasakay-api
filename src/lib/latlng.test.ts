import assert from "node:assert/strict";
import { test } from "node:test";
import { LATLNG_RE, parseLatLng } from "./latlng.js";

test("parseLatLng accepts canonical Metro Manila coordinates", () => {
  const got = parseLatLng("14.6566,121.0287");
  assert.deepEqual(got, { lat: 14.6566, lng: 121.0287 });
});

test("parseLatLng accepts negative values (southern + western hemispheres)", () => {
  const got = parseLatLng("-33.8688,-58.3816");
  assert.deepEqual(got, { lat: -33.8688, lng: -58.3816 });
});

test("parseLatLng accepts integer-only values", () => {
  const got = parseLatLng("14,121");
  assert.deepEqual(got, { lat: 14, lng: 121 });
});

test("parseLatLng rejects malformed strings", () => {
  for (const bad of [
    "",
    " ",
    "14.65",
    "14.65,",
    ",121",
    "14.65 121.02",
    "14.65;121.02",
    "lat,lng",
    "14.65, 121.02", // space after comma
  ]) {
    assert.throws(() => parseLatLng(bad), /invalid lat,lng/, `expected '${bad}' to throw`);
  }
});

test("parseLatLng rejects out-of-range coordinates", () => {
  assert.throws(() => parseLatLng("91,0"), /out of range/);
  assert.throws(() => parseLatLng("-91,0"), /out of range/);
  assert.throws(() => parseLatLng("0,181"), /out of range/);
  assert.throws(() => parseLatLng("0,-181"), /out of range/);
});

test("LATLNG_RE shape mirrors what the routes querystring schema validates", () => {
  // Sanity-check the regex used by both this helper and the zod schema
  // on the /routes endpoint stays in sync — drift here means the
  // querystring schema would accept inputs the parser rejects.
  assert.ok(LATLNG_RE.test("14.65,121.02"));
  assert.ok(LATLNG_RE.test("-14,-121"));
  assert.ok(!LATLNG_RE.test("14.65, 121.02"));
  assert.ok(!LATLNG_RE.test("14.65"));
});
