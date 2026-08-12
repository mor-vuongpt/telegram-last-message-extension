"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  createSignalStore,
  createWebhookServer,
  validateSignal,
} = require("./server");

const TOKEN = "test-token-at-least-16-characters";

test("validates market and pending signals", () => {
  assert.deepEqual(
    validateSignal({ type: "sell now", entry: "", TP: "4132", SL: "4160" }),
    { signal: { type: "sell now", entry: "", TP: "4132", SL: "4160" } }
  );
  assert.deepEqual(
    validateSignal({ type: "buy stop", entry: "4347.135", TP: "4391.323", SL: "4345.460" }),
    {
      signal: {
        type: "buy stop",
        entry: "4347.135",
        TP: "4391.323",
        SL: "4345.460",
      },
    }
  );
  assert.match(validateSignal({}).error, /type/);
});

test("queues, leases and acknowledges a signal over HTTP", async (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mt5-webhook-"));
  context.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

  const store = createSignalStore(path.join(temporaryDirectory, "signals.json"));
  const server = createWebhookServer({ token: TOKEN, store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
  };

  const unauthorized = await fetch(`${baseUrl}/api/signals`);
  assert.equal(unauthorized.status, 401);

  const createResponse = await fetch(`${baseUrl}/api/signals`, {
    method: "POST",
    headers: { ...headers, "Idempotency-Key": "test-request" },
    body: JSON.stringify({
      type: "sell limit",
      entry: "4156",
      TP: "4132",
      SL: "4160",
    }),
  });
  assert.equal(createResponse.status, 202);
  const created = await createResponse.json();
  assert.equal(created.ok, true);

  const duplicateResponse = await fetch(`${baseUrl}/api/signals`, {
    method: "POST",
    headers: { ...headers, "Idempotency-Key": "test-request" },
    body: JSON.stringify({
      type: "sell limit",
      entry: "4156",
      TP: "4132",
      SL: "4160",
    }),
  });
  assert.equal(duplicateResponse.status, 200);
  assert.equal((await duplicateResponse.json()).id, created.id);

  const nextResponse = await fetch(
    `${baseUrl}/api/signals/next?terminal_id=mt5-test`,
    { headers }
  );
  assert.deepEqual(await nextResponse.json(), {
    id: created.id,
    type: "sell limit",
    entry: "4156",
    TP: "4132",
    SL: "4160",
  });

  const ackResponse = await fetch(
    `${baseUrl}/api/signals/${created.id}/ack`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        terminal_id: "mt5-test",
        status: "dry_run",
        detail: "test only",
      }),
    }
  );
  assert.equal(ackResponse.status, 200);

  const emptyResponse = await fetch(
    `${baseUrl}/api/signals/next?terminal_id=mt5-test`,
    { headers }
  );
  assert.deepEqual(await emptyResponse.json(), {});
});
