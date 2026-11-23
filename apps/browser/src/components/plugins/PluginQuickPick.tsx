import { type ReactNode, useMemo, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import type { QuickPickItem } from "../../lib/pluginProtocol";
import { resolveQuickPick } from "../../state/plugins/actions";
import type { QuickPickRequest } from "../../state/plugins/surfaces";
import { Badge, Box, Button, Dialog, EmptyState, ListRow, SearchField, Symbol, Text, useTheme } from "../ui";
import { usePluginTitle } from "../../state/plugins/hooks";
import { OVERLAY, SURFACE } from "./tokens";
import { fuzzyFilter } from "./surfaceNodes";
import { assignSlots } from "../pages/historyLayout";

const itemFields = (item: QuickPickItem) => [item.title, item.subtitle, ...(item.keywords ?? [])];

const ROW = SURFACE.itemHeight;
const CHUNK = 8;

export const pickSpan = (viewport: number) => 2 * Math.ceil(viewport / ROW) + CHUNK;
export const pickBand = (y: number, viewport: number) => Math.floor(Math.max(0, y / ROW - Math.ceil(viewport / ROW) / 2) / CHUNK) * CHUNK;

export function PluginQuickPick({ request }: { request: QuickPickRequest }) {
  const { id, items, options } = request;
  const many = !!options.canPickMany;
  const pluginTitle = usePluginTitle(request.plugin);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(items.filter((i) => i.picked).map((i) => i.id)));
  const shown = useMemo(() => fuzzyFilter(items, query, itemFields), [items, query]);
  const at = Math.min(highlight, Math.max(0, shown.length - 1));
  const scroller = useRef<ScrollView>(null);
  const scrollY = useRef(0);
  const [viewport, setViewport] = useState<number>(OVERLAY.quickPickHeight);
  const [band, setBand] = useState(0);
  const bandNow = useRef(band);
  bandNow.current = band;
  const span = pickSpan(viewport);
  const first = Math.max(0, Math.min(band, shown.length - span));
  const inView = shown.slice(first, first + span);
  const slots = useRef(new Map<string, number>());
  slots.current = assignSlots(inView.map((item) => item.id), slots.current);
  const scrollTo = (y: number) => {
    scrollY.current = y;
    scroller.current?.scrollTo({ y, animated: false });
    const next = pickBand(y, viewport);
    if (next !== bandNow.current) setBand(next);
  };
  const reveal = (index: number) => {
    const top = index * ROW;
    if (top < scrollY.current) scrollTo(top);
    else if (top + ROW > scrollY.current + viewport) scrollTo(top + ROW - viewport);
  };
  const step = (by: number) => {
    if (!shown.length) return;
    const next = (at + by + shown.length) % shown.length;
    setHighlight(next);
    reveal(next);
  };
  const cancel = () => resolveQuickPick(id, null);
  const confirm = () => resolveQuickPick(id, [...picked]);
  const toggle = (item: QuickPickItem) =>
    setPicked((now) => {
      const next = new Set(now);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  const choose = (item: QuickPickItem | undefined) => {
    if (!item) return;
    if (many) toggle(item);
    else resolveQuickPick(id, [item.id]);
  };
  const rows: ReactNode[] = new Array(inView.length);
  inView.forEach((item, i) => {
    const slot = slots.current.get(item.id)!;
    const index = first + i;
    rows[slot] = (
      <View key={`r${slot}`} style={{ position: "absolute", top: index * ROW, left: 0, right: 0, height: ROW }}>
        <PickRow item={item} highlighted={index === at} checked={many ? picked.has(item.id) : null} onPress={() => choose(item)} />
      </View>
    );
  });
  return (
    <Dialog width="m" pad="m" animated onDismiss={cancel}>
      <Box gap="s">
        {options.title || pluginTitle ? (
          <Box row gap="s" padX="xs" style={CENTER}>
            <Text weight="semibold" numberOfLines={1} style={FLEX}>
              {options.title ?? pluginTitle}
            </Text>
            {options.title && pluginTitle ? (
              <Text size="caption" tone="textTertiary">
                {pluginTitle}
              </Text>
            ) : null}
          </Box>
        ) : null}
        <SearchField
          value={query}
          onChangeText={(text) => {
            setQuery(text);
            setHighlight(0);
            scrollTo(0);
          }}
          placeholder={options.placeholder ?? "Search"}
          autoFocus
          onEscape={cancel}
          onArrow={step}
          onSubmit={() => (many ? confirm() : choose(shown[at]))}
        />
        <ScrollView
          ref={scroller}
          scrollEventThrottle={16}
          onLayout={(e) => setViewport(Math.max(ROW, e.nativeEvent.layout.height))}
          onScroll={(e) => {
            scrollY.current = e.nativeEvent.contentOffset.y;
            const next = pickBand(scrollY.current, viewport);
            if (next !== bandNow.current) setBand(next);
          }}
          style={LIST}
        >
          {shown.length ? <View style={{ height: shown.length * ROW }}>{rows}</View> : <EmptyState symbol="magnifyingglass" title="No matches" />}
        </ScrollView>
        {many ? (
          <Box row gap="s" style={FOOTER}>
            <Text size="caption" tone="textTertiary" style={FLEX}>
              {`${picked.size} selected`}
            </Text>
            <Button title="Cancel" onPress={cancel} />
            <Button title="Done" kind="primary" onPress={confirm} />
          </Box>
        ) : null}
      </Box>
    </Dialog>
  );
}

function PickRow({ item, highlighted, checked, onPress }: { item: QuickPickItem; highlighted: boolean; checked: boolean | null; onPress: () => void }) {
  const theme = useTheme();
  return (
    <ListRow selected={highlighted} height={SURFACE.itemHeight} onPress={onPress}>
      {checked !== null ? <Symbol name={checked ? "checkmark.circle.fill" : "circle"} size={SURFACE.icon} color={checked ? theme.formAccent : theme.textTertiary} style={ICON} /> : null}
      {item.icon ? <Symbol name={item.icon} size={SURFACE.icon} color={theme.icon} style={ICON} /> : null}
      <Box row gap="s" style={[FLEX, CENTER]}>
        <Text numberOfLines={1} style={SHRINK}>
          {item.title}
        </Text>
        {item.subtitle ? (
          <Text size="small" tone="textSecondary" numberOfLines={1} style={SHRINK}>
            {item.subtitle}
          </Text>
        ) : null}
      </Box>
      {item.badge ? <Badge text={item.badge} tone="chip" /> : null}
    </ListRow>
  );
}

const FLEX = { flex: 1 } as const;
const SHRINK = { flexShrink: 1 } as const;
const CENTER = { alignItems: "center" } as const;
const FOOTER = { alignItems: "center" } as const;
const LIST = { maxHeight: OVERLAY.quickPickHeight } as const;
const ICON = { width: SURFACE.iconBox, height: SURFACE.iconBox } as const;
