import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./deep-link-boot-fixture.ts";

test("legacy and named webhook chats have webhook labels and icons", async () => {
  const h = await harness({
    path: "/",
    listSessions: [
      {
        id: "legacy-hook",
        threadRef: "webhook:hook:old",
        scopeId: "personal:tester",
        type: "dm",
        createdAt: Date.now(),
        title: null,
      },
      {
        id: "named-hook",
        threadRef: "webhook:hook:new",
        scopeId: "personal:tester",
        type: "dm",
        createdAt: Date.now(),
        title: "Review deployments",
      },
    ],
  });
  try {
    h.releaseSessions();
    await h.boot();
    h.setWebOnly(false);
    await h.refreshSessions();
    h.releaseTranscript();
    await h.openSession({
      id: "legacy-hook",
      threadRef: "webhook:hook:old",
      scopeId: "personal:tester",
      type: "dm",
      createdAt: Date.now(),
      title: null,
    });
    assert.match(document.body.textContent ?? "", /Webhook run/);
    assert.ok(document.querySelector('[aria-label="Webhook run"]'));
    assert.match(document.body.textContent ?? "", /Review deployments/);
  } finally {
    await h.close();
  }
});
