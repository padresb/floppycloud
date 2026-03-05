export function createProgressBar(): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.className = "w-full";

  const info = document.createElement("div");
  info.className = "flex justify-between text-sm mb-1 font-mono";
  info.innerHTML = `
    <span class="progress-pct text-accent">0%</span>
    <span class="progress-speed text-muted"></span>
  `;

  const track = document.createElement("div");
  track.className = "progress-track";

  const fill = document.createElement("div");
  fill.className = "progress-fill";
  track.appendChild(fill);

  wrapper.appendChild(info);
  wrapper.appendChild(track);

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
  if (pct) pct.textContent = `${percent}%`;
  if (spd && speed) spd.textContent = speed;

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
