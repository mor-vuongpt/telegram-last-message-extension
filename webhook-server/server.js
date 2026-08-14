"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const ALLOWED_TYPES = new Set([
  "buy",
  "sell",
  "buy now",
  "sell now",
  "buy limit",
  "sell limit",
  "buy stop",
  "sell stop",
]);
const MARKET_TYPES = new Set(["buy now", "sell now"]);
const PENDING_TYPES = new Set([
  "buy limit",
  "sell limit",
  "buy stop",
  "sell stop",
]);
const ACK_STATUSES = new Set([
  "executed",
  "dry_run",
  "rejected",
  "duplicate",
]);
const MAX_BODY_BYTES = 16 * 1024;
const MAX_SIGNALS = 500;

function normalizePrice(value) {
  const price = String(value ?? "").trim();
  return /^\d+(?:\.\d+)?$/.test(price) && Number(price) > 0 ? price : "";
}

function validateSignal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "Body phải là một JSON object." };
  }

  const type = String(value.type ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  const entry = String(value.entry ?? "").trim();
  const rawTP = String(value.TP ?? "").trim();
  const rawSL = String(value.SL ?? "").trim();
  const TP = normalizePrice(rawTP);
  const SL = normalizePrice(rawSL);

  if (!ALLOWED_TYPES.has(type)) {
    return { error: "type không hợp lệ." };
  }
  if (rawTP !== "" && !TP) {
    return { error: "TP phải để trống hoặc là giá dương hợp lệ." };
  }
  if (rawSL !== "" && !SL) {
    return { error: "SL phải để trống hoặc là giá dương hợp lệ." };
  }

  if (MARKET_TYPES.has(type)) {
    if (entry !== "") {
      return { error: `${type} phải có entry rỗng.` };
    }
    return { signal: { type, entry: "", TP, SL } };
  }

  if (!PENDING_TYPES.has(type) && !SL) {
    return { error: `${type} phải có SL hợp lệ.` };
  }

  const normalizedEntry = normalizePrice(entry);
  if (!normalizedEntry) {
    return { error: `${type} phải có entry hợp lệ.` };
  }

  return { signal: { type, entry: normalizedEntry, TP, SL } };
}

function safeEqual(first, second) {
  const firstBuffer = Buffer.from(first);
  const secondBuffer = Buffer.from(second);
  return (
    firstBuffer.length === secondBuffer.length &&
    crypto.timingSafeEqual(firstBuffer, secondBuffer)
  );
}

