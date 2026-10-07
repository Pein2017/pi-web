import { isToolPreset, type ToolPreset } from "./tool-presets";

const STORAGE_KEY = "pi-tool-preset";
const DEFAULT_REVISION_KEY = "pi-tool-preset-default-revision";
const DEFAULT_REVISION = "full-20261006";
export const DEFAULT_TOOL_PRESET: ToolPreset = "full";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Apply the user's Full default once, including browsers with an old chat-only
 * preference. Later dropdown selections remain authoritative.
 */
export function getPreferredToolPreset(
  storage: StorageLike | null = getBrowserStorage(),
): ToolPreset {
  if (!storage) return DEFAULT_TOOL_PRESET;
  try {
    if (storage.getItem(DEFAULT_REVISION_KEY) !== DEFAULT_REVISION) {
      setPreferredToolPreset(DEFAULT_TOOL_PRESET, storage);
      return DEFAULT_TOOL_PRESET;
    }
    const value = storage.getItem(STORAGE_KEY);
    return isToolPreset(value) ? value : DEFAULT_TOOL_PRESET;
  } catch {
    return DEFAULT_TOOL_PRESET;
  }
}

export function setPreferredToolPreset(
  preset: ToolPreset,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, preset);
    storage.setItem(DEFAULT_REVISION_KEY, DEFAULT_REVISION);
  } catch {
    // Browser storage is best-effort.
  }
}
