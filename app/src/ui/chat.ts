export function chatPanelHTML(): string {
  return `
    <div id="room-chat" class="hidden bg-surface rounded-lg border border-gray-800 mb-6">
      <div class="px-4 py-3 border-b border-gray-800">
        <p class="text-xs uppercase tracking-widest text-accent">&#x1F512; Secure Chat</p>
      </div>
      <div id="chat-messages" class="overflow-y-auto px-4 py-3 space-y-3" style="max-height:210px">
        <p id="chat-empty" class="text-xs text-muted text-center py-2">No messages yet.</p>
      </div>
      <div id="chat-typing" class="hidden px-4 py-1.5 border-t border-gray-800/50">
        <span class="text-xs text-muted">
          <span class="typing-dot">&#x2022;</span><span class="typing-dot">&#x2022;</span><span class="typing-dot">&#x2022;</span>
        </span>
      </div>
      <div class="flex gap-2 px-4 py-3 border-t border-gray-800">
        <input
          id="chat-input"
          type="text"
          placeholder="type a message..."
          class="flex-1 bg-bg border border-gray-700 rounded px-3 py-1.5 text-sm font-mono text-text placeholder-gray-600 focus:outline-none focus:border-accent"
        />
        <button id="chat-send-btn" class="bg-surface border border-gray-700 rounded px-3 py-1.5 text-sm font-mono text-accent hover:border-accent transition-colors">Send</button>
      </div>
    </div>
  `;
}

export interface ChatPanel {
  appendMessage(from: "me" | "them", text: string): void;
  enable(onSend: (text: string) => void, onTyping: () => void): void;
  showTyping(): void;
  disable(): void;
}

export function initChat(container: HTMLElement): ChatPanel {
  const panel = container.querySelector("#room-chat") as HTMLElement;
  const messagesEl = container.querySelector("#chat-messages") as HTMLElement;
  const typingEl = container.querySelector("#chat-typing") as HTMLElement;
  const input = container.querySelector("#chat-input") as HTMLInputElement;
  const sendBtn = container.querySelector("#chat-send-btn") as HTMLButtonElement;

  let sendFn: ((text: string) => void) | null = null;
  let typingFn: (() => void) | null = null;
  let lastTypingSent = 0;
  let typingTimeout: ReturnType<typeof setTimeout> | null = null;

  input.addEventListener("input", () => {
    if (!typingFn) return;
    const now = Date.now();
    if (now - lastTypingSent > 1000) {
      lastTypingSent = now;
      typingFn();
    }
  });

  function sendMessage() {
    const text = input.value.trim();
    if (!text || !sendFn) return;
    sendFn(text);
    appendMessage("me", text);
    input.value = "";
  }

  sendBtn.addEventListener("click", sendMessage);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  function appendMessage(from: "me" | "them", text: string) {
    const placeholder = container.querySelector("#chat-empty");
    if (placeholder) placeholder.remove();

    const isMe = from === "me";
    const wrapper = document.createElement("div");
    wrapper.className = `flex flex-col ${isMe ? "items-end" : "items-start"}`;

    const label = document.createElement("p");
    label.className = "text-xs text-muted mb-0.5";
    label.textContent = isMe ? "You" : "Them";

    const bubble = document.createElement("div");
    bubble.className = `rounded px-3 py-1.5 text-sm font-mono text-text max-w-xs break-words bg-bg border ${
      isMe ? "border-accent" : "border-gray-700"
    }`;
    bubble.textContent = text;

    wrapper.appendChild(label);
    wrapper.appendChild(bubble);
    messagesEl.appendChild(wrapper);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function showTyping() {
    typingEl.classList.remove("hidden");
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      typingEl.classList.add("hidden");
    }, 2000);
  }

  return {
    appendMessage,
    showTyping,
    enable(onSend: (text: string) => void, onTyping: () => void) {
      sendFn = onSend;
      typingFn = onTyping;
      panel.classList.remove("hidden");
    },
    disable() {
      panel.classList.add("hidden");
      input.disabled = true;
      sendBtn.disabled = true;
      if (typingTimeout) clearTimeout(typingTimeout);
    },
  };
}
