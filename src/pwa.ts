/**
 * Progressive Web App wiring: service-worker registration plus the explicit
 * "update available" prompt.
 *
 * The game is an installable, offline-capable PWA (see the VitePWA config in
 * vite.config.ts). We deliberately use `registerType: "prompt"`, so a freshly
 * deployed version never swaps in mid-play. Instead, when the service worker
 * finds an update it calls `onNeedRefresh`, and we show a small toast with a
 * Reload button; the new version only activates when the player accepts.
 *
 * The whole UI is drawn on a canvas, so this toast is the one deliberate bit of
 * DOM the game injects at runtime. It is styled to match the game (dark panel,
 * Baloo 2, green accent) and is dismissable.
 */
import { registerSW } from "virtual:pwa-register";

export function initPWA(): void {
  const updateSW = registerSW({
    onNeedRefresh() {
      showUpdateToast(() => updateSW(true));
    },
    onOfflineReady() {
      showToast("Ready to play offline ✨", { autoDismissMs: 3500 });
    },
  });
}

/** Toast with a Reload action that applies the waiting service worker. */
function showUpdateToast(onReload: () => void): void {
  showToast("A new version is available.", {
    actionLabel: "Reload",
    onAction: onReload,
  });
}

interface ToastOpts {
  actionLabel?: string;
  onAction?: () => void;
  autoDismissMs?: number;
}

function showToast(message: string, opts: ToastOpts = {}): void {
  // Only one toast at a time.
  document.getElementById("ngu-toast")?.remove();

  const toast = document.createElement("div");
  toast.id = "ngu-toast";
  Object.assign(toast.style, {
    position: "fixed",
    left: "50%",
    bottom: "max(16px, env(safe-area-inset-bottom))",
    transform: "translateX(-50%)",
    zIndex: "9999",
    display: "flex",
    alignItems: "center",
    gap: "14px",
    maxWidth: "min(92vw, 420px)",
    padding: "12px 16px",
    borderRadius: "14px",
    background: "rgba(18,24,54,0.96)",
    border: "1px solid rgba(120,150,255,0.35)",
    boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
    color: "#eaf0ff",
    font: "600 15px 'Baloo 2', system-ui, sans-serif",
    // The game disables text selection / touch actions globally; keep the toast
    // interactive.
    touchAction: "auto",
    userSelect: "none",
  } as CSSStyleDeclaration);

  const text = document.createElement("span");
  text.textContent = message;
  text.style.flex = "1";
  toast.appendChild(text);

  if (opts.actionLabel && opts.onAction) {
    const btn = document.createElement("button");
    btn.textContent = opts.actionLabel;
    Object.assign(btn.style, {
      appearance: "none",
      border: "none",
      cursor: "pointer",
      padding: "8px 16px",
      borderRadius: "10px",
      background: "#7CF29B",
      color: "#08240f",
      font: "700 15px 'Baloo 2', system-ui, sans-serif",
    } as CSSStyleDeclaration);
    btn.addEventListener("click", () => {
      toast.remove();
      opts.onAction!();
    });
    toast.appendChild(btn);
  }

  // Dismiss "×"
  const close = document.createElement("button");
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "✕";
  Object.assign(close.style, {
    appearance: "none",
    border: "none",
    cursor: "pointer",
    background: "transparent",
    color: "rgba(234,240,255,0.6)",
    font: "700 15px 'Baloo 2', system-ui, sans-serif",
    padding: "4px",
  } as CSSStyleDeclaration);
  close.addEventListener("click", () => toast.remove());
  toast.appendChild(close);

  document.body.appendChild(toast);

  if (opts.autoDismissMs) {
    setTimeout(() => toast.remove(), opts.autoDismissMs);
  }
}
