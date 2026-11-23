import { useEffect, useMemo } from "react";
import { useBrowser } from "../browser/store";
import { slotOf, useVaults, vaultAccountOf, type Space, type VaultAccount, type VaultCapabilities } from "./store";
import { spaceAccounts, type AccountView } from "./accounts";
import { indexLogin, type VaultLogin } from "./search";

export const useVaultBase = (profileId: string) => useBrowser((s) => vaultAccountOf(s, profileId));

export const useVaultCapabilities = (plugin: string): VaultCapabilities | null => useVaults((s) => s.vaults[plugin]?.capabilities ?? null);

export const useVaultAccount = (space: Pick<Space, "plugin" | "account">): VaultAccount | null => useVaults((s) => s.vaults[space.plugin]?.accounts[space.account] ?? null);

export function useSpaceAccounts(plugin: string, title: string, base: string): { ready: boolean; views: AccountView[] } {
  const run = useVaults((s) => s.vaults[plugin]?.run);
  const accounts = useVaults((s) => s.vaults[plugin]?.accounts);
  useEffect(() => {
    if (run !== undefined) void spaceAccounts(plugin, title, base);
  }, [run, plugin, title, base]);
  const views = useMemo(
    () =>
      Object.entries(accounts ?? {})
        .filter(([id, a]) => slotOf(base, id) !== null && a.state !== null && a.state !== "signedOut")
        .sort(([a], [b]) => (slotOf(base, a) ?? 0) - (slotOf(base, b) ?? 0))
        .map(([account, a]) => ({ space: { plugin, title, account }, account: a })),
    [accounts, plugin, title, base],
  );
  return { ready: run !== undefined, views };
}

export function useVaultLogins(views: readonly AccountView[]): VaultLogin[] {
  return useMemo(() => views.flatMap((v) => (v.account.state === "unlocked" ? (v.account.items ?? []).map((x) => indexLogin(x, v.space)) : [])), [views]);
}
