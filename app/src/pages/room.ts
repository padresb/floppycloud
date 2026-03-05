import { SignalingClient } from "../lib/signaling";
import { getIceConfig, createPeerConnection } from "../lib/webrtc";
import { generateKey, exportKeyToBase64, importKeyFromBase64 } from "../lib/crypto";
import { sendFile, receiveFile } from "../lib/transfer";
import { createSenderUI } from "../ui/sender";
import { createReceiverUI } from "../ui/receiver";
import { showToast } from "../ui/toast";
import type { TransferMetadata } from "../types";

export async function renderRoomPage(
  container: HTMLElement,
  phrase: string
): Promise<void> {
  const ownedPhrase = sessionStorage.getItem("floppycloud_owned_phrase");
  const isSender = ownedPhrase === phrase;

  if (isSender) {
    await initSender(container, phrase);
  } else {
    await initReceiver(container, phrase);
  }
}

async function initSender(
  container: HTMLElement,
  phrase: string
): Promise<void> {
  const signaling = new SignalingClient();
  let pc: RTCPeerConnection | null = null;
  let dataChannel: RTCDataChannel | null = null;
  let cryptoKey: CryptoKey;
  let transferStartTime = 0;
  let lastProgressBytes = 0;

  try {
    // Generate crypto key
    cryptoKey = await generateKey();
    const keyBase64 = await exportKeyToBase64(cryptoKey);

    // Build shareable link
    const origin = window.location.origin;
    const shareableLink = `${origin}/${phrase}#key=${keyBase64}`;

    // Update URL with key fragment (without triggering navigation)
    window.history.replaceState({}, "", `/${phrase}#key=${keyBase64}`);

    // Create sender UI
    const ui = createSenderUI(container, {
      phrase,
      shareableLink,
      hasKey: true,
      onFileSelected: async (file: File) => {
        if (!dataChannel || dataChannel.readyState !== "open") {
          showToast("Connection not ready. Wait for peer.", "error");
          return;
        }
        try {
          transferStartTime = Date.now();
          lastProgressBytes = 0;

          const fileInfo = container.querySelector(
            "#sender-file-info"
          ) as HTMLElement;
          if (fileInfo)
            fileInfo.textContent = `${file.name} \u2014 ${formatFileSize(file.size)}`;

          await sendFile(file, dataChannel, cryptoKey, (pct) => {
            const elapsed = (Date.now() - transferStartTime) / 1000;
            const bytesTransferred = (pct / 100) * file.size;
            const speed =
              elapsed > 0.5
                ? formatSpeed(
                    (bytesTransferred - lastProgressBytes) /
                      Math.max(elapsed, 0.1)
                  )
                : undefined;
            lastProgressBytes = bytesTransferred;
            ui.onTransferProgress(pct, speed);
          });

          signaling.send("TRANSFER_COMPLETE");
          ui.onTransferComplete();
        } catch (err) {
          showToast("Transfer failed. Try again.", "error");
        }
      },
      onDisconnect: () => {
        signaling.send("DISCONNECT");
        cleanup();
        ui.onSessionEnded();
        sessionStorage.removeItem("floppycloud_owned_phrase");
      },
    });

    // Connect WebSocket
    await signaling.connect(phrase, "sender");

    // Handle signaling events
    signaling.on("PEER_JOINED", async () => {
      ui.onPeerJoined();

      // Set up WebRTC
      const iceConfig = await getIceConfig();
      pc = createPeerConnection(iceConfig, (candidate) => {
        signaling.send("ICE_CANDIDATE", {
          candidate: candidate.toJSON(),
        });
      });

      // Create data channel
      dataChannel = pc.createDataChannel("fileTransfer", {
        ordered: true,
      });
      dataChannel.binaryType = "arraybuffer";

      // Create and send offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      signaling.send("OFFER", { sdp: offer.sdp, type: offer.type });
    });

    signaling.on("ANSWER", async (payload: unknown) => {
      const p = payload as { sdp: string; type: RTCSdpType };
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(p));
      }
    });

    signaling.on("ICE_CANDIDATE", async (payload: unknown) => {
      const p = payload as { candidate: RTCIceCandidateInit };
      if (pc) {
        await pc.addIceCandidate(new RTCIceCandidate(p.candidate));
      }
    });

    signaling.on("DISCONNECT", () => {
      cleanup();
      ui.onSessionEnded();
    });

    signaling.on("ROOM_EXPIRED", () => {
      showToast(
        "This transfer session expired. Start a new one.",
        "error"
      );
      cleanup();
      ui.onSessionEnded();
    });

    signaling.on("ERROR", (payload: unknown) => {
      const p = payload as { code: string; message: string } | undefined;
      showToast(p?.message ?? "An error occurred.", "error");
      cleanup();
      ui.onSessionEnded();
    });

    signaling.on("CLOSE", () => {
      // WebSocket closed unexpectedly
    });

    function cleanup() {
      dataChannel?.close();
      pc?.close();
      signaling.disconnect();
      pc = null;
      dataChannel = null;
    }
  } catch (err) {
    showToast("Failed to set up transfer. Try again.", "error");
    container.innerHTML = `
      <div class="min-h-screen flex items-center justify-center">
        <div class="text-center">
          <p class="text-warning mb-4">Failed to create room</p>
          <a href="/" class="btn-primary">Go Home</a>
        </div>
      </div>
    `;
  }
}

