importScripts("forex-core.js");

const {
  API_KEY_STORAGE_KEY,
  WEBHOOK_URL_STORAGE_KEY,
  WEBHOOK_TOKEN_STORAGE_KEY,
  AUTO_TRADE_ENABLED_STORAGE_KEY,
  AUTO_TRADE_TAB_ID_STORAGE_KEY,
  AUTO_TRADE_STATUS_STORAGE_KEY,
  AUTO_LAST_FINGERPRINT_STORAGE_KEY,
  LAST_CAPTURED_MESSAGE_STORAGE_KEY,
  analyzeForexMessage,
  normalizeWebhookConfiguration,
  sendSignalToWebhook,
} = ForexCore;

let automaticMessageProcessing = false;

function isTelegramUrl(url) {
  return typeof url === "string" && url.startsWith("https://web.telegram.org/");
}

async function setAutomaticStatus(state, message, extra = {}) {
  const status = {
    state,
    message,
    updatedAt: new Date().toISOString(),
    ...extra,
  };
  await chrome.storage.local.set({ [AUTO_TRADE_STATUS_STORAGE_KEY]: status });
  return status;
}

async function getAutomaticSettings() {
  const saved = await chrome.storage.local.get([
    API_KEY_STORAGE_KEY,
    WEBHOOK_URL_STORAGE_KEY,
    WEBHOOK_TOKEN_STORAGE_KEY,
    AUTO_TRADE_ENABLED_STORAGE_KEY,
    AUTO_TRADE_TAB_ID_STORAGE_KEY,
    AUTO_LAST_FINGERPRINT_STORAGE_KEY,
  ]);
  const apiKey = String(saved[API_KEY_STORAGE_KEY] || "").trim();
  if (!apiKey) {
    throw new Error("Chưa có OpenAI API key cho chế độ tự động.");
  }

  const webhook = normalizeWebhookConfiguration(
    saved[WEBHOOK_URL_STORAGE_KEY],
    saved[WEBHOOK_TOKEN_STORAGE_KEY]
  );

  return {
    apiKey,
    webhook,
    enabled: Boolean(saved[AUTO_TRADE_ENABLED_STORAGE_KEY]),
    tabId: saved[AUTO_TRADE_TAB_ID_STORAGE_KEY],
    lastFingerprint: saved[AUTO_LAST_FINGERPRINT_STORAGE_KEY] || "",
  };
}

async function sendMonitorCommand(tabId, enabled) {
  const message = { type: "SET_TELEGRAM_AUTO_MONITOR", enabled };

  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(error?.message || "")) {
      throw error;
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-script.js"],
    });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function setAutomaticTrading(enabled, requestedTabId) {
  const saved = await chrome.storage.local.get(AUTO_TRADE_TAB_ID_STORAGE_KEY);
  const previousTabId = saved[AUTO_TRADE_TAB_ID_STORAGE_KEY];

  if (!enabled) {
    await chrome.storage.local.set({
      [AUTO_TRADE_ENABLED_STORAGE_KEY]: false,
      [AUTO_TRADE_TAB_ID_STORAGE_KEY]: null,
      [AUTO_LAST_FINGERPRINT_STORAGE_KEY]: "",
    });
    if (Number.isInteger(previousTabId)) {
      await sendMonitorCommand(previousTabId, false).catch(() => {});
    }
    return setAutomaticStatus("stopped", "Tự động hóa đang tắt.");
  }

  await getAutomaticSettings();
  const tab = await chrome.tabs.get(requestedTabId);
  if (!tab?.id || !isTelegramUrl(tab.url)) {
    throw new Error("Hãy mở đúng tab Telegram Web cần theo dõi trước khi bật tự động.");
  }

  if (Number.isInteger(previousTabId) && previousTabId !== tab.id) {
    await sendMonitorCommand(previousTabId, false).catch(() => {});
  }

  await chrome.storage.local.set({
    [AUTO_TRADE_ENABLED_STORAGE_KEY]: true,
    [AUTO_TRADE_TAB_ID_STORAGE_KEY]: tab.id,
    [AUTO_LAST_FINGERPRINT_STORAGE_KEY]: "",
  });
  try {
    const monitor = await sendMonitorCommand(tab.id, true);
    if (!monitor?.ok) {
      throw new Error(
        monitor?.error || "Không thể khởi động theo dõi trong tab Telegram."
      );
    }
  } catch (error) {
    await chrome.storage.local.set({
      [AUTO_TRADE_ENABLED_STORAGE_KEY]: false,
      [AUTO_TRADE_TAB_ID_STORAGE_KEY]: null,
      [AUTO_LAST_FINGERPRINT_STORAGE_KEY]: "",
    });
    throw error;
  }
  return setAutomaticStatus(
    "monitoring",
    "Đang theo dõi tin nhắn text mới trong tab Telegram đã chọn."
  );
}

