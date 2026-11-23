import type { Space, VaultItem } from "./store";

export type VaultLogin = VaultItem & { space: Space; site: string | null; hay: string };

export function siteOf(uri: string): string | null {
  const text = uri.trim();
  if (!text) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export const indexLogin = (item: VaultItem, space: Space): VaultLogin => ({
  ...item,
  space,
  site: item.uris.map((u) => siteOf(u.uri)).find((s) => s !== null) ?? null,
  hay: [item.title, item.username, ...item.uris.map((u) => u.uri)].join("\n").toLowerCase(),
});

export function searchLogins(logins: readonly VaultLogin[], query: string): readonly VaultLogin[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? logins.filter((x) => words.every((w) => x.hay.includes(w))) : logins;
}
