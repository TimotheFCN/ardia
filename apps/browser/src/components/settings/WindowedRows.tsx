import { createContext, type ReactNode, type RefObject, useContext, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useSettingsWindow } from "../../state/settings/settingsScroll";
import { assignSlots } from "../pages/historyLayout";
import { Divider } from "../ui";

export const SettingsContentContext = createContext<RefObject<View | null> | null>(null);

export function WindowedRows<T>({ items, rowHeight, keyOf, render }: { items: readonly T[]; rowHeight: number; keyOf: (item: T) => string; render: (item: T) => ReactNode }) {
  const content = useContext(SettingsContentContext);
  const box = useRef<View>(null);
  const [top, setTop] = useState<number | null>(null);
  const measure = () => {
    const container = content?.current;
    if (container) box.current?.measureLayout(container, (_x, y) => setTop(y), () => {});
  };
  const { first, shown } = useSettingsWindow(top, rowHeight, items.length);
  useEffect(measure, [first, items.length]);
  const inView = items.slice(first, first + shown);
  const slots = useRef(new Map<string, number>());
  slots.current = assignSlots(inView.map(keyOf), slots.current);

  const rows: ReactNode[] = new Array(inView.length);
  inView.forEach((item, i) => {
    const slot = slots.current.get(keyOf(item))!;
    const index = first + i;
    rows[slot] = (
      <View key={`r${slot}`} style={{ position: "absolute", top: index * rowHeight, left: 0, right: 0, height: rowHeight, justifyContent: "center" }}>
        {index > 0 ? <Divider thick inset="l" style={DIVIDER} /> : null}
        {render(item)}
      </View>
    );
  });
  return (
    <View ref={box} onLayout={measure} style={{ height: items.length * rowHeight }}>
      {rows}
    </View>
  );
}

const DIVIDER = { position: "absolute", top: 0, left: 0, right: 0 } as const;
