import assert from "node:assert/strict";
import { test } from "node:test";
import { LRUCache } from "./lru-cache.js";

test("LRUCache: set and get round-trips", () => {
  const c = new LRUCache<string, number>({ max: 3 });
  c.set("a", 1);
  c.set("b", 2);
  assert.equal(c.get("a"), 1);
  assert.equal(c.get("b"), 2);
  assert.equal(c.get("missing"), undefined);
});

test("LRUCache: evicts oldest entry when over capacity", () => {
  const c = new LRUCache<string, number>({ max: 2 });
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  assert.equal(c.get("a"), undefined, "oldest 'a' should be evicted");
  assert.equal(c.get("b"), 2);
  assert.equal(c.get("c"), 3);
});

test("LRUCache: get refreshes recency so old keys survive new inserts", () => {
  const c = new LRUCache<string, number>({ max: 2 });
  c.set("a", 1);
  c.set("b", 2);
  // Touch 'a' so it becomes the most-recent; 'b' is now the oldest.
  assert.equal(c.get("a"), 1);
  c.set("c", 3);
  assert.equal(c.get("a"), 1, "'a' should survive because it was just used");
  assert.equal(c.get("b"), undefined, "'b' should be evicted as the LRU");
  assert.equal(c.get("c"), 3);
});

test("LRUCache: re-setting a key updates the value without growing size", () => {
  const c = new LRUCache<string, number>({ max: 2 });
  c.set("a", 1);
  c.set("a", 99);
  assert.equal(c.size, 1);
  assert.equal(c.get("a"), 99);
});

test("LRUCache: TTL expires entries on read", async () => {
  const c = new LRUCache<string, number>({ max: 4, ttlMs: 20 });
  c.set("a", 1);
  assert.equal(c.get("a"), 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(c.get("a"), undefined, "entry should expire after TTL elapses");
  assert.equal(c.size, 0, "expired entry should be removed on access");
});

test("LRUCache: rejects non-positive max at construction", () => {
  assert.throws(() => new LRUCache({ max: 0 }), /max must be > 0/);
  assert.throws(() => new LRUCache({ max: -1 }), /max must be > 0/);
});

test("LRUCache: clear empties the cache", () => {
  const c = new LRUCache<string, number>({ max: 4 });
  c.set("a", 1);
  c.set("b", 2);
  c.clear();
  assert.equal(c.size, 0);
  assert.equal(c.get("a"), undefined);
});
