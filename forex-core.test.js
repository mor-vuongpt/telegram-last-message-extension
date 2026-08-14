"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

require("./forex-core.js");

const { analyzeForexMessage, normalizeForexSignal } = globalThis.ForexCore;

test("keeps immediate market signals when TP and SL are missing", () => {
  assert.deepEqual(
    normalizeForexSignal({
      has_signal: true,
      type: "buy now",
      entry: "9999",
      TP: "",
      SL: "",
    }),
    { type: "buy now", entry: "", TP: "", SL: "" }
  );

  assert.deepEqual(
    normalizeForexSignal({
      has_signal: false,
      type: "sell now",
      entry: "",
      TP: "4132",
      SL: "",
    }),
    { type: "sell now", entry: "", TP: "4132", SL: "" }
  );
});

test("keeps pending signals without TP or SL when entry exists", () => {
  for (const type of ["buy limit", "sell limit", "buy stop", "sell stop"]) {
    assert.deepEqual(
      normalizeForexSignal({
        has_signal: true,
        type,
        entry: "4347.135",
        TP: "",
        SL: "",
      }),
      { type, entry: "4347.135", TP: "", SL: "" }
    );
  }

  assert.deepEqual(
    normalizeForexSignal({
      has_signal: false,
      type: "sell limit",
      entry: "4400",
      TP: "wrong",
      SL: "wrong",
    }),
    { type: "sell limit", entry: "4400", TP: "", SL: "" }
  );
});

test("rejects pending signals when entry is missing", () => {
  for (const type of ["buy limit", "sell limit", "buy stop", "sell stop"]) {
    assert.deepEqual(
      normalizeForexSignal({
        has_signal: true,
        type,
        entry: "",
        TP: "4250",
        SL: "4350",
      }),
      {}
    );
  }
});

test("accepts an OpenAI structured market-now response with empty prices", async () => {
  const output = JSON.stringify({
    has_signal: true,
    type: "sell now",
    entry: "",
    TP: "",
    SL: "",
  });
  const mockFetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.model, "gpt-5.6-sol");
    assert.equal(request.text.format.strict, true);

    return {
      ok: true,
      status: 200,
      async json() {
        return { output_text: output };
      },
    };
  };

  assert.deepEqual(
    await analyzeForexMessage("XAUUSD SELL NOW", "test-key", mockFetch),
    { type: "sell now", entry: "", TP: "", SL: "" }
  );
});

test("accepts an OpenAI structured pending response with only entry", async () => {
  const output = JSON.stringify({
    has_signal: true,
    type: "sell limit",
    entry: "4156",
    TP: "",
    SL: "",
  });
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { output_text: output };
    },
  });

  assert.deepEqual(
    await analyzeForexMessage("XAUUSD SELL LIMIT 4156", "test-key", mockFetch),
    { type: "sell limit", entry: "4156", TP: "", SL: "" }
  );
});