async function createIdempotencyKey(fingerprint) {
  const bytes = new TextEncoder().encode(fingerprint);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `telegram-${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

async function processAutomaticMessage(request, sender) {
  if (!sender.tab?.id || !isTelegramUrl(sender.tab.url)) {
    throw new Error("Nguồn tin nhắn không phải Telegram Web.");
  }
  if (automaticMessageProcessing) {
    throw new Error("Một tin nhắn khác đang được phân tích; hãy chờ hoàn tất.");
  }

  const settings = await getAutomaticSettings();
  if (!settings.enabled || settings.tabId !== sender.tab.id) {
    return { ok: false, ignored: true, error: "Tab này không được bật theo dõi." };
  }

  const text = String(request.text || "").trim();
  const fingerprint = String(request.fingerprint || "").slice(0, 1000);
  if (!text || text.length > 20_000 || !fingerprint) {
    throw new Error("Tin nhắn tự động không hợp lệ.");
  }
  if (fingerprint === settings.lastFingerprint) {
    return { ok: true, duplicate: true };
  }

  automaticMessageProcessing = true;
  const startedAt = performance.now();
  try {
    await chrome.storage.local.set({
      [LAST_CAPTURED_MESSAGE_STORAGE_KEY]: text,
    });
    await setAutomaticStatus("processing", "Đang phân tích tin nhắn mới bằng GPT-5.6 Sol…", {
      preview: text.slice(0, 160),
    });
    const signal = await analyzeForexMessage(text, settings.apiKey);
    const elapsedSeconds = (performance.now() - startedAt) / 1000;

    if (!Object.keys(signal).length) {
      await chrome.storage.local.set({
        [AUTO_LAST_FINGERPRINT_STORAGE_KEY]: fingerprint,
      });
      await setAutomaticStatus(
        "ignored",
        "Tin nhắn mới không có tín hiệu Forex hoàn chỉnh nên không gửi MT5.",
        { elapsedSeconds, preview: text.slice(0, 160), signal: {} }
      );
      return { ok: true, ignored: true, signal: {} };
    }

    const idempotencyKey = await createIdempotencyKey(fingerprint);
    const delivered = await sendSignalToWebhook(
      signal,
      idempotencyKey,
      settings.webhook
    );
    await chrome.storage.local.set({
      [AUTO_LAST_FINGERPRINT_STORAGE_KEY]: fingerprint,
    });
    await setAutomaticStatus(
      "sent",
      delivered.duplicate
        ? `Signal ${delivered.id} đã tồn tại, không gửi trùng.`
        : `Đã tự động gửi signal ${delivered.id} sang MT5.`,
      {
        elapsedSeconds,
        preview: text.slice(0, 160),
        signal,
        signalId: delivered.id,
      }
    );
    return { ok: true, signal, delivered };
  } catch (error) {
    await setAutomaticStatus("error", error.message || "Tự động hóa gặp lỗi.", {
      elapsedSeconds: (performance.now() - startedAt) / 1000,
      preview: text.slice(0, 160),
    });
    throw error;
  } finally {
    automaticMessageProcessing = false;
  }
}

async function handleMonitorReady(sender) {
  if (!sender.tab?.id || !isTelegramUrl(sender.tab.url)) {
    return { enabled: false };
  }

  const saved = await chrome.storage.local.get([
    AUTO_TRADE_ENABLED_STORAGE_KEY,
    AUTO_TRADE_TAB_ID_STORAGE_KEY,
  ]);
  if (!saved[AUTO_TRADE_ENABLED_STORAGE_KEY]) {
    return { enabled: false };
  }

  let monitoredTabId = saved[AUTO_TRADE_TAB_ID_STORAGE_KEY];
  if (monitoredTabId !== sender.tab.id) {
    let oldTabExists = false;
    if (Number.isInteger(monitoredTabId)) {
      oldTabExists = await chrome.tabs.get(monitoredTabId).then(
        (tab) => Boolean(tab?.id && isTelegramUrl(tab.url)),
        () => false
      );
    }
    if (oldTabExists) {
      return { enabled: false };
    }

    monitoredTabId = sender.tab.id;
    await chrome.storage.local.set({
      [AUTO_TRADE_TAB_ID_STORAGE_KEY]: monitoredTabId,
      [AUTO_LAST_FINGERPRINT_STORAGE_KEY]: "",
    });
    await setAutomaticStatus(
      "monitoring",
      "Đã khôi phục theo dõi tự động sau khi Telegram tải lại."
    );
  }

  return { enabled: true };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  let operation;

  if (request?.type === "SET_AUTO_TRADING") {
    operation = setAutomaticTrading(Boolean(request.enabled), request.tabId);
  } else if (request?.type === "GET_AUTO_TRADING_STATUS") {
    operation = chrome.storage.local.get([
      AUTO_TRADE_ENABLED_STORAGE_KEY,
      AUTO_TRADE_TAB_ID_STORAGE_KEY,
      AUTO_TRADE_STATUS_STORAGE_KEY,
    ]).then((saved) => ({
      enabled: Boolean(saved[AUTO_TRADE_ENABLED_STORAGE_KEY]),
      tabId: saved[AUTO_TRADE_TAB_ID_STORAGE_KEY],
      status: saved[AUTO_TRADE_STATUS_STORAGE_KEY] || null,
    }));
  } else if (request?.type === "TELEGRAM_MONITOR_READY") {
    operation = handleMonitorReady(sender);
  } else if (request?.type === "TELEGRAM_NEW_TEXT_MESSAGE") {
    operation = processAutomaticMessage(request, sender);
  } else {
    return false;
  }

  operation.then(
    (value) => sendResponse({ ok: true, ...value }),
    (error) => sendResponse({ ok: false, error: error.message || "Đã xảy ra lỗi." })
  );
  return true;
});
