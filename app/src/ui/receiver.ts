import { formatPhraseForDisplay } from "../lib/phrase";
import { createProgressBar, updateProgress, resetProgress } from "./progress";
import type { TransferMetadata } from "../types";

export interface ReceiverUIOptions {
  phrase: string;
  hasKey: boolean;
  onLeave: () => void;
}

export interface ReceiverUI {
  onConnecting: () => void;
  onConnected: () => void;
  onMetadata: (meta: TransferMetadata) => void;
  onTransferProgress: (pct: number, speed?: string) => void;
  onTransferComplete: (blob: Blob, fileName: string) => void;
  onSessionEnded: () => void;
}

export function createReceiverUI(
  container: HTMLElement,
  options: ReceiverUIOptions
): ReceiverUI {
  const { phrase, hasKey, onLeave } = options;
  const displayPhrase = formatPhraseForDisplay(phrase);

  container.innerHTML = `
    <div class="max-w-lg mx-auto px-4 py-8">
      <!-- Phrase badge -->
      <div class="text-center mb-8">
        <div class="inline-flex items-center gap-3 bg-surface px-6 py-3 rounded-lg border border-gray-800">
          <span class="padlock waiting" id="recv-padlock">&#x1F513;</span>
          <span class="font-heading text-xl tracking-wide" id="recv-phrase">${displayPhrase}</span>
        </div>
        <p class="text-muted text-sm mt-2" id="recv-status">Connecting...</p>
      </div>

      <!-- Spinner (shown while connecting) -->
      <div id="recv-spinner" class="text-center mb-6">
        <div class="inline-block w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin"></div>
      </div>

      <!-- Waiting message (shown after connected, before file) -->
      <div id="recv-waiting" class="hidden text-center mb-6">
        <p class="text-muted text-sm">Waiting for sender to drop a file...</p>
      </div>

      <!-- File receive area -->
      <div id="recv-transfer" class="hidden mb-6">
        <p class="text-sm text-text mb-2" id="recv-file-info"></p>
        <div id="recv-progress-bar"></div>
        <p class="text-accent text-sm mt-2 hidden" id="recv-saved-msg">Saved</p>
      </div>

      <!-- Actions -->
      <div class="text-center">
        <button id="recv-leave-btn" class="link-muted">Leave</button>
      </div>
    </div>
  `;

  const leaveBtn = container.querySelector(
    "#recv-leave-btn"
  ) as HTMLButtonElement;
  leaveBtn.addEventListener("click", onLeave);

  const progressBarContainer = container.querySelector(
    "#recv-progress-bar"
  ) as HTMLDivElement;
  const progressBar = createProgressBar();
  progressBarContainer.appendChild(progressBar);

  return {
    onConnecting() {
      const status = container.querySelector("#recv-status") as HTMLElement;
      status.textContent = "Establishing secure connection...";
    },

    onConnected() {
      const padlock = container.querySelector("#recv-padlock") as HTMLElement;
      padlock.innerHTML = "&#x1F512;";
      padlock.className = "padlock connected";

      const status = container.querySelector("#recv-status") as HTMLElement;
      status.textContent = hasKey
        ? "Connected \u00B7 End-to-end encrypted"
        : "Connected \u00B7 Encrypted (transport)";
      status.classList.remove("text-muted");
      status.classList.add("text-accent");

      const spinner = container.querySelector("#recv-spinner") as HTMLElement;
      spinner.classList.add("hidden");

      const waiting = container.querySelector("#recv-waiting") as HTMLElement;
      waiting.classList.remove("hidden");
    },

    onMetadata(meta: TransferMetadata) {
      const waiting = container.querySelector("#recv-waiting") as HTMLElement;
      waiting.classList.add("hidden");

      const transfer = container.querySelector(
        "#recv-transfer"
      ) as HTMLElement;
      transfer.classList.remove("hidden");

      const fileInfo = container.querySelector(
        "#recv-file-info"
      ) as HTMLElement;
      fileInfo.textContent = `Receiving: ${meta.fileName} \u2014 ${formatFileSize(meta.fileSize)}`;

      const savedMsg = container.querySelector(
        "#recv-saved-msg"
      ) as HTMLElement;
      savedMsg.classList.add("hidden");
      resetProgress(progressBar);
    },

    onTransferProgress(pct: number, speed?: string) {
      updateProgress(progressBar, pct, speed);
    },

    onTransferComplete(blob: Blob, fileName: string) {
      updateProgress(progressBar, 100);

      // Auto-download
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      const savedMsg = container.querySelector(
        "#recv-saved-msg"
      ) as HTMLElement;
      savedMsg.classList.remove("hidden");

      // Reset for next file after delay
      setTimeout(() => {
        const transfer = container.querySelector(
          "#recv-transfer"
        ) as HTMLElement;
        transfer.classList.add("hidden");
        const waiting = container.querySelector(
          "#recv-waiting"
        ) as HTMLElement;
        waiting.classList.remove("hidden");
        resetProgress(progressBar);
      }, 3000);
    },

    onSessionEnded() {
      const padlock = container.querySelector("#recv-padlock") as HTMLElement;
      padlock.innerHTML = "&#x1F513;";
      padlock.className = "padlock ended";

      const phraseEl = container.querySelector("#recv-phrase") as HTMLElement;
      phraseEl.style.textDecoration = "line-through";
      phraseEl.style.color = "#555";

      const status = container.querySelector("#recv-status") as HTMLElement;
      status.textContent =
        "This session has ended \u2014 the link has expired";
      status.className = "text-muted text-sm mt-2";

      // Hide everything
      for (const id of [
        "#recv-spinner",
        "#recv-waiting",
        "#recv-transfer",
      ]) {
        const el = container.querySelector(id) as HTMLElement;
        if (el) el.classList.add("hidden");
      }

      leaveBtn.textContent = "Start a new transfer";
      leaveBtn.className = "btn-primary mt-6";
      leaveBtn.onclick = () => {
        window.location.href = "/";
      };
    },
  };
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
