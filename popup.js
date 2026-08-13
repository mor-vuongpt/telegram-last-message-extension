const {
  API_KEY_STORAGE_KEY,
  WEBHOOK_URL_STORAGE_KEY,
  WEBHOOK_TOKEN_STORAGE_KEY,
  AUTO_TRADE_ENABLED_STORAGE_KEY,
  AUTO_TRADE_STATUS_STORAGE_KEY,
  LAST_CAPTURED_MESSAGE_STORAGE_KEY,
  DEFAULT_WEBHOOK_URL,
  analyzeForexMessage,
  normalizeWebhookConfiguration,
  sendSignalToWebhook,
} = ForexCore;

const getMessageButton = document.querySelector("#getMessageButton");
const copyButton = document.querySelector("#copyButton");
const result = document.querySelector("#result");
const analysisResult = document.querySelector("#analysisResult");
const apiKeyInput = document.querySelector("#openaiApiKey");
const elapsedTime = document.querySelector("#elapsedTime");
const capturedMessage = document.querySelector("#capturedMessage");
const webhookUrlInput = document.querySelector("#webhookUrl");
const webhookTokenInput = document.querySelector("#webhookToken");
const autoSendWebhookInput = document.querySelector("#autoSendWebhook");
const sendWebhookButton = document.querySelector("#sendWebhookButton");
const webhookStatus = document.querySelector("#webhookStatus");
const automationPanel = document.querySelector("#automationPanel");
const automationTitle = document.querySelector("#automationTitle");
const automationStatus = document.querySelector("#automationStatus");
const status = document.querySelector("#status");

let currentSignal = null;
let currentSignalIdempotencyKey = "";

function setStatus(text, type = "") {
  status.textContent = text;
  status.className = `status ${type}`.trim();
}

function setWebhookStatus(text, type = "") {
  webhookStatus.textContent = text;
  webhookStatus.className = `webhook-status ${type}`.trim();
  webhookStatus.hidden = !text;
}

function setLoading(isLoading) {
  getMessageButton.disabled = isLoading;
  apiKeyInput.disabled = isLoading;
  sendWebhookButton.disabled = isLoading || !currentSignal;
  getMessageButton.textContent = isLoading
    ? "Đang phân tích…"
    : "Lấy và phân tích tin nhắn";
}

function startElapsedTimer(startedAt) {
  let stopped = false;
  const render = () => {
    const elapsedSeconds = (performance.now() - startedAt) / 1000;
    elapsedTime.textContent = `Thời gian xử lý: ${elapsedSeconds.toFixed(2)} giây`;
  };
  const timerId = setInterval(render, 50);

  render();
  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timerId);
    render();
  };
}

function renderAutomationStatus(enabled, automaticStatus = null) {
  const state = automaticStatus?.state || (enabled ? "monitoring" : "stopped");
  const labels = {
    stopped: "Tự động hóa đang tắt",
    monitoring: "Đang theo dõi tự động",
    processing: "Đang phân tích tin nhắn mới",
    sent: "Đã gửi tín hiệu sang MT5",
    ignored: "Đã bỏ qua tin không đủ dữ liệu",
    error: "Tự động hóa gặp lỗi",
  };
  automationTitle.textContent = labels[state] || labels.monitoring;
  const message =
    automaticStatus?.message ||
    (enabled
      ? "Đang chờ tin nhắn text mới trong tab Telegram đã chọn."
      : "Bật tùy chọn trên tại đúng tab Telegram cần theo dõi.");
  const elapsedSeconds = Number(automaticStatus?.elapsedSeconds);
  automationStatus.textContent = Number.isFinite(elapsedSeconds)
    ? `${message} Thời gian xử lý: ${elapsedSeconds.toFixed(2)} giây.`
    : message;
  automationPanel.className = `automation-panel ${state}`;
  autoSendWebhookInput.checked = enabled;
}

