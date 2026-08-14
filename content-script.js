const MESSAGE_SELECTORS = [
  ".Message",
  ".message-list-item",
  ".bubble",
  "[data-message-id]",
  "[data-mid]",
];

const CHAT_ROOT_SELECTORS = [
  "#MiddleColumn .MessageList .messages-container",
  "#MiddleColumn .MessageList",
  "#column-center .MessageList .messages-container",
  "#column-center .MessageList",
  ".MessageList .messages-container",
  ".MessageList",
  "#column-center",
  "#MiddleColumn",
  ".MiddleColumn",
  ".middle-column",
  ".messages-layout",
  "#Main .chat",
  "main",
];

const PINNED_AREA_SELECTORS = [
  ".MiddleHeader",
  ".middle-header",
  ".MiddleHeaderPanes",
  ".PinnedMessage",
  ".pinned-message",
  ".pinned-message-wrapper",
  "[class*='PinnedMessage']",
  "[class*='pinned-message']",
];

const TEXT_SELECTORS = [
  ".text-content",
  ".message-text",
  ".translatable-message",
  ".message-content",
  ".caption",
  ".text",
];

const REMOVE_FROM_TEXT_SELECTORS = [
  ".MessageMeta",
  "[data-ignore-on-paste]",
  "time",
  ".time",
  ".message-time",
  ".message-views",
  ".message-replies",
  ".message-replies-wrapper",
  ".message-signature",
  ".message-price",
  ".reactions",
  ".reaction",
  ".message-reactions",
  ".reply",
  ".reply-wrapper",
  ".forwarded-from",
  ".sender-title",
  ".message-title",
  ".status",
  ".views",
  ".site-name",
  ".site-title",
  ".site-description",
  ".WebPage-text",
  ".web-page-text",
  ".link-preview-title",
  ".link-preview-description",
  "button",
  "svg",
];

const EXCLUDED_TEXT_CONTEXT_SELECTORS = [
  ".reply",
  ".reply-wrapper",
  ".message-subheader",
  ".embedded-message",
  ".reactions",
  ".reaction",
  ".message-reactions",
  ".MessageMeta",
  ".message-time",
  ".message-views",
  ".message-replies",
  ".message-replies-wrapper",
  ".message-signature",
  ".message-price",
  ".sender-title",
  ".message-title",
  ".status",
  ".views",
  ".document",
  "button",
];

let automaticMonitorEnabled = false;
let monitoredConversationKey = "";
let lastObservedFingerprint = "";
let monitorDebounceId = null;
let monitorIntervalId = null;
let monitorQueueRunning = false;
const automaticMessageQueue = [];
let sidePanelOpenRequestInProgress = false;
let extensionContextInvalidated = false;
const SIDE_PANEL_AUTO_OPENED_STORAGE_KEY = "telegramSidePanelAutoOpened";

function getExtensionRuntime() {
  const runtime = globalThis.chrome?.runtime;
  return runtime && typeof runtime.sendMessage === "function" ? runtime : null;
}

function getExtensionStorage() {
  const storage = globalThis.chrome?.storage?.local;
  return storage && typeof storage.get === "function" ? storage : null;
}

function stopInvalidatedExtensionContext() {
  if (extensionContextInvalidated) {
    return;
  }

  extensionContextInvalidated = true;
  automaticMonitorEnabled = false;
  sidePanelOpenRequestInProgress = false;
  automaticMessageQueue.length = 0;
  clearTimeout(monitorDebounceId);
  clearInterval(monitorIntervalId);
  monitorDebounceId = null;
  monitorIntervalId = null;
  document.removeEventListener(
    "click",
    requestSidePanelOnFirstInteraction,
    true
  );
  window.removeEventListener("hashchange", scheduleAutomaticInspection);
  console.info(
    "Telegram extension context was reloaded; the inactive content script has stopped."
  );
}

function isInvalidatedExtensionContext(error) {
  return (
    !getExtensionRuntime() ||
    /extension context invalidated/i.test(error?.message || "")
  );
}

function isElementVisible(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  let current = element;
  while (current instanceof HTMLElement) {
    const style = window.getComputedStyle(current);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0 ||
      current.classList.contains("Transition_slide-inactive")
    ) {
      return false;
    }
    current = current.parentElement;
  }

  const rect = element.getBoundingClientRect();

  return rect.width > 0 && rect.height > 0;
}

