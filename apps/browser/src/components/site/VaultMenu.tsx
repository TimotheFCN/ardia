import { useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { usePage } from "../../state/tabs/pageState";
import { useTabValue } from "../../state/tabs/tabWatch";
import { closeVaultMenu, loginKey, vaultMenuFill, vaultMenuGenerate, vaultMenuLock, vaultMenuManage, vaultMenuUnlock, type VaultMenu as Menu } from "../../state/vaults/menu";
import { searchLogins, type VaultLogin } from "../../state/vaults/search";
import { Box, Button, MenuRow, MenuSeparator, PANEL, Popover, POPOVER_MARGIN, SearchField, Symbol, Text, useTheme } from "../ui";
import { Favicon } from "../favicon/Favicon";
import { vaultMenu as tokens } from "./tokens";

type Entry = { key: string; run: () => void };

export function VaultMenu({ tabId }: { tabId: string }) {
  const menu = usePage(tabId, (p) => p.vaultMenu);
  const zoom = useTabValue(tabId, (t) => t?.zoom ?? 1);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [height, setHeight] = useState(0);
  if (!menu) return null;
  const place = placement(menu, zoom, area, height);
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill} onLayout={(e) => setArea(e.nativeEvent.layout)}>
      {area.width > 0 ? (
        <Popover key={menu.id} width={tokens.width} {...place} onDismiss={() => closeVaultMenu(tabId)}>
          <View onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
            <MenuBody tabId={tabId} menu={menu} />
          </View>
        </Popover>
      ) : null}
    </View>
  );
}

export function placement(menu: Pick<Menu, "anchor">, zoom: number, area: { width: number; height: number }, height: number): { top: number; left?: number; right?: number } {
  const a = menu.anchor;
  if (!a) return { top: POPOVER_MARGIN, right: POPOVER_MARGIN };
  const left = Math.max(POPOVER_MARGIN, Math.min(a.x * zoom, area.width - tokens.width - POPOVER_MARGIN));
  const below = (a.y + a.height) * zoom + tokens.gap;
  const above = a.y * zoom - tokens.gap - height;
  const fitsBelow = below + (height || tokens.roomBelow) <= area.height - POPOVER_MARGIN;
  return { left, top: fitsBelow || above < POPOVER_MARGIN ? Math.max(POPOVER_MARGIN, Math.min(below, area.height - POPOVER_MARGIN - height)) : above };
}

