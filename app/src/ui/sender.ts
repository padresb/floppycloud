import QRCode from "qrcode";
import { formatPhraseForDisplay } from "../lib/phrase";
import { createProgressBar, updateProgress, resetProgress } from "./progress";
import { showToast } from "./toast";

export interface SenderUIOptions {
  phrase: string;
  shareableLink: string;
  hasKey: boolean;
  onFileSelected: (file: File) => void;
  onDisconnect: () => void;
}

export interface SenderUI {
  onPeerJoined: () => void;
  onChannelReady: () => void;
  onTransferProgress: (pct: number, speed?: string) => void;
  onTransferComplete: (
    fileName: string,
    elapsedSeconds: number,
    secure: boolean
  ) => void;
  onSessionEnded: () => void;
}

export function createSenderUI(
  container: HTMLElement,
  options: SenderUIOptions
): SenderUI {
  const { phrase, shareableLink, hasKey, onFileSelected, onDisconnect } =
    options;
  const displayPhrase = formatPhraseForDisplay(phrase);

  container.innerHTML = `
    <div class="max-w-lg mx-auto px-4 py-8">
      <!-- Phrase badge -->
      <div class="text-center mb-8">
        <div class="inline-flex items-center gap-3 bg-surface px-6 py-3 rounded-lg border border-gray-800">
          <span class="padlock waiting" id="sender-padlock">&#x1F513;</span>
          <span class="font-heading text-xl tracking-wide" id="sender-phrase">${displayPhrase}</span>
        </div>
        <p class="text-muted text-sm mt-2" id="sender-status">Waiting for receiver...</p>
      </div>

      <!-- Share section -->
      <div id="sender-share" class="bg-surface rounded-lg border border-gray-800 p-6 mb-6">
        <p class="text-sm text-muted mb-3">Share this link:</p>
        <div class="flex gap-2 mb-4">
          <input
            type="text"
            readonly
            value="${shareableLink}"
            class="flex-1 bg-bg border border-gray-700 rounded px-3 py-2 text-sm font-mono text-text focus:outline-none focus:border-accent"
            id="sender-link-input"
          />
          <button
            id="sender-copy-btn"
            class="bg-surface border border-gray-700 rounded px-4 py-2 text-sm text-text hover:border-accent transition-colors"
          >Copy</button>
        </div>
        <div class="flex justify-center">
          <canvas id="sender-qr" class="qr-canvas"></canvas>
        </div>
      </div>

      <!-- Drop zone (disabled initially) -->
      <div id="sender-dropzone" class="drop-zone disabled mb-6">
        <p class="text-muted text-sm">Waiting for receiver to connect</p>
      </div>

      <!-- Progress area (hidden initially) -->
      <div id="sender-progress-area" class="hidden mb-6">
        <p class="text-sm text-text mb-2" id="sender-file-info"></p>
        <div id="sender-progress-bar"></div>
        <p class="text-accent text-sm mt-2 hidden" id="sender-sent-msg">Sent</p>
      </div>

      <!-- Transfer log -->
      <div class="bg-surface rounded-lg border border-gray-800 p-4 mb-6">
        <p class="text-xs uppercase tracking-widest text-accent mb-2">Transfer Log</p>
        <ul id="sender-log-list" class="text-sm text-muted space-y-1">
          <li id="sender-log-empty">No files transferred yet.</li>
        </ul>
      </div>

      <!-- Hidden file input -->
      <input type="file" id="sender-file-input" class="hidden" />

      <!-- Actions -->
      <div class="text-center">
        <button id="sender-disconnect-btn" class="link-muted">Cancel session</button>
      </div>
    </div>
  `;

  // QR code
  const qrCanvas = container.querySelector("#sender-qr") as HTMLCanvasElement;
  QRCode.toCanvas(qrCanvas, shareableLink, {
    width: 180,
    margin: 1,
    color: { dark: "#00FF87", light: "#1A1A1A" },
  });

  // Copy button
  const copyBtn = container.querySelector(
    "#sender-copy-btn"
  ) as HTMLButtonElement;
  const linkInput = container.querySelector(
    "#sender-link-input"
  ) as HTMLInputElement;
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(shareableLink).then(() => {
      copyBtn.textContent = "Copied!";
      setTimeout(() => (copyBtn.textContent = "Copy"), 2000);
    });
  });
  linkInput.addEventListener("click", () => linkInput.select());

  // Disconnect
  const disconnectBtn = container.querySelector(
    "#sender-disconnect-btn"
  ) as HTMLButtonElement;
  disconnectBtn.addEventListener("click", onDisconnect);

  // File input and drop zone handlers
  const dropZone = container.querySelector(
    "#sender-dropzone"
  ) as HTMLDivElement;
  const fileInput = container.querySelector(
    "#sender-file-input"
  ) as HTMLInputElement;
  const maxSize =
    parseInt(import.meta.env.VITE_MAX_FILE_SIZE_MB ?? "2048", 10) *
    1024 *
    1024;

  function handleFile(file: File) {
    if (file.size > maxSize) {
      showToast("Files must be under 2 GB.", "error");
      return;
    }
    onFileSelected(file);
  }

  // Progress bar
  const progressArea = container.querySelector(
    "#sender-progress-area"
  ) as HTMLDivElement;
  const progressBarContainer = container.querySelector(
    "#sender-progress-bar"
  ) as HTMLDivElement;
  const progressBar = createProgressBar();
  progressBarContainer.appendChild(progressBar);

  function enableFilePicker() {
    dropZone.classList.remove("disabled");
    dropZone.classList.add("active");
    dropZone.innerHTML = `
      <p class="text-text text-sm mb-1">Drag & drop a file, or click to select</p>
      <p class="text-muted text-xs">Up to 2 GB</p>
    `;

    // Drop zone events
    dropZone.addEventListener("click", () => fileInput.click());
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("dragover");
    });
    dropZone.addEventListener("dragleave", () => {
      dropZone.classList.remove("dragover");
    });
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList.remove("dragover");
      const file = e.dataTransfer?.files[0];
      if (file) handleFile(file);
    });
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (file) handleFile(file);
      fileInput.value = "";
    });
  }

  return {
    onPeerJoined() {
      const status = container.querySelector(
        "#sender-status"
      ) as HTMLElement;
      status.textContent = "Peer joined \u00B7 establishing secure channel...";
      status.classList.remove("text-muted");
      status.classList.add("text-accent");

      // Hide share section while secure channel is being established.
      const shareSection = container.querySelector(
        "#sender-share"
      ) as HTMLElement;
      shareSection.classList.add("hidden");

      dropZone.classList.add("disabled");
      dropZone.classList.remove("active");
      dropZone.innerHTML = `
        <p class="text-muted text-sm">Peer joined. Establishing secure channel...</p>
      `;

      disconnectBtn.textContent = "End Session";
      disconnectBtn.classList.remove("link-muted");
      disconnectBtn.className =
        "mt-4 bg-surface border border-gray-700 rounded px-6 py-2 text-sm text-warning hover:border-warning transition-colors font-mono cursor-pointer";
    },
    onChannelReady() {
      const padlock = container.querySelector(
        "#sender-padlock"
      ) as HTMLElement;
      padlock.innerHTML = "&#x1F512;";
      padlock.className = "padlock connected";

      const status = container.querySelector(
        "#sender-status"
      ) as HTMLElement;
      status.textContent = hasKey
        ? "Connected \u00B7 End-to-end encrypted"
        : "Connected \u00B7 Encrypted (transport)";
      status.classList.remove("text-muted");
      status.classList.add("text-accent");

      enableFilePicker();
    },

    onTransferProgress(pct: number, speed?: string) {
      dropZone.classList.add("hidden");
      progressArea.classList.remove("hidden");
      const sentMsg = container.querySelector(
        "#sender-sent-msg"
      ) as HTMLElement;
      sentMsg.classList.add("hidden");
      updateProgress(progressBar, pct, speed);
    },

    onTransferComplete(fileName: string, elapsedSeconds: number, secure: boolean) {
      updateProgress(progressBar, 100);
      const sentMsg = container.querySelector(
        "#sender-sent-msg"
      ) as HTMLElement;
      sentMsg.classList.remove("hidden");

      const logList = container.querySelector("#sender-log-list") as HTMLUListElement;
      const empty = container.querySelector("#sender-log-empty");
      if (empty) empty.remove();
      const item = document.createElement("li");
      item.className = "text-text";
      const securityLabel = secure ? "e2e encrypted" : "encrypted";
      item.textContent = `${fileName} · ${securityLabel} · transferred in ${formatSeconds(elapsedSeconds)}s`;
      logList.prepend(item);

      // Reset after brief pause
      setTimeout(() => {
        resetProgress(progressBar);
        progressArea.classList.add("hidden");
        dropZone.classList.remove("hidden");
        const fileInfo = container.querySelector(
          "#sender-file-info"
        ) as HTMLElement;
        fileInfo.textContent = "";
      }, 2000);
    },

    onSessionEnded() {
      const padlock = container.querySelector(
        "#sender-padlock"
      ) as HTMLElement;
      padlock.innerHTML = "&#x1F513;";
      padlock.className = "padlock ended";

      const phraseEl = container.querySelector(
        "#sender-phrase"
      ) as HTMLElement;
      phraseEl.style.textDecoration = "line-through";
      phraseEl.style.color = "#555";

      const status = container.querySelector(
        "#sender-status"
      ) as HTMLElement;
      status.textContent = "This session has ended \u2014 the link has expired";
      status.className = "text-muted text-sm mt-2";

      dropZone.classList.add("hidden");
      progressArea.classList.add("hidden");

      const shareSection = container.querySelector(
        "#sender-share"
      ) as HTMLElement;
      shareSection.classList.add("hidden");

      disconnectBtn.textContent = "Start a new transfer";
      disconnectBtn.className = "btn-primary mt-6";
      disconnectBtn.onclick = () => {
        window.location.href = "/";
      };
    },
  };
}

function formatSeconds(seconds: number): string {
  return seconds >= 10 ? seconds.toFixed(1) : seconds.toFixed(2);
}