function createSignalStore(filePath, leaseMs = 30_000) {
  let state = { signals: [] };

  function load() {
    try {
      const loaded = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (Array.isArray(loaded?.signals)) {
        state = { signals: loaded.signals };
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  function save() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2));
    fs.renameSync(temporaryPath, filePath);
  }

  function enqueue(signal, idempotencyKey = "") {
    if (idempotencyKey) {
      const existing = state.signals.find(
        (item) => item.idempotencyKey === idempotencyKey
      );
      if (existing) {
        return { item: existing, duplicate: true };
      }
    }

    const now = new Date().toISOString();
    const item = {
      id: crypto.randomUUID(),
      ...signal,
      status: "pending",
      idempotencyKey,
      createdAt: now,
      leasedTo: "",
      leaseExpiresAt: 0,
      acknowledgement: null,
    };
    state.signals.push(item);

    if (state.signals.length > MAX_SIGNALS) {
      const removableIndex = state.signals.findIndex(
        (candidate) => candidate.status === "acknowledged"
      );
      state.signals.splice(removableIndex >= 0 ? removableIndex : 0, 1);
    }

    save();
    return { item, duplicate: false };
  }

  function leaseNext(terminalId) {
    const now = Date.now();
    const item = state.signals.find(
      (candidate) =>
        candidate.status === "pending" ||
        (candidate.status === "leased" &&
          (candidate.leasedTo === terminalId || candidate.leaseExpiresAt <= now))
    );

    if (!item) {
      return null;
    }

    item.status = "leased";
    item.leasedTo = terminalId;
    item.leaseExpiresAt = now + leaseMs;
    save();
    return item;
  }

  function acknowledge(id, terminalId, acknowledgement) {
    const item = state.signals.find((candidate) => candidate.id === id);
    if (!item) {
      return { error: "Không tìm thấy signal ID.", statusCode: 404 };
    }
    if (item.status === "acknowledged") {
      return { item, duplicate: true };
    }
    if (item.leasedTo && item.leasedTo !== terminalId) {
      return { error: "Signal đang được xử lý bởi terminal khác.", statusCode: 409 };
    }

    item.status = "acknowledged";
    item.leaseExpiresAt = 0;
    item.acknowledgement = {
      ...acknowledgement,
      terminalId,
      acknowledgedAt: new Date().toISOString(),
    };
    save();
    return { item, duplicate: false };
  }

  function list() {
    return [...state.signals].reverse();
  }

  load();
  return { enqueue, leaseNext, acknowledge, list };
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error("Request body quá lớn.");
        error.statusCode = 413;
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch {
        const error = new Error("Request body không phải JSON hợp lệ.");
        error.statusCode = 400;
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function createWebhookServer({ token, store }) {
  if (typeof token !== "string" || token.length < 16) {
    throw new Error("WEBHOOK_TOKEN phải có ít nhất 16 ký tự.");
  }

  return http.createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, Idempotency-Key"
    );
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Cache-Control", "no-store");

    const sendJson = (statusCode, payload) => {
      response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(payload));
    };

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(200, { ok: true });
      return;
    }

    const authorization = request.headers.authorization || "";
    if (!safeEqual(authorization, `Bearer ${token}`)) {
      sendJson(401, { ok: false, error: "Webhook token không hợp lệ." });
      return;
    }

    try {
      if (request.method === "POST" && url.pathname === "/api/signals") {
        const body = await readJsonBody(request);
        const validation = validateSignal(body);
        if (validation.error) {
          sendJson(400, { ok: false, error: validation.error });
          return;
        }

        const idempotencyKey = String(
          request.headers["idempotency-key"] || ""
        ).slice(0, 128);
        const queued = store.enqueue(validation.signal, idempotencyKey);
        sendJson(queued.duplicate ? 200 : 202, {
          ok: true,
          id: queued.item.id,
          duplicate: queued.duplicate,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/signals/next") {
        const terminalId = url.searchParams.get("terminal_id") || "";
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(terminalId)) {
          sendJson(400, { ok: false, error: "terminal_id không hợp lệ." });
          return;
        }

        const item = store.leaseNext(terminalId);
        sendJson(
          200,
          item
            ? {
                id: item.id,
                type: item.type,
                entry: item.entry,
                TP: item.TP,
                SL: item.SL,
              }
            : {}
        );
        return;
      }

      const acknowledgementMatch = url.pathname.match(
        /^\/api\/signals\/([0-9a-f-]+)\/ack$/i
      );
      if (request.method === "POST" && acknowledgementMatch) {
        const body = await readJsonBody(request);
        const terminalId = String(body.terminal_id || "");
        const status = String(body.status || "");
        const detail = String(body.detail || "").slice(0, 500);

        if (!/^[A-Za-z0-9_-]{1,64}$/.test(terminalId)) {
          sendJson(400, { ok: false, error: "terminal_id không hợp lệ." });
          return;
        }
        if (!ACK_STATUSES.has(status)) {
          sendJson(400, { ok: false, error: "Trạng thái ACK không hợp lệ." });
          return;
        }

        const acknowledged = store.acknowledge(
          acknowledgementMatch[1],
          terminalId,
          { status, detail }
        );
        if (acknowledged.error) {
          sendJson(acknowledged.statusCode, {
            ok: false,
            error: acknowledged.error,
          });
          return;
        }

        sendJson(200, { ok: true, duplicate: acknowledged.duplicate });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/signals") {
        sendJson(200, { ok: true, signals: store.list() });
        return;
      }

      sendJson(404, { ok: false, error: "Endpoint không tồn tại." });
    } catch (error) {
      sendJson(error.statusCode || 500, {
        ok: false,
        error: error.statusCode ? error.message : "Lỗi nội bộ webhook server.",
      });
      if (!error.statusCode) {
        console.error(error);
      }
    }
  });
}

function startFromEnvironment() {
  const host = process.env.WEBHOOK_HOST || "127.0.0.1";
  const port = Number.parseInt(process.env.WEBHOOK_PORT || "8787", 10);
  const token = process.env.WEBHOOK_TOKEN || "";
  const filePath = path.join(__dirname, "data", "signals.json");
  const store = createSignalStore(filePath);
  const server = createWebhookServer({ token, store });

  server.listen(port, host, () => {
    console.log(`MT5 webhook đang chạy tại http://${host}:${port}`);
    console.log("Không chia sẻ WEBHOOK_TOKEN và không mở port ra Internet khi chưa có HTTPS.");
  });
}

if (require.main === module) {
  try {
    startFromEnvironment();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = {
  createSignalStore,
  createWebhookServer,
  validateSignal,
};
