export async function generateKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

export async function exportKeyToBase64(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
}

export async function importKeyFromBase64(b64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptChunk(
  chunk: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array
): Promise<ArrayBuffer> {
  return crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as unknown as BufferSource }, key, chunk as unknown as BufferSource);
}

export async function decryptChunk(
  chunk: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array
): Promise<Uint8Array> {
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    chunk as unknown as BufferSource
  );
  return new Uint8Array(decrypted);
}
