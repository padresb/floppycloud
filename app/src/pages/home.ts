import { showToast } from "../ui/toast";

const FLOPPY_SVG = `<svg width="80" height="80" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg">
  <!-- Outer shell -->
  <rect x="8" y="4" width="64" height="72" rx="3" fill="#1A1A1A" stroke="#00FF87" stroke-width="2"/>
  <!-- Metal slider top -->
  <rect x="24" y="4" width="28" height="20" rx="1" fill="#0D0D0D" stroke="#333" stroke-width="1"/>
  <!-- Slider window -->
  <rect x="36" y="7" width="12" height="14" rx="1" fill="#1A1A1A"/>
  <!-- Label area -->
  <rect x="16" y="36" width="48" height="32" rx="2" fill="#00FF87" opacity="0.15" stroke="#00FF87" stroke-width="1"/>
  <!-- Label lines -->
  <line x1="22" y1="44" x2="58" y2="44" stroke="#00FF87" stroke-width="1" opacity="0.5"/>
  <line x1="22" y1="50" x2="50" y2="50" stroke="#00FF87" stroke-width="1" opacity="0.5"/>
  <line x1="22" y1="56" x2="44" y2="56" stroke="#00FF87" stroke-width="1" opacity="0.5"/>
  <!-- Corner notch -->
  <rect x="8" y="4" width="8" height="8" fill="#0D0D0D"/>
  <path d="M8 12 L16 4" stroke="#00FF87" stroke-width="2"/>
</svg>`;

export function renderHomePage(container: HTMLElement): void {
  container.innerHTML = `
    <div class="min-h-screen flex flex-col items-center justify-center px-4">
      <div class="text-center max-w-md mx-auto">
        <!-- Logo -->
        <div class="mb-6 flex justify-center">
          ${FLOPPY_SVG}
        </div>

        <!-- Title -->
        <h1 class="font-heading text-3xl text-accent glow-green mb-2 tracking-wider">floppy.cloud</h1>
        <p class="text-muted text-sm mb-10">No login. No storage. Secure direct transfers.</p>

        <!-- Primary CTA -->
        <button id="home-start-btn" class="btn-primary w-full mb-8">
          Start Transfer
        </button>

        <!-- Divider -->
        <div class="flex items-center gap-3 mb-6">
          <div class="flex-1 h-px bg-gray-800"></div>
          <span class="text-muted text-xs uppercase tracking-widest">or join</span>
          <div class="flex-1 h-px bg-gray-800"></div>
        </div>

        <!-- Phrase entry -->
        <div class="flex gap-2 mb-12">
          <input
            type="text"
            id="home-phrase-input"
            placeholder="golden \u00B7 harbor"
            class="flex-1 bg-surface border border-gray-700 rounded px-4 py-3 text-sm font-mono text-text placeholder-gray-600 focus:outline-none focus:border-accent transition-colors"
          />
          <button
            id="home-connect-btn"
            class="bg-surface border border-gray-700 rounded px-5 py-3 text-sm font-mono text-text hover:border-accent transition-colors"
          >Connect</button>
        </div>

        <!-- How it works -->
        <div class="text-left bg-surface rounded-lg border border-gray-800 p-6">
          <h2 class="font-heading text-sm text-accent uppercase tracking-widest mb-4">How it works</h2>
          <ol class="space-y-3 text-sm text-muted">
            <li class="flex gap-3">
              <span class="text-accent font-heading">1.</span>
              <span>Click <strong class="text-text">Start Transfer</strong> to get a unique phrase and link</span>
            </li>
            <li class="flex gap-3">
              <span class="text-accent font-heading">2.</span>
              <span>Share the link or read the phrase to your recipient</span>
            </li>
            <li class="flex gap-3">
              <span class="text-accent font-heading">3.</span>
              <span>Drop a file &mdash; it transfers directly, peer-to-peer, encrypted</span>
            </li>
          </ol>
          <p class="text-xs text-gray-600 mt-4">Sessions expire after 30 minutes of inactivity. Max file size: 2 GB.</p>
        </div>

        <!-- Footer -->
        <p class="text-gray-700 text-xs mt-8">floppy.cloud &mdash; files go direct</p>
      </div>
    </div>
  `;

  // Start Transfer button
  const startBtn = container.querySelector(
    "#home-start-btn"
  ) as HTMLButtonElement;
  startBtn.addEventListener("click", async () => {
    startBtn.disabled = true;
    startBtn.textContent = "Creating room...";

    try {
      const apiUrl: string = import.meta.env.VITE_API_URL ?? "";
      const res = await fetch(`${apiUrl}/api/rooms`, { method: "POST" });
      if (!res.ok) {
        if (res.status === 429) {
          showToast("Too many requests. Please wait a moment and try again.", "error");
        } else {
          showToast("Failed to create room. Try again.", "error");
        }
        startBtn.disabled = false;
        startBtn.textContent = "Start Transfer";
        return;
      }

      const { phrase } = await res.json();
      // Store ownership in sessionStorage
      sessionStorage.setItem("floppycloud_owned_phrase", phrase);
      // Navigate to room
      window.history.pushState({}, "", `/${phrase}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    } catch {
      showToast("Network error. Check your connection.", "error");
      startBtn.disabled = false;
      startBtn.textContent = "Start Transfer";
    }
  });

  // Connect button (receiver phrase entry)
  const connectBtn = container.querySelector(
    "#home-connect-btn"
  ) as HTMLButtonElement;
  const phraseInput = container.querySelector(
    "#home-phrase-input"
  ) as HTMLInputElement;

  function handleConnect() {
    const raw = phraseInput.value.trim().toLowerCase();
    // Normalize: allow "golden harbor", "golden · harbor", "golden-harbor"
    const phrase = raw
      .replace(/\s*\u00B7\s*/g, "-")
      .replace(/\s+/g, "-");

    if (!/^[a-z]+-[a-z]+$/.test(phrase) || phrase.length < 6) {
      showToast("Enter a valid two-word phrase (e.g. golden-harbor)", "error");
      return;
    }

    window.history.pushState({}, "", `/${phrase}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  connectBtn.addEventListener("click", handleConnect);
  phraseInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleConnect();
  });
}