async function initReceiver(
  container: HTMLElement,
  phrase: string
): Promise<void> {
  const signaling = new SignalingClient();
  let pc: RTCPeerConnection | null = null;
  let cryptoKey: CryptoKey | null = null;

  // Parse key from URL hash
  const hash = window.location.hash;
  const keyMatch = hash.match(/key=([A-Za-z0-9+/=]+)/);
  const hasKey = !!keyMatch;

  if (keyMatch) {
    try {
      cryptoKey = await importKeyFromBase64(keyMatch[1]);
    } catch {
      showToast("Invalid encryption key in link.", "error");
    }
  }

  const ui = createReceiverUI(container, {
    phrase,
    hasKey,
    onLeave: () => {
      cleanup();
      window.location.href = "/";
    },
  });

  try {
    // Connect WebSocket
    await signaling.connect(phrase, "receiver");
    ui.onConnecting();

    // Handle signaling events
    signaling.on("OFFER", async (payload: unknown) => {
      const p = payload as { sdp: string; type: RTCSdpType };

      const iceConfig = await getIceConfig();
      pc = createPeerConnection(iceConfig, (candidate) => {
        signaling.send("ICE_CANDIDATE", {
          candidate: candidate.toJSON(),
        });
      });

      // Listen for data channel
      pc.ondatachannel = (event) => {
        const dc = event.channel;
        dc.binaryType = "arraybuffer";

        dc.onopen = () => {
          ui.onConnected();
        };

        // If we have a crypto key, set up file receiving
        if (cryptoKey) {
          const key = cryptoKey;
          let currentFileName = "";

          receiveFile(
            dc,
            key,
            (meta: TransferMetadata) => {
              currentFileName = meta.fileName;
              ui.onMetadata(meta);
            },
            (pct: number) => {
              ui.onTransferProgress(pct);
            }
          ).then((blob) => {
            ui.onTransferComplete(blob, currentFileName);
          });
        } else {
          // No key — transport-only encryption, still receive but without extra AES layer
          // For simplicity, we create a dummy key that just passes through
          // In a real scenario, we'd skip the encrypt/decrypt steps
          dc.onmessage = handleRawReceive(ui);
        }
      };

      await pc.setRemoteDescription(new RTCSessionDescription(p));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      signaling.send("ANSWER", { sdp: answer.sdp, type: answer.type });
    });

    signaling.on("ICE_CANDIDATE", async (payload: unknown) => {
      const p = payload as { candidate: RTCIceCandidateInit };
      if (pc) {
        await pc.addIceCandidate(new RTCIceCandidate(p.candidate));
      }
    });

    signaling.on("TRANSFER_COMPLETE", () => {
      // Signaling-level notification (data channel handles actual completion)
    });

    signaling.on("DISCONNECT", () => {
      cleanup();
      ui.onSessionEnded();
    });

    signaling.on("ROOM_EXPIRED", () => {
      showToast(
        "This transfer session expired.",
        "error"
      );
      cleanup();
      ui.onSessionEnded();
    });

    signaling.on("ERROR", (payload: unknown) => {
      const p = payload as { code: string; message: string } | undefined;
      const msg = p?.message ?? "Connection error.";
      if (p?.code === "PEER_DISCONNECTED") {
        showToast("The sender disconnected.", "info");
      } else {
        showToast(msg, "error");
      }
      cleanup();
      ui.onSessionEnded();
    });

    signaling.on("CLOSE", () => {
      // WebSocket closed
    });
  } catch {
    showToast(
      "That code doesn't match any active transfer. Check the code and try again.",
      "error"
    );
    container.innerHTML = `
      <div class="min-h-screen flex items-center justify-center">
        <div class="text-center">
          <p class="text-warning mb-4">Room not found</p>
          <a href="/" class="btn-primary">Go Home</a>
        </div>
      </div>
    `;
  }

  function cleanup() {
    pc?.close();
    signaling.disconnect();
    pc = null;
  }
}

// Handle receiving without AES key (transport-only encryption)
function handleRawReceive(ui: ReturnType<typeof createReceiverUI>) {
  let metadata: TransferMetadata | null = null;
  const chunks: ArrayBuffer[] = [];
  let received = 0;

  return (e: MessageEvent) => {
    if (typeof e.data === "string") {
      const msg = JSON.parse(e.data);
      if (msg.type === "METADATA") {
        metadata = msg.payload as TransferMetadata;
        ui.onMetadata(metadata);
      } else if (msg.type === "TRANSFER_COMPLETE" && metadata) {
        const blob = new Blob(chunks, { type: metadata.fileType });
        ui.onTransferComplete(blob, metadata.fileName);
        // Reset for next file
        metadata = null;
        chunks.length = 0;
        received = 0;
      }
    } else if (e.data instanceof ArrayBuffer && metadata) {
      // No decryption needed — raw chunks
      chunks.push(e.data);
      received++;
      ui.onTransferProgress(
        Math.round((received / metadata.totalChunks) * 100)
      );
    }
  };
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1024 * 1024)
    return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}
