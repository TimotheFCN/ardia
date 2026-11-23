import { create } from "zustand";

const CHUNK = 8;

const useSettingsScroll = create<{ offset: number; viewport: number }>()(() => ({ offset: 0, viewport: 800 }));

export const noteSettingsOffset = (offset: number, viewport: number) => useSettingsScroll.setState({ offset, viewport });

export const noteSettingsViewport = (viewport: number) => useSettingsScroll.setState({ viewport });

export function firstRowOf(offset: number, viewport: number, top: number, rowHeight: number, count: number): number {
  const above = Math.floor((offset - top - viewport / 2) / rowHeight);
  return Math.max(0, Math.min(Math.floor(above / CHUNK) * CHUNK, count - 1));
}

export const rowSpan = (viewport: number, rowHeight: number) => Math.ceil((2 * viewport) / rowHeight) + CHUNK;

export function useSettingsWindow(top: number | null, rowHeight: number, count: number): { first: number; shown: number } {
  const viewport = useSettingsScroll((s) => s.viewport);
  const first = useSettingsScroll((s) => (top === null ? 0 : firstRowOf(s.offset, s.viewport, top, rowHeight, count)));
  return { first, shown: Math.max(0, Math.min(count - first, rowSpan(viewport, rowHeight))) };
}
