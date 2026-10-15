import type { FramingPreset } from "./vrm-scene";

export interface ViewConfig {
  framing: FramingPreset;
  distance: number | null;
}

export interface AppConfig {
  model: { name: string; file: string } | null;
  view: ViewConfig;
}

const tauri = (window as unknown as {
  __TAURI__?: { core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> } };
}).__TAURI__;

export const nativeStorage = !!tauri;
export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!tauri) return Promise.reject(new Error("Native storage is unavailable"));
  return tauri.core.invoke<T>(command, args);
}

export async function loadConfig(): Promise<AppConfig> {
  if (nativeStorage) return invoke<AppConfig>("load_config");
  const view = JSON.parse(localStorage.getItem("vessel-view") ?? "null") as ViewConfig | null;
  return { model: null, view: view ?? { framing: "bust", distance: null } };
}

// Preserve the order of rapid camera changes and recover after a failed write.
let pendingSave = Promise.resolve();
export function saveView(view: ViewConfig): Promise<void> {
  const result = pendingSave.then(async () => {
    if (nativeStorage) await invoke("save_view_config", { view });
    else localStorage.setItem("vessel-view", JSON.stringify(view));
  });
  pendingSave = result.catch(() => {});
  return result;
}
