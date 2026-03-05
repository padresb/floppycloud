export async function getIceConfig(): Promise<RTCConfiguration> {
  const apiUrl: string = import.meta.env.VITE_API_URL ?? "";
  const res = await fetch(`${apiUrl}/api/turn`);
  if (!res.ok) {
    // Fallback to public STUN only
    return {
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
      iceCandidatePoolSize: 10,
    };
  }
  const { iceServers } = await res.json();
  return { iceServers, iceCandidatePoolSize: 10 };
}

export function createPeerConnection(
  config: RTCConfiguration,
  onIceCandidate: (candidate: RTCIceCandidate) => void
): RTCPeerConnection {
  const pc = new RTCPeerConnection(config);

  pc.onicecandidate = (e) => {
    if (e.candidate) onIceCandidate(e.candidate);
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === "failed") {
      pc.restartIce();
    }
  };

  return pc;
}
