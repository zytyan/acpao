import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../packages/core/src/store.js";
test("event retention leaves readable messages and monotonic cursors", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.message("s", "assistant", "run", "durable conversation");
  const first = store.event("s", "acp.update", { raw: true })!;
  store.db.prepare("UPDATE events SET createdAt=0").run();
  store.prune();
  assert.equal(store.events("s").length, 0);
  assert.equal(store.cursor(), first);
  assert.equal(store.messages("s")[0]?.body, "durable conversation");
  assert.equal(store.get("setting", "pruned-through"), first);
  const next = store.event("s", "acp.update", {})!;
  assert.ok(next > first);
});
test("Gateway prunes only acknowledged journal prefix and preserves replay floor", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const first = store.event("s", "acp.update", {})!,
    second = store.event("s", "acp.update", {})!;
  store.db.prepare("UPDATE events SET createdAt=0").run();
  store.pruneJournal(first);
  assert.equal(store.get("setting", "journal-floor"), first);
  assert.deepEqual(
    store.events("s").map((e) => e.seq),
    [second],
  );
  assert.equal(store.cursor(), second);
});
