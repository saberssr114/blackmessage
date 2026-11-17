/* BlackMessage - Telegram-style message meta, chat times and PWA glue. */
(() => {
  "use strict";

  const CHECK =
    '<svg viewBox="0 0 18 12" fill="none" aria-hidden="true">' +
    '<path d="M1 6.6l3.2 3.3L11 3.1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M6.6 6.6l3.2 3.3L16.6 3.1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>' +
    "</svg>";

  const pad = (n) => String(n).padStart(2, "0");

  function clock(value) {
    const date = new Date(value || Date.now());
    if (Number.isNaN(date.getTime())) return "";
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function shortDate(value) {
    const date = new Date(value || Date.now());
    if (Number.isNaN(date.getTime())) return "";
    const now = new Date();
    if (date.toDateString() === now.toDateString()) return clock(value);
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
    return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${String(date.getFullYear()).slice(2)}`;
  }

  function chatFor(index) {
    try {
      return typeof chats !== "undefined" ? chats[index] : null;
    } catch (error) {
      return null;
    }
  }

  function decorateMessages() {
    const box = document.getElementById("messages");
    if (!box) return;
    const chat = chatFor(typeof activeChat !== "undefined" ? activeChat : -1);
    const bubbles = box.querySelectorAll(".message[data-message-index]");
    bubbles.forEach((bubble) => {
      if (bubble.querySelector(".msg-meta")) return;
      const index = Number(bubble.dataset.messageIndex);
      const message = chat && chat.messages ? chat.messages[index] : null;
      if (!message) return;

      const meta = document.createElement("span");
      meta.className = "msg-meta";

      const time = document.createElement("span");
      time.className = "msg-time";
      time.textContent = clock(message.sentAt);
      meta.append(time);

      if (message.mine) {
        const ticks = document.createElement("span");
        const isLast = index === chat.messages.length - 1;
        ticks.className = `msg-ticks${isLast ? " read" : ""}`;
        ticks.innerHTML = CHECK;
        ticks.setAttribute("aria-label", isLast ? "Read" : "Delivered");
        meta.append(ticks);
      }
      bubble.append(meta);
      bubble.classList.add("has-meta");
    });
  }

  function decorateChatTimes() {
    const list = document.getElementById("chatList");
    if (!list) return;
    list.querySelectorAll(".chat-item").forEach((item) => {
      if (item.querySelector(".chat-time")) return;
      const title = item.querySelector(".chat-title")?.textContent || "";
      let chat = null;
      try {
        chat = chats.find((entry) => entry.name === title);
      } catch (error) {
        chat = null;
      }
      const messages = chat?.messages || [];
      const last = messages[messages.length - 1];
      if (!last?.sentAt) return;
      const time = document.createElement("span");
      time.className = "chat-time";
      time.textContent = shortDate(last.sentAt);
      item.append(time);
    });
  }

  function decorateAll() {
    decorateMessages();
    decorateChatTimes();
  }

  function observe(id, callback) {
    const node = document.getElementById(id);
    if (!node) return;
    new MutationObserver(callback).observe(node, { childList: true, subtree: true });
  }

  function boot() {
    // Group the sidebar shortcuts into tidy Telegram-style chips.
    const firstShortcut = document.querySelector(".sidebar .library-button");
    if (firstShortcut && !document.querySelector(".bm-quick-actions")) {
      const wrap = document.createElement("div");
      wrap.className = "bm-quick-actions";
      firstShortcut.before(wrap);
      wrap.append(...document.querySelectorAll(".sidebar .library-button"));
    }

    observe("messages", () => requestAnimationFrame(decorateMessages));
    observe("chatList", () => requestAnimationFrame(decorateChatTimes));
    decorateAll();

    // Telegram habit: Ctrl+K focuses search, Esc clears it.
    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        const search = document.getElementById("search");
        if (search && !search.closest("[hidden]")) {
          event.preventDefault();
          search.focus();
          search.select();
        }
      }
      if (event.key === "Escape" && document.activeElement?.id === "search") {
        document.activeElement.value = "";
        document.activeElement.dispatchEvent(new Event("input", { bubbles: true }));
        document.activeElement.blur();
      }
    });

    if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