async function loadSettings() {
  const saved = await chrome.storage.local.get([
    API_KEY_STORAGE_KEY,
    WEBHOOK_URL_STORAGE_KEY,
    WEBHOOK_TOKEN_STORAGE_KEY,
    AUTO_TRADE_ENABLED_STORAGE_KEY,
    AUTO_TRADE_STATUS_STORAGE_KEY,
    LAST_CAPTURED_MESSAGE_STORAGE_KEY,
  ]);
  apiKeyInput.value = saved[API_KEY_STORAGE_KEY] || "";
  webhookUrlInput.value = saved[WEBHOOK_URL_STORAGE_KEY] || DEFAULT_WEBHOOK_URL;
  webhookTokenInput.value = saved[WEBHOOK_TOKEN_STORAGE_KEY] || "";
  capturedMessage.value =
    saved[LAST_CAPTURED_MESSAGE_STORAGE_KEY] || "Chưa lấy tin nhắn nào.";
  renderAutomationStatus(
    Boolean(saved[AUTO_TRADE_ENABLED_STORAGE_KEY]),
    saved[AUTO_TRADE_STATUS_STORAGE_KEY] || null
  );
}

async function saveConnectionSettings() {
  await chrome.storage.local.set({
    [API_KEY_STORAGE_KEY]: apiKeyInput.value.trim(),
    [WEBHOOK_URL_STORAGE_KEY]: webhookUrlInput.value.trim() || DEFAULT_WEBHOOK_URL,
    [WEBHOOK_TOKEN_STORAGE_KEY]: webhookTokenInput.value.trim(),
  });
}

function getWebhookConfiguration() {
  return normalizeWebhookConfiguration(
    webhookUrlInput.value,
    webhookTokenInput.value
  );
}

async function getActiveTelegramTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://web.telegram.org/")) {
    throw new Error("Hãy mở Telegram Web và chọn một cuộc trò chuyện trước.");
  }
  return tab;
}

function isMissingContentScriptError(error) {
  return /Receiving end does not exist|Could not establish connection/i.test(
    error?.message || ""
  );
}

async function requestLastMessage(tabId) {
  const request = { type: "GET_LAST_TELEGRAM_MESSAGE" };
  try {
    return await chrome.tabs.sendMessage(tabId, request);
  } catch (error) {
    if (!isMissingContentScriptError(error)) {
      throw error;
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-script.js"],
    });
    return chrome.tabs.sendMessage(tabId, request);
  }
}

async function deliverCurrentSignal() {
  if (!currentSignal || !currentSignalIdempotencyKey) {
    throw new Error("Chưa có JSON tín hiệu hợp lệ để gửi.");
  }

  await saveConnectionSettings();
  const delivered = await sendSignalToWebhook(
    currentSignal,
    currentSignalIdempotencyKey,
    getWebhookConfiguration()
  );
  setWebhookStatus(
    delivered.duplicate
      ? `Signal ${delivered.id} đã tồn tại, không tạo lệnh trùng.`
      : `Đã xếp signal ${delivered.id} vào hàng đợi MT5.`,
    "success"
  );
}

getMessageButton.addEventListener("click", async () => {
  const startedAt = performance.now();
  const apiKey = apiKeyInput.value.trim();

  if (!apiKey) {
    elapsedTime.textContent = "Thời gian xử lý: —";
    setStatus("Hãy nhập OpenAI API key trước khi phân tích.", "error");
    apiKeyInput.focus();
    return;
  }

  const stopElapsedTimer = startElapsedTimer(startedAt);
  setLoading(true);
  result.hidden = true;
  currentSignal = null;
  currentSignalIdempotencyKey = "";
  sendWebhookButton.hidden = true;
  setWebhookStatus("");
  setStatus("Đang đọc tin nhắn text cuối cùng…");

  try {
    await saveConnectionSettings();
    const tab = await getActiveTelegramTab();
    const response = await requestLastMessage(tab.id);
    if (!response?.ok) {
      throw new Error(response?.error || "Không tìm thấy tin nhắn text.");
    }

    capturedMessage.value = response.text;
    await chrome.storage.local.set({
      [LAST_CAPTURED_MESSAGE_STORAGE_KEY]: response.text,
    });

    setStatus("Đang phân tích bằng GPT-5.6 Sol…");
    const signal = await analyzeForexMessage(response.text, apiKey);
    stopElapsedTimer();

    analysisResult.value = JSON.stringify(signal, null, 2);
    result.hidden = false;
    currentSignal = Object.keys(signal).length ? signal : null;
    currentSignalIdempotencyKey = currentSignal ? crypto.randomUUID() : "";
    sendWebhookButton.hidden = !currentSignal;
    sendWebhookButton.disabled = !currentSignal;
    setStatus(
      currentSignal
        ? "Đã phân tích tin nhắn cuối cùng."
        : "Tin nhắn không đủ dữ liệu để xác định tín hiệu; kết quả là {}.",
      currentSignal ? "success" : "warning"
    );
  } catch (error) {
    result.hidden = true;
    setStatus(
      isMissingContentScriptError(error)
        ? "Không thể kết nối với tab Telegram Web. Hãy tải lại trang rồi thử lại."
        : error.message || "Đã xảy ra lỗi khi đọc tin nhắn.",
      "error"
    );
  } finally {
    stopElapsedTimer();
    setLoading(false);
  }
});