export function MenuBody({ tabId, menu }: { tabId: string; menu: Menu }) {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const many = menu.unlocked.length + menu.locked.length > 1;
  const results = useMemo(() => {
    if (!query.trim()) return null;
    const found = searchLogins(menu.all, query);
    const matching = new Set(menu.sections.flatMap((s) => s.logins.map(loginKey)));
    return [...found].sort((a, b) => Number(matching.has(loginKey(b))) - Number(matching.has(loginKey(a))));
  }, [menu, query]);
  const shown = results ? results.slice(0, tokens.maxResults) : null;
  const sections = shown ? [{ name: null, logins: shown }] : menu.sections;

  const entries: Entry[] = [
    ...sections.flatMap((s) => s.logins.map((x) => ({ key: loginKey(x), run: () => void vaultMenuFill(tabId, loginKey(x)) }))),
    ...menu.locked.map((l) => ({ key: `unlock:${l.account}`, run: () => void vaultMenuUnlock(tabId, l.account) })),
    ...(menu.generate ? [{ key: "generate", run: () => void vaultMenuGenerate(tabId) }] : []),
  ];
  const at = Math.min(highlight, Math.max(0, entries.length - 1));
  const lit = entries[at]?.key;
  const step = (by: number) => entries.length && setHighlight((at + by + entries.length) % entries.length);

  const row = (x: VaultLogin) => (
    <MenuRow
      key={loginKey(x)}
      leading={x.site ? <Favicon url={x.site} size={tokens.icon} /> : <Symbol name="key" size={PANEL.iconSize} color={theme.icon} />}
      title={x.title}
      detail={[x.username || "No username", results && many ? menu.names[x.space.account] : null].filter(Boolean).join(" · ")}
      selected={lit === loginKey(x)}
      minHeight={tokens.loginRow}
      onPress={() => void vaultMenuFill(tabId, loginKey(x))}
    />
  );

  return (
    <View style={{ paddingVertical: PANEL.rowInset }}>
      <Box row gap="s" style={[HEADER, { paddingHorizontal: PANEL.inset }]}>
        <Symbol name="key.fill" size={PANEL.iconSize} color={theme.icon} style={ICON} />
        <Text weight="semibold" numberOfLines={1} style={FLEX}>
          {menu.title}
        </Text>
        <Text size="small" tone="textSecondary" numberOfLines={1} style={SHRINK}>
          {menu.host}
        </Text>
      </Box>
      <View style={{ paddingHorizontal: PANEL.inset, paddingBottom: PANEL.rowInset }}>
        <SearchField
          value={query}
          onChangeText={(text) => {
            setQuery(text);
            setHighlight(0);
          }}
          placeholder={`Search ${menu.title}`}
          autoFocus
          onArrow={step}
          onSubmit={() => entries[at]?.run()}
          onEscape={() => closeVaultMenu(tabId)}
        />
      </View>
      <ScrollView style={{ maxHeight: tokens.listHeight }}>
        {sections.map((s, i) => (
          <View key={s.name ?? `s${i}`}>
            {s.name && sections.length > 1 ? <Caption>{s.name}</Caption> : null}
            {s.logins.map(row)}
          </View>
        ))}
        {!sections.length ? <Caption>{emptyWords(menu, query)}</Caption> : null}
        {results && results.length > tokens.maxResults ? <Caption>{`${results.length - tokens.maxResults} more. Keep typing to narrow them down.`}</Caption> : null}
      </ScrollView>
      {menu.locked.length || menu.generate ? <MenuSeparator /> : null}
      {menu.locked.map((l) => (
        <MenuRow
          key={l.account}
          icon="lock.open"
          iconColor={theme.accent}
          title={`Unlock ${many ? l.name : menu.title}`}
          detail={many ? undefined : l.name}
          selected={lit === `unlock:${l.account}`}
          onPress={() => void vaultMenuUnlock(tabId, l.account)}
        />
      ))}
      {menu.generate ? (
        <MenuRow
          icon="wand.and.stars"
          iconColor={theme.accent}
          title="Use Strong Password"
          detail={`Fill a new password and save it to ${menu.title}`}
          selected={lit === "generate"}
          onPress={() => void vaultMenuGenerate(tabId)}
        />
      ) : null}
      <MenuSeparator />
      <Box row gap="s" style={[FOOTER, { paddingHorizontal: PANEL.inset }]}>
        <Button title="Manage Passwords…" kind="plain" onPress={() => vaultMenuManage(tabId)} />
        <View style={FLEX} />
        {menu.unlocked.length ? <Button variant="icon" icon="lock" size="m" tooltip={many ? `Lock All ${menu.title} Accounts` : `Lock ${menu.title}`} onPress={() => void vaultMenuLock(tabId)} /> : null}
      </Box>
    </View>
  );
}

function emptyWords(menu: Menu, query: string): string {
  if (query.trim()) return `No logins match “${query.trim()}”`;
  if (!menu.unlocked.length) return `Unlock ${menu.title} to see your logins`;
  return `No logins for ${menu.host}. Search to find one.`;
}

function Caption({ children }: { children: string }) {
  return (
    <Text size="caption" tone="textSecondary" numberOfLines={2} style={[CAPTION, { paddingHorizontal: PANEL.inset }]}>
      {children}
    </Text>
  );
}

const FLEX = { flex: 1 } as const;
const SHRINK = { flexShrink: 1 } as const;
const ICON = { width: PANEL.iconSlot, height: PANEL.iconSlot } as const;
const HEADER = { alignItems: "center", paddingBottom: PANEL.rowInset, paddingTop: PANEL.rowInset } as const;
const FOOTER = { alignItems: "center", paddingTop: PANEL.rowInset } as const;
const CAPTION = { paddingVertical: PANEL.rowInset } as const;
