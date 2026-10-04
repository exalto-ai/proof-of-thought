/**
 * Say something happened, where the person is already looking. Errors
 * linger; confirmations do not.
 */
export function installToast(
  toast: HTMLElement,
): (message: string, kind?: "info" | "error") => void {
  let timer: number | null = null;
  return (message, kind = "info") => {
    toast.textContent = message;
    toast.dataset.kind = kind;
    toast.hidden = false;
    if (timer !== null) clearTimeout(timer);
    timer = window.setTimeout(() => (toast.hidden = true), kind === "error" ? 6000 : 2600);
  };
}

/** Whatever an unknown throw carries, said in one line of at most `max` characters. */
export function oneLine(error: unknown, fallback: string, max = 180): string {
  const text = (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  if (!text) return fallback;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
