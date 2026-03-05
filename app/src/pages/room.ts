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
  let chatChannel: RTCDataChannel | null = null;
  let cryptoKey: CryptoKey;
  let transferStartTime = 0;
  let lastProgressBytes = 0;
  const pendingSenderCandidates: RTCIceCandidateInit[] = [];
  let senderConnectFailedShown = false;

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

          let lastProgressTime = 0;

          await sendFile(file, dataChannel, cryptoKey, (pct) => {
            const now = Date.now();
            const bytesTransferred = (pct / 100) * file.size;
            let speedStr = undefined;

            // Only recalculate speed every 500ms for stable readouts
            if (lastProgressTime === 0 || now - lastProgressTime > 500) {
              if (lastProgressTime !== 0) {
                const elapsed = (now - lastProgressTime) / 1000;
                const speedBytes = (bytesTransferred - lastProgressBytes) / elapsed;
                speedStr = formatSpeed(speedBytes);
              }
              lastProgressBytes = bytesTransferred;
              lastProgressTime = now;
            }

            ui.onTransferProgress(pct, speedStr);
          });

          signaling.send("TRANSFER_COMPLETE");
          const elapsedSeconds = (Date.now() - transferStartTime) / 1000;
          ui.onTransferComplete(file.name, elapsedSeconds, true);
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
    console.log("[sender] WebSocket connected");

    // Log all incoming signaling messages
    signaling.on("*", (msg: unknown) => {
      console.log("[sender] signal received:", msg);
    });

    // Handle signaling events
    signaling.on("PEER_JOINED", async () => {
      try {
        console.log("[sender] PEER_JOINED received");
        ui.onPeerJoined();

        // Set up WebRTC
        const iceConfig = await getIceConfig();
        console.log("[sender] ICE config:", iceConfig);
        pc = createPeerConnection(iceConfig, (candidate) => {
          console.log("[sender] sending ICE candidate");
          signaling.send("ICE_CANDIDATE", {
            candidate: candidate.toJSON(),
          });
        });

        pc.oniceconnectionstatechange = () => {
          console.log("[sender] ICE state:", pc?.iceConnectionState);
        };
        pc.onconnectionstatechange = () => {
          console.log("[sender] connection state:", pc?.connectionState);
          if (
            !senderConnectFailedShown &&
            pc?.connectionState === "failed"
          ) {
            senderConnectFailedShown = true;
            showToast(
              "Could not establish secure channel. Ask receiver to reconnect.",
              "error"
            );
          }
          if (pc?.connectionState === "connected") {
            pc.getStats().then((stats) => {
              let isRelay = false;
              stats.forEach((report: any) => {
                if (report.type === "candidate-pair" && report.nominated) {
                  const local = stats.get(report.localCandidateId);
                  if ((local as any)?.candidateType === "relay") {
                    isRelay = true;
                  }
                }
              });
              console.log("[sender] connection type:", isRelay ? "TURN relay" : "direct P2P");
              ui.onConnectionType(isRelay);
            });
          }
        };

        // Create data channel
        dataChannel = pc.createDataChannel("fileTransfer", {
          ordered: true,
        });
        dataChannel.binaryType = "arraybuffer";
        dataChannel.onopen = () => {
          console.log("[sender] data channel OPEN");
          dataChannel!.send(JSON.stringify({ type: "KEY_RELAY", key: keyBase64 }));
          ui.onChannelReady();
        };
        dataChannel.onclose = () => {
          console.log("[sender] data channel CLOSED");
        };
        dataChannel.onerror = (e) => {
          console.error("[sender] data channel error:", e);
        };

        // Create chat channel
        chatChannel = pc.createDataChannel("chat", { ordered: true });
        chatChannel.onopen = () => {
          console.log("[sender] chat channel OPEN");
          ui.onChatReady(
            (text) => chatChannel?.send(JSON.stringify({ type: "CHAT", text })),
            () => chatChannel?.send(JSON.stringify({ type: "TYPING" }))
          );
        };
        chatChannel.onmessage = (e) => {
          try {
            const msg = JSON.parse(e.data as string);
            if (msg.type === "CHAT") ui.onChatMessage(msg.text as string);
            else if (msg.type === "TYPING") ui.onTyping();
          } catch { }
        };

        // Create and send offer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        console.log("[sender] sending OFFER");
        signaling.send("OFFER", { sdp: offer.sdp, type: offer.type });
      } catch (err) {
        console.error("[sender] failed to initialize peer connection:", err);
        showToast("Failed to establish connection. Please retry.", "error");
      }
    });

    signaling.on("ANSWER", async (payload: unknown) => {
      console.log("[sender] ANSWER received");
      const p = payload as { sdp: string; type: RTCSdpType };
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(p));
        console.log("[sender] remote description set");
        for (const candidate of pendingSenderCandidates.splice(0)) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
      }
    });

    signaling.on("ICE_CANDIDATE", async (payload: unknown) => {
      console.log("[sender] ICE_CANDIDATE received");
      const p = payload as { candidate: RTCIceCandidateInit };
      if (pc) {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(p.candidate));
        } else {
          pendingSenderCandidates.push(p.candidate);
        }
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
      chatChannel?.close();
      dataChannel?.close();
      pc?.close();
      signaling.disconnect();
      pc = null;
      dataChannel = null;
      chatChannel = null;
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
  let receiveStartTime = 0;
  const pendingReceiverCandidates: RTCIceCandidateInit[] = [];
  let receiverConnectFailedShown = false;

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
    onLeave: () => {
      cleanup();
      window.location.href = "/";
    },
  });

  try {
    // Connect WebSocket
    await signaling.connect(phrase, "receiver");
    console.log("[receiver] WebSocket connected");
    ui.onConnecting();

    // Log all incoming signaling messages
    signaling.on("*", (msg: unknown) => {
      console.log("[receiver] signal received:", msg);
    });

    // Handle signaling events
    signaling.on("OFFER", async (payload: unknown) => {
      try {
        console.log("[receiver] OFFER received");
        const p = payload as { sdp: string; type: RTCSdpType };

        const iceConfig = await getIceConfig();
        console.log("[receiver] ICE config:", iceConfig);
        pc = createPeerConnection(iceConfig, (candidate) => {
          console.log("[receiver] sending ICE candidate");
          signaling.send("ICE_CANDIDATE", {
            candidate: candidate.toJSON(),
          });
        });

        pc.oniceconnectionstatechange = () => {
          console.log("[receiver] ICE state:", pc?.iceConnectionState);
        };
        pc.onconnectionstatechange = () => {
          console.log("[receiver] connection state:", pc?.connectionState);
          if (
            !receiverConnectFailedShown &&
            pc?.connectionState === "failed"
          ) {
            receiverConnectFailedShown = true;
            showToast(
              "Could not establish secure channel. Reopen the sender link and try again.",
              "error"
            );
          }
        };

        // Listen for data channel
        pc.ondatachannel = (event) => {
          const dc = event.channel;

          // Chat channel — handle separately from file transfer
          if (dc.label === "chat") {
            dc.onopen = () => {
              console.log("[receiver] chat channel OPEN");
              ui.onChatReady(
                (text) => dc.send(JSON.stringify({ type: "CHAT", text })),
                () => dc.send(JSON.stringify({ type: "TYPING" }))
              );
            };
            dc.onmessage = (e) => {
              try {
                const msg = JSON.parse(e.data as string);
                if (msg.type === "CHAT") ui.onChatMessage(msg.text as string);
                else if (msg.type === "TYPING") ui.onTyping();
              } catch { }
            };
            return;
          }

          console.log("[receiver] data channel received");
          dc.binaryType = "arraybuffer";

          dc.onopen = () => {
            console.log("[receiver] data channel OPEN");
          };

          // Capture whether key arrived via URL before any async ops
          const keyFromUrl = !!cryptoKey;

          // First message is always KEY_RELAY — sender sends it immediately on open.
          // If receiver already has a URL key we use that; otherwise we import the relayed key.
          dc.onmessage = async (event) => {
            if (typeof event.data === "string") {
              try {
                const msg = JSON.parse(event.data) as { type: string; key?: string };
                if (msg.type === "KEY_RELAY") {
                  if (!cryptoKey) {
                    if (!msg.key) {
                      showToast("Missing encryption key.", "error");
                      dc.onmessage = () => { };
                      return;
                    }
                    cryptoKey = await importKeyFromBase64(msg.key);
                  }
                  const key = cryptoKey;
                  ui.onConnected(keyFromUrl);
                  let currentFileName = "";
                  let currentFileSize = 0;
                  let lastProgressTime = 0;
                  let lastProgressBytes = 0;

                  receiveFile(
                    dc,
                    key,
                    (meta: TransferMetadata) => {
                      currentFileName = meta.fileName;
                      currentFileSize = meta.fileSize;
                      receiveStartTime = Date.now();
                      ui.onMetadata(meta);
                    },
                    (pct: number) => {
                      const now = Date.now();
                      const bytesTransferred = (pct / 100) * currentFileSize;
                      let speedStr = undefined;

                      // Only recalculate speed every 500ms for stable readouts
                      if (lastProgressTime === 0 || now - lastProgressTime > 500) {
                        if (lastProgressTime !== 0) {
                          const elapsed = (now - lastProgressTime) / 1000;
                          const speedBytes = (bytesTransferred - lastProgressBytes) / Math.max(elapsed, 0.001);
                          speedStr = formatSpeed(speedBytes);
                        }
                        lastProgressBytes = bytesTransferred;
                        lastProgressTime = now;
                      }

                      ui.onTransferProgress(pct, speedStr);
                    }
                  ).then((blob) => {
                    const elapsedSeconds =
                      receiveStartTime > 0
                        ? (Date.now() - receiveStartTime) / 1000
                        : 0;
                    ui.onTransferComplete(blob, currentFileName, elapsedSeconds, keyFromUrl);
                  });
                  return;
                }
              } catch { }
            }
            showToast("Unexpected message from sender.", "error");
            dc.onmessage = () => { };
          };
        };

        await pc.setRemoteDescription(new RTCSessionDescription(p));
        console.log("[receiver] remote description set");
        for (const candidate of pendingReceiverCandidates.splice(0)) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        console.log("[receiver] sending ANSWER");
        signaling.send("ANSWER", { sdp: answer.sdp, type: answer.type });
      } catch (err) {
        console.error("[receiver] failed to handle offer:", err);
        showToast("Failed to establish connection. Please retry.", "error");
      }
    });

    signaling.on("ICE_CANDIDATE", async (payload: unknown) => {
      const p = payload as { candidate: RTCIceCandidateInit };
      if (pc) {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(p.candidate));
        } else {
          pendingReceiverCandidates.push(p.candidate);
        }
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
