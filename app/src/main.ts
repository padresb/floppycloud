import "./styles/global.css";
import { isValidPhrase } from "./lib/phrase";
import { renderHomePage } from "./pages/home";
import { renderRoomPage } from "./pages/room";

function router(): void {
  const app = document.getElementById("app");
  if (!app) return;

  const path = window.location.pathname.replace(/^\/+|\/+$/g, "");

  if (path === "") {
    renderHomePage(app);
  } else if (isValidPhrase(path)) {
    renderRoomPage(app, path);
  } else {
    render404(app);
  }
}

function render404(container: HTMLElement): void {
  container.innerHTML = `
    <div class="min-h-screen flex items-center justify-center">
      <div class="text-center">
        <h1 class="font-heading text-6xl text-muted mb-4">404</h1>
        <p class="text-muted text-sm mb-6">Page not found</p>
        <a href="/" class="btn-primary inline-block">Go Home</a>
      </div>
    </div>
  `;
}

// Initial route
router();

// Handle browser back/forward and pushState navigation
window.addEventListener("popstate", router);
