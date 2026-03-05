import { Env } from "./types";

interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

interface TurnCredentials {
  iceServers: IceServer[];
  ttl: number;
}

interface TurnApiResponse {
  iceServers: IceServer | IceServer[];
}

function normalizeIceServers(input: IceServer[]): IceServer[] {
  const normalized: IceServer[] = [];
  const seen = new Set<string>();

  for (const server of input) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);

      if (url.startsWith("stun:")) {
        // STUN does not need credentials.
        normalized.push({ urls: url });
      } else {
        normalized.push({
          urls: url,
          username: server.username,
          credential: server.credential,
        });
      }
    }
  }

  if (!seen.has("stun:stun.cloudflare.com:3478")) {
    normalized.unshift({ urls: "stun:stun.cloudflare.com:3478" });
  }

  return normalized;
}

export async function getTurnCredentials(env: Env): Promise<TurnCredentials> {
  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${env.CF_CALLS_APP_ID}/credentials/generate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_CALLS_APP_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: 86400 }), // 24h credential TTL
    }
  );

  if (!response.ok) {
    throw new Error(`TURN credential fetch failed: ${response.status}`);
  }

  const data = await response.json() as TurnApiResponse;
  const turnServers = Array.isArray(data.iceServers)
    ? data.iceServers
    : [data.iceServers];

  return {
    iceServers: normalizeIceServers(turnServers),
    ttl: 86400,
  };
}
