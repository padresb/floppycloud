let container: HTMLDivElement | null = null;

function ensureContainer(): HTMLDivElement {
  if (container && document.body.contains(container)) return container;
  container = document.createElement("div");
  container.className = "toast-container";
  document.body.appendChild(container);
  return container;
}

export function showToast(
  message: string,
  type: "error" | "success" | "info" = "info"
): void {
  const parent = ensureContainer();

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  parent.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("toast-out");
    toast.addEventListener("animationend", () => toast.remove());
  }, 5000);
}
