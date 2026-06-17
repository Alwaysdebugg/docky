/**
 * Shared selectable list (F01's deferred `selectableList`, landed in F11).
 *
 * One presentational component for the grouped, cursor-navigable lists used by
 * browse / results / projects / quick-open. Pass `selected` to render
 * checkboxes for multi-select (F11); omit it for single-cursor lists.
 */
import React from "react";
import { Box, Text } from "ink";

export interface SelectableItem {
  id: string; // unique key (e.g. rel)
  group?: string; // optional group header shown when it changes (e.g. "design/")
  label: string; // primary text
  meta?: string; // dim trailing text
  marker?: string; // optional leading marker before the label (e.g. "⚠ ")
}

export interface SelectableListProps {
  items: SelectableItem[];
  activeIndex: number;
  /** When provided, rows show `[x]`/`[ ]` checkboxes keyed by item id. */
  selected?: Set<string>;
  groupColor?: string;
  emptyText?: string;
}

export function SelectableList({
  items,
  activeIndex,
  selected,
  groupColor = "yellow",
  emptyText,
}: SelectableListProps) {
  if (items.length === 0 && emptyText) {
    return <Text dimColor>{emptyText}</Text>;
  }
  const rows: React.ReactNode[] = [];
  let lastGroup: string | undefined;
  items.forEach((it, i) => {
    if (it.group !== undefined && it.group !== lastGroup) {
      rows.push(
        <Text key={"g-" + it.group} color={groupColor} bold>
          {it.group}
        </Text>
      );
      lastGroup = it.group;
    }
    const active = i === activeIndex;
    const box = selected ? (selected.has(it.id) ? "[x] " : "[ ] ") : "";
    rows.push(
      <Box key={it.id}>
        <Text color={active ? "cyanBright" : undefined} inverse={active}>
          {active ? "▸ " : "  "}
          {box}
          {it.marker ?? ""}
          {it.label}
        </Text>
        {it.meta ? <Text dimColor>{"  " + it.meta}</Text> : null}
      </Box>
    );
  });
  return <Box flexDirection="column">{rows}</Box>;
}