function getTransitionPriority(element) {
  let current = element;
  let state = "none";

  while (current instanceof HTMLElement) {
    if (current.classList.contains("Transition_slide-inactive")) {
      state = "inactive";
    } else if (current.classList.contains("Transition_slide-from")) {
      state = "from";
    } else if (current.classList.contains("Transition_slide-to")) {
      state = "to";
    } else if (current.classList.contains("Transition_slide-active")) {
      state = "active";
    }
    current = current.parentElement;
  }

  return {
    to: 0,
    active: 1,
    none: 2,
    from: 3,
    inactive: 4,
  }[state];
}

function findPaintedChatRoot(roots) {
  if (typeof document.elementsFromPoint !== "function") {
    return null;
  }

  const columns = [
    ...document.querySelectorAll("#MiddleColumn, #column-center"),
  ].filter(isElementVisible);

  for (const column of columns) {
    const rect = column.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const sampleRatios = [0.5, 0.7, 0.3];

    for (const ratio of sampleRatios) {
      const y = rect.top + rect.height * ratio;
      const paintedElements = document.elementsFromPoint(x, y);

      for (const paintedElement of paintedElements) {
        const activeMessageList = paintedElement.closest?.(".MessageList");
        if (!activeMessageList) {
          continue;
        }

        const paintedRoot = roots.find(
          (root) =>
            root === activeMessageList || activeMessageList.contains(root)
        );

        if (paintedRoot) {
          return paintedRoot;
        }
      }
    }
  }

  return null;
}

function findChatRoot() {
  const roots = [
    ...new Set(
      CHAT_ROOT_SELECTORS.flatMap((selector) => [
        ...document.querySelectorAll(selector),
      ])
    ),
  ].filter(
    (element) =>
      isElementVisible(element) &&
      element.querySelector(MESSAGE_SELECTORS.join(","))
  );

  const paintedRoot = findPaintedChatRoot(roots);
  if (paintedRoot) {
    return paintedRoot;
  }

  roots.sort(
    (first, second) =>
      getTransitionPriority(first) - getTransitionPriority(second)
  );

  const root = roots[0];

  if (root) {
    return root;
  }

  // Fall back to a visible message when Telegram renames the layout wrapper.
  const visibleMessage = [
    ...document.querySelectorAll(MESSAGE_SELECTORS.join(",")),
  ].find(isLikelyMessage);

  return (
    visibleMessage?.closest(
      ".MessageList, #MiddleColumn, #column-center, main"
    ) ||
    visibleMessage?.parentElement ||
    null
  );
}

function isLikelyMessage(element) {
  if (!isElementVisible(element)) {
    return false;
  }

  if (element.closest(PINNED_AREA_SELECTORS.join(","))) {
    return false;
  }

  const classes = element.className?.toString().toLowerCase() || "";
  if (/service|date-separator|joined|group-call/.test(classes)) {
    return false;
  }

  return Boolean(
    element.textContent?.trim() ||
      element.querySelector(
        "img, video, audio, canvas, .document, .sticker, .media"
      )
  );
}

function removeNestedCandidates(elements) {
  const set = new Set(elements);

  return elements.filter((element) => {
    let parent = element.parentElement;
    while (parent) {
      if (set.has(parent)) {
        return false;
      }
      parent = parent.parentElement;
    }
    return true;
  });
}

