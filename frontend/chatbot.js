const chatMessages = document.getElementById("chat-messages");
const chatInput = document.getElementById("chat-input");
const chatSend = document.getElementById("chat-send");

const invoke = window.__TAURI__.core.invoke;

document.getElementById("titlebar-minimize").addEventListener("click", () => invoke("window_minimize"));
document.getElementById("titlebar-close").addEventListener("click", () => invoke("window_close"));
document.getElementById("titlebar-maximize").addEventListener("click", () => invoke("window_toggle_maximize"));

// Sidebar tabs: Chats | Activity
const tabChats = document.getElementById("tab-chats");
const tabActivity = document.getElementById("tab-activity");
const panelChats = document.getElementById("panel-chats");
const panelActivity = document.getElementById("panel-activity");

function showPanel(panel) {
  panelChats.classList.toggle("active", panel === "chats");
  panelActivity.classList.toggle("active", panel === "activity");
  panelChats.hidden = panel !== "chats";
  panelActivity.hidden = panel !== "activity";
  tabChats.classList.toggle("active", panel === "chats");
  tabActivity.classList.toggle("active", panel === "activity");
  tabChats.setAttribute("aria-selected", panel === "chats");
  tabActivity.setAttribute("aria-selected", panel === "activity");
}

tabChats.addEventListener("click", () => {
  showPanel("chats");
  refreshChatHistory();
});

tabActivity.addEventListener("click", () => showPanel("activity"));

// Chat history: list from backend, ChatGPT-style titles
const chatHistoryList = document.getElementById("chat-history-list");

const chatIconSvg = `<svg class="chat-history-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;

async function refreshChatHistory() {
  try {
    const chats = await invoke("list_chats");
    chatHistoryList.innerHTML = "";
    if (!chats || chats.length === 0) {
      const empty = document.createElement("p");
      empty.className = "chat-history-empty";
      empty.textContent = "No conversations yet. Start chatting to see them here.";
      chatHistoryList.appendChild(empty);
      return;
    }
    for (const chat of chats) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chat-history-item";
      btn.setAttribute("data-chat-id", chat.id);
      btn.innerHTML = chatIconSvg + `<span class="chat-history-title">${escapeHtml(chat.title)}</span>`;
      chatHistoryList.appendChild(btn);
    }
  } catch (_) {
    chatHistoryList.innerHTML = "";
    const empty = document.createElement("p");
    empty.className = "chat-history-empty";
    empty.textContent = "No conversations yet.";
    chatHistoryList.appendChild(empty);
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

refreshChatHistory();

function appendMessage(text, isUser) {
  const div = document.createElement("div");
  div.className = isUser ? "msg msg-user" : "msg msg-bot";
  const span = document.createElement("span");
  span.className = "msg-text";
  span.textContent = text;
  div.appendChild(span);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function sendMessage() {
  const raw = chatInput.value.trim();
  if (!raw) return;
  chatInput.value = "";
  appendMessage(raw, true);
  chatSend.disabled = true;

  try {
    await invoke("append_chat_log", { role: "user", content: raw });
  } catch (_) {}

  try {
    const reply = await window.__TAURI__.core.invoke("chatbot_response", { message: raw });
    appendMessage(reply, false);
    await invoke("append_chat_log", { role: "assistant", content: reply });
  } catch (err) {
    const msg = (err && (err.message || err)) || "Sorry, something went wrong. Please try again.";
    appendMessage(String(msg), false);
    try {
      await invoke("append_chat_log", { role: "assistant", content: msg });
    } catch (_) {}
  }
  chatSend.disabled = false;
  refreshChatHistory();
}

chatSend.addEventListener("click", sendMessage);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
