export function createProgressBar(mode: "SENDING" | "RECEIVING" = "SENDING"): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.className = "w-full flex items-center gap-6 py-4";

  wrapper.innerHTML = `
    <div class="cyber-circle">
      <div class="cyber-circle-inner text-accent font-heading text-xl progress-pct glow-green">0%</div>
      <div class="cyber-circle-ring"></div>
    </div>
    <div class="flex-1 flex flex-col justify-center">
      <div class="flex justify-between text-xs font-mono text-accent mb-2 px-1 tracking-widest glow-green">
        <span class="progress-label">${mode}...</span>
        <span class="progress-speed w-[100px] text-right"></span>
      </div>
      <div class="cyber-track-wrapper">
        <div class="cyber-bar-track">
          <div class="progress-fill" style="width: 0%"></div>
        </div>
      </div>
    </div>
  `;

  return wrapper;
}

export function updateProgress(
  element: HTMLDivElement,
  percent: number,
  speed?: string
): void {
  const fill = element.querySelector(".progress-fill") as HTMLDivElement;
  const pct = element.querySelector(".progress-pct") as HTMLSpanElement;
  const spd = element.querySelector(".progress-speed") as HTMLSpanElement;

  if (fill) fill.style.width = `${percent}%`;

  if (pct) {
    const text = `${percent}%`;
    if (pct.textContent !== text) pct.textContent = text;
  }

  if (spd && speed) {
    const now = Date.now();
    const lastUpdate = parseInt(spd.dataset.lastUpdate || "0", 10);

    if (percent === 100 || now - lastUpdate > 500) {
      if (spd.textContent !== speed) {
        spd.textContent = speed;
        spd.dataset.lastUpdate = now.toString();
      }
    }
  }

  if (percent >= 100 && fill) {
    fill.classList.add("complete");
  }
}

export function resetProgress(element: HTMLDivElement): void {
  const fill = element.querySelector(".progress-fill") as HTMLDivElement;
  const pct = element.querySelector(".progress-pct") as HTMLSpanElement;
  const spd = element.querySelector(".progress-speed") as HTMLSpanElement;

  if (fill) {
    fill.style.width = "0%";
    fill.classList.remove("complete");
  }
  if (pct) pct.textContent = "0%";
  if (spd) spd.textContent = "";
}