function findTextMessageCandidates(root) {
  const candidates = removeNestedCandidates(
    [...root.querySelectorAll(MESSAGE_SELECTORS.join(","))].filter(
      isLikelyMessage
    )
  ).filter((element) => Boolean(extractText(element)));

  // Telegram virtualizes and reuses message nodes, so DOM order is not always
  // the same as the order painted on screen. Prefer the visually lowest
  // message, with DOM order only as a tie-breaker.
  return candidates.sort((first, second) => {
    const firstTop = first.getBoundingClientRect().top;
    const secondTop = second.getBoundingClientRect().top;
    if (Math.abs(firstTop - secondTop) > 1) {
      return firstTop - secondTop;
    }

    const position = first.compareDocumentPosition(second);
    return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
}

function findLastMessage(root) {
  const candidates = findTextMessageCandidates(root);

  if (candidates.length === 0) {
    return null;
  }

  return candidates[candidates.length - 1];
}

function getConversationKey() {
  return `${location.pathname}${location.search}${location.hash}`;
}

function getMessageStableIdentity(message, index, text) {
  const identityElement =
    [
      message,
      message.querySelector(
        "[data-message-id], [data-mid], [data-id], [id^='message']"
      ),
    ]
      .filter(Boolean)
      .find((element) =>
        ["data-message-id", "data-mid", "data-id", "id"].some((attribute) =>
          element.getAttribute?.(attribute)
        )
      ) || message;
  const identity = ["data-message-id", "data-mid", "data-id", "id"]
    .map((attribute) => identityElement.getAttribute?.(attribute) || "")
    .find(Boolean);

  if (identity) {
    return identity;
  }

  const meta = normalizeText(
    message.querySelector("time, .MessageMeta, .message-time")?.textContent || ""
  );
  return `fallback:${index}:${meta}:${text.length}:${text.slice(0, 300)}`;
}

function readTextMessageDescriptors() {
  const root = findChatRoot();
  if (!root) {
    return { conversationKey: getConversationKey(), descriptors: [] };
  }

  const conversationKey = getConversationKey();
  const descriptors = findTextMessageCandidates(root).map((message, index) => {
    const text = extractText(message);
    return {
      text,
      fingerprint: `${conversationKey}|${getMessageStableIdentity(
        message,
        index,
        text
      )}`,
    };
  });

  return { conversationKey, descriptors };
}

function normalizeText(text) {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractText(message) {
  for (const selector of TEXT_SELECTORS) {
    const targets = [...message.querySelectorAll(selector)].filter(
      (target) => !target.closest(EXCLUDED_TEXT_CONTEXT_SELECTORS.join(","))
    );

    for (const target of targets) {
      const clone = target.cloneNode(true);
      clone
        .querySelectorAll(REMOVE_FROM_TEXT_SELECTORS.join(","))
        .forEach((node) => node.remove());
      const text = normalizeText(clone.innerText || clone.textContent || "");
      if (text) {
        return text;
      }
    }
  }

  return "";
}

function readLastMessageText() {
  const root = findChatRoot();
  if (!root) {
    throw new Error("Không tìm thấy cuộc hội thoại đang mở.");
  }

  const message = findLastMessage(root);
  if (!message) {
    throw new Error("Không tìm thấy tin nhắn text trong cuộc hội thoại này.");
  }

  return extractText(message);
}

async function processAutomaticMessageQueue() {
  if (monitorQueueRunning || !automaticMonitorEnabled) {
    return;
  }

  monitorQueueRunning = true;
  try {
    while (automaticMonitorEnabled && automaticMessageQueue.length) {
      const descriptor = automaticMessageQueue.shift();
      try {
        const runtime = getExtensionRuntime();
        if (!runtime) {
          stopInvalidatedExtensionContext();
          return;
        }

        const response = await runtime.sendMessage({
          type: "TELEGRAM_NEW_TEXT_MESSAGE",
          text: descriptor.text,
          fingerprint: descriptor.fingerprint,
        });
        if (!response?.ok && !response?.ignored) {
          throw new Error(response?.error || "Unknown error");
        }
      } catch (error) {
        if (isInvalidatedExtensionContext(error)) {
          stopInvalidatedExtensionContext();
          return;
        }
        console.error("Telegram MT5 automation:", error);
        descriptor.attempts = (descriptor.attempts || 0) + 1;
        if (descriptor.attempts < 3 && automaticMonitorEnabled) {
          automaticMessageQueue.unshift(descriptor);
          await new Promise((resolve) =>
            setTimeout(resolve, descriptor.attempts * 2000)
          );
        }
      }
    }
  } finally {
    monitorQueueRunning = false;
    if (automaticMonitorEnabled && automaticMessageQueue.length) {
      processAutomaticMessageQueue();
    }
  }
}

function inspectForNewTextMessages() {
  if (!automaticMonitorEnabled) {
    return;
  }

  const { conversationKey, descriptors } = readTextMessageDescriptors();
  if (!descriptors.length) {
    return;
  }

  const latestDescriptor = descriptors[descriptors.length - 1];
  if (conversationKey !== monitoredConversationKey) {
    monitoredConversationKey = conversationKey;
    lastObservedFingerprint = latestDescriptor.fingerprint;
    automaticMessageQueue.length = 0;
    return;
  }

  if (!lastObservedFingerprint) {
    lastObservedFingerprint = latestDescriptor.fingerprint;
    return;
  }

  const lastIndex = descriptors.findIndex(
    (descriptor) => descriptor.fingerprint === lastObservedFingerprint
  );
  if (lastIndex < 0) {
    // Telegram may rebuild/virtualize the message list. Re-baseline instead of
    // risking execution of an older visible message.
    lastObservedFingerprint = latestDescriptor.fingerprint;
    return;
  }

  for (const descriptor of descriptors.slice(lastIndex + 1)) {
    automaticMessageQueue.push(descriptor);
    lastObservedFingerprint = descriptor.fingerprint;
  }
  processAutomaticMessageQueue();
}

function scheduleAutomaticInspection() {
  if (!automaticMonitorEnabled) {
    return;
  }
  clearTimeout(monitorDebounceId);
  monitorDebounceId = setTimeout(inspectForNewTextMessages, 500);
}

function setAutomaticMonitorEnabled(enabled) {
  automaticMonitorEnabled = Boolean(enabled);
  clearTimeout(monitorDebounceId);
  clearInterval(monitorIntervalId);
  monitorDebounceId = null;
  monitorIntervalId = null;
  automaticMessageQueue.length = 0;
  monitoredConversationKey = "";
  lastObservedFingerprint = "";

  if (automaticMonitorEnabled) {
    const { conversationKey, descriptors } = readTextMessageDescriptors();
    monitoredConversationKey = conversationKey;
    lastObservedFingerprint = descriptors.at(-1)?.fingerprint || "";
    monitorIntervalId = setInterval(inspectForNewTextMessages, 1000);
  }

  return {
    enabled: automaticMonitorEnabled,
    baselineReady: Boolean(lastObservedFingerprint),
  };
}

const automaticObserver = new MutationObserver(scheduleAutomaticInspection);
automaticObserver.observe(document.documentElement, {
  childList: true,
  subtree: true,
  characterData: true,
});

window.addEventListener("hashchange", scheduleAutomaticInspection);

const extensionRuntime = getExtensionRuntime();

extensionRuntime?.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.type === "PING_TELEGRAM_CONTEXT") {
    sendResponse({
      ok: true,
      isTelegram: location.hostname === "web.telegram.org",
    });
    return false;
  }

  if (request?.type === "SET_TELEGRAM_AUTO_MONITOR") {
    try {
      sendResponse({ ok: true, ...setAutomaticMonitorEnabled(request.enabled) });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
    return false;
  }

  if (request?.type === "GET_LAST_TELEGRAM_MESSAGE") {
    try {
      sendResponse({ ok: true, text: readLastMessageText() });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
  }

  return false;
});

extensionRuntime
  ?.sendMessage({ type: "TELEGRAM_MONITOR_READY" })
  .then((response) => {
    if (response?.ok && response.enabled) {
      setAutomaticMonitorEnabled(true);
    }
  })
  .catch((error) => {
    if (isInvalidatedExtensionContext(error)) {
      stopInvalidatedExtensionContext();
    }
  });

function requestSidePanelOnFirstInteraction(event) {
  if (!event.isTrusted || sidePanelOpenRequestInProgress) {
    return;
  }

  const runtime = getExtensionRuntime();
  if (!runtime) {
    stopInvalidatedExtensionContext();
    return;
  }

  sidePanelOpenRequestInProgress = true;
  runtime
    .sendMessage({ type: "OPEN_SIDE_PANEL_FROM_TELEGRAM" })
    .then((response) => {
      if (response?.ok && response.opened) {
        const storage = getExtensionStorage();
        storage?.set({ [SIDE_PANEL_AUTO_OPENED_STORAGE_KEY]: true });
        document.removeEventListener(
          "click",
          requestSidePanelOnFirstInteraction,
          true
        );
        return;
      }
      sidePanelOpenRequestInProgress = false;
    })
    .catch((error) => {
      if (isInvalidatedExtensionContext(error)) {
        stopInvalidatedExtensionContext();
        return;
      }
      sidePanelOpenRequestInProgress = false;
    });
}

getExtensionStorage()
  ?.get(SIDE_PANEL_AUTO_OPENED_STORAGE_KEY)
  .then((saved) => {
    if (!saved[SIDE_PANEL_AUTO_OPENED_STORAGE_KEY]) {
      document.addEventListener(
        "click",
        requestSidePanelOnFirstInteraction,
        true
      );
    }
  })
  .catch(() => {
    if (getExtensionRuntime()) {
      document.addEventListener("click", requestSidePanelOnFirstInteraction, true);
    }
  });