autoSendWebhookInput.addEventListener("change", async () => {
  const enabled = autoSendWebhookInput.checked;
  autoSendWebhookInput.disabled = true;

  try {
    let tabId = null;
    if (enabled) {
      if (!apiKeyInput.value.trim()) {
        throw new Error("Hãy nhập OpenAI API key trước khi bật tự động.");
      }
      getWebhookConfiguration();
      tabId = (await getActiveTelegramTab()).id;
    }

    await saveConnectionSettings();
    const response = await chrome.runtime.sendMessage({
      type: "SET_AUTO_TRADING",
      enabled,
      tabId,
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Không thể thay đổi chế độ tự động.");
    }
    renderAutomationStatus(enabled, response);
    setStatus(
      enabled
        ? "Đã bật tự động. Tin nhắn hiện tại chỉ được dùng làm mốc."
        : "Đã tắt tự động hóa.",
      enabled ? "success" : "warning"
    );
  } catch (error) {
    autoSendWebhookInput.checked = !enabled;
    renderAutomationStatus(!enabled, {
      state: "error",
      message: error.message || "Không thể thay đổi chế độ tự động.",
    });
    setStatus(error.message || "Không thể thay đổi chế độ tự động.", "error");
  } finally {
    autoSendWebhookInput.disabled = false;
  }
});

sendWebhookButton.addEventListener("click", async () => {
  sendWebhookButton.disabled = true;
  setWebhookStatus("Đang gửi JSON sang webhook MT5…");
  try {
    await deliverCurrentSignal();
  } catch (error) {
    setWebhookStatus(error.message || "Không thể gửi sang webhook MT5.", "error");
  } finally {
    sendWebhookButton.disabled = false;
  }
});

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(analysisResult.value);
    setStatus("Đã sao chép JSON.", "success");
  } catch {
    analysisResult.select();
    document.execCommand("copy");
    setStatus("Đã sao chép JSON.", "success");
  }
});

for (const input of [apiKeyInput, webhookUrlInput, webhookTokenInput]) {
  input.addEventListener("change", () => {
    saveConnectionSettings().catch(() => {
      setStatus("Không thể lưu cấu hình trong profile Chrome.", "error");
    });
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }
  if (changes[AUTO_TRADE_STATUS_STORAGE_KEY]) {
    renderAutomationStatus(
      autoSendWebhookInput.checked,
      changes[AUTO_TRADE_STATUS_STORAGE_KEY].newValue || null
    );
  }
  if (changes[AUTO_TRADE_ENABLED_STORAGE_KEY]) {
    autoSendWebhookInput.checked = Boolean(
      changes[AUTO_TRADE_ENABLED_STORAGE_KEY].newValue
    );
  }
  if (changes[LAST_CAPTURED_MESSAGE_STORAGE_KEY]) {
    capturedMessage.value =
      changes[LAST_CAPTURED_MESSAGE_STORAGE_KEY].newValue ||
      "Chưa lấy tin nhắn nào.";
  }
});

loadSettings().catch(() => {
  setStatus("Không thể đọc cấu hình đã lưu trong profile Chrome.", "error");
});
