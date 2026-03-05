import { Env } from "./types";

export async function checkRateLimit(
  env: Env,
  ip: string,
  action: string,
  limit: number,
  windowSeconds: number
): Promise<boolean> {
  const key = `rl:${action}:${ip}:${Math.floor(Date.now() / (windowSeconds * 1000))}`;
  const current = await env.RATE_LIMIT_KV.get(key);
  const count = current ? parseInt(current) : 0;
  return count >= limit;
}

export async function recordRequest(
  env: Env,
  ip: string,
  action: string,
  windowSeconds: number = 60
): Promise<void> {
  const key = `rl:${action}:${ip}:${Math.floor(Date.now() / (windowSeconds * 1000))}`;
  const current = await env.RATE_LIMIT_KV.get(key);
  const count = current ? parseInt(current) : 0;
  await env.RATE_LIMIT_KV.put(key, String(count + 1), {
    expirationTtl: windowSeconds * 2,
  });
}
