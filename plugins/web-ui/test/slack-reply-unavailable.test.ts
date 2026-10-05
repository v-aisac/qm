import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

test("unavailable Slack replies show one explanation without an unusable link prompt", async () => {
  let message = "This conversation has no valid Slack destination. Replies are unavailable.";
  const h = await harness({
    path: "/",
    api: (path) => (path.endsWith("/slack/reply-status") ? Response.json({ message }, { status: 400 }) : undefined),
  });
  try {
    h.releaseSessions();
    await h.boot();
    h.releaseTranscript();
    await h.openSession({
      id: "sample",
      threadRef: "dm:display-demo",
      scopeId: "personal:tester",
      type: "dm",
      createdAt: 1,
    });
    for (let i = 0; i < 100 && !document.querySelector("qm-slack-reply [role=alert]"); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const widget = document.querySelector("qm-slack-reply")!;
    assert.match(widget.textContent!, /no valid Slack destination/);
    assert.equal(widget.querySelector("qm-slack-account"), null);
    message = "App connections aren’t available for your account yet. Ask your administrator to enable them.";
    window.dispatchEvent(new window.Event("focus"));
    for (let i = 0; i < 100 && !widget.textContent!.includes("App connections"); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(widget.textContent!, /App connections/);
    assert.equal(widget.querySelectorAll("[role=alert]").length, 1);
    assert.equal(widget.querySelector("qm-slack-account"), null);
  } finally {
    await h.close();
  }
});
