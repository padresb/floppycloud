import { encryptChunk, decryptChunk } from "./crypto";
import type { TransferMetadata } from "../types";

const CHUNK_SIZE = 65536; // 64KB

export async function sendFile(
  file: File,
  dataChannel: RTCDataChannel,
  cryptoKey: CryptoKey,
  onProgress: (pct: number) => void
): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  const metadata: TransferMetadata = {
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type,
    totalChunks,
    iv: btoa(String.fromCharCode(...iv)),
  };

  await waitForChannelOpen(dataChannel);

  // Send metadata as JSON string first
  dataChannel.send(JSON.stringify({ type: "METADATA", payload: metadata }));

  const buffer = await file.arrayBuffer();
  for (let i = 0; i < totalChunks; i++) {
    const chunk = buffer.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    const encrypted = await encryptChunk(
      new Uint8Array(chunk),
      cryptoKey,
      iv
    );

    // Simple flow control — wait if buffer is backing up
    while (dataChannel.bufferedAmount > CHUNK_SIZE * 8) {
      await new Promise((r) => setTimeout(r, 10));
    }

    dataChannel.send(encrypted);
    onProgress(Math.round(((i + 1) / totalChunks) * 100));
  }

  dataChannel.send(JSON.stringify({ type: "TRANSFER_COMPLETE" }));
}

export async function receiveFile(
  dataChannel: RTCDataChannel,
  cryptoKey: CryptoKey,
  onMetadata: (meta: TransferMetadata) => void,
  onProgress: (pct: number) => void
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    let metadata: TransferMetadata | null = null;
    const chunks: ArrayBuffer[] = [];
    let received = 0;
    let iv: Uint8Array;

    dataChannel.onmessage = async (e) => {
      if (typeof e.data === "string") {
        const msg = JSON.parse(e.data);
        if (msg.type === "METADATA") {
          metadata = msg.payload as TransferMetadata;
          iv = Uint8Array.from(atob(metadata.iv), (c) => c.charCodeAt(0));
          onMetadata(metadata);
        } else if (msg.type === "TRANSFER_COMPLETE" && metadata) {
          const blob = new Blob(chunks, { type: metadata.fileType });
          resolve(blob);
        }
      } else if (e.data instanceof ArrayBuffer && metadata) {
        const decrypted = await decryptChunk(
          new Uint8Array(e.data),
          cryptoKey,
          iv!
        );
        chunks.push(decrypted.buffer as ArrayBuffer);
        received++;
        onProgress(Math.round((received / metadata.totalChunks) * 100));
      }
    };

    dataChannel.onerror = (e) => reject(e);
  });
}

function waitForChannelOpen(dc: RTCDataChannel): Promise<void> {
  if (dc.readyState === "open") return Promise.resolve();
  return new Promise((resolve) => {
    dc.onopen = () => resolve();
  });
}
