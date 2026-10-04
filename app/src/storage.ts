/**
 * Guarded Web Storage access.
 *
 * Storage can be unavailable (blocked, private, quota exceeded), and every
 * preference kept there is a convenience: a failure must fall back to the
 * default rather than break the window.
 */

type StorageHost = {
  readonly localStorage: Storage;
  readonly sessionStorage?: Storage;
};

export function safeLocalStorage(target: StorageHost = window): Storage | null {
  try {
    return target.localStorage;
  } catch {
    return null;
  }
}

export function safeSessionStorage(target: StorageHost = window): Storage | null {
  try {
    return target.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function readItem(storage: Storage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Returns false when the value could not be saved. */
export function writeItem(storage: Storage | null, key: string, value: string): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
