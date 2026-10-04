/**
 * The app-wide Settings window. Opened from Proof of Thought → Settings… (⌘,);
 * there is only ever one.
 *
 * Preferences here live in shared local storage, so open document windows
 * follow a change through the `storage` event. This window holds no state of
 * its own.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { safeLocalStorage } from "./ai-support";
import {
  applyTheme,
  installTheme,
  isThemePreference,
  readTheme,
  writeTheme,
  type ThemePreference,
} from "./theme";

const storage = safeLocalStorage(window);
const isTauri = Boolean(
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
);
const nativeWindow = isTauri ? getCurrentWindow() : null;

function required<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`missing settings element: ${selector}`);
  return value;
}

const toast = required<HTMLElement>("#toast");
let toastTimer: number | null = null;
function notify(message: string, kind: "info" | "error" = "info") {
  toast.textContent = message;
  toast.dataset.kind = kind;
  toast.hidden = false;
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.hidden = true), kind === "error" ? 6000 : 2600);
}

// ---------------------------------------------------------------- theme

installTheme(storage, nativeWindow);
const themeButtons = [
  ...document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]"),
];

function renderTheme(theme: ThemePreference) {
  for (const button of themeButtons) {
    const checked = button.dataset.themeChoice === theme;
    button.setAttribute("aria-checked", String(checked));
    button.tabIndex = checked ? 0 : -1;
  }
}

function chooseTheme(theme: ThemePreference) {
  if (!writeTheme(storage, theme)) {
    notify("The theme changed, but could not be saved for next launch.", "error");
  }
  applyTheme(document.documentElement, theme, nativeWindow);
  renderTheme(theme);
}

for (const [index, button] of themeButtons.entries()) {
  button.addEventListener("click", () => {
    const value = button.dataset.themeChoice;
    if (isThemePreference(value)) chooseTheme(value);
  });
  button.addEventListener("keydown", (event) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown"
      ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? -1
        : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = themeButtons[(index + step + themeButtons.length) % themeButtons.length];
    next.focus();
    next.click();
  });
}
renderTheme(readTheme(storage));
window.addEventListener("storage", () => renderTheme(readTheme(storage)));
