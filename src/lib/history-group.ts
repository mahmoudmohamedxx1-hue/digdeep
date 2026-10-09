import type { HistoryItem } from "@/components/research/types";

/** ChatGPT-style time grouping for sidebar recents and the Library. */
export function groupHistory(items: HistoryItem[]): { label: string; items: HistoryItem[] }[] {
  const day = 86_400_000;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const t0 = start.getTime();
  const groups: { label: string; items: HistoryItem[] }[] = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "Previous 7 days", items: [] },
    { label: "Previous 30 days", items: [] },
    { label: "Older", items: [] },
  ];
  for (const h of items.slice(0, 60)) {
    const t = new Date(h.createdAt).getTime();
    if (t >= t0) groups[0].items.push(h);
    else if (t >= t0 - day) groups[1].items.push(h);
    else if (t >= t0 - 7 * day) groups[2].items.push(h);
    else if (t >= t0 - 30 * day) groups[3].items.push(h);
    else groups[4].items.push(h);
  }
  return groups.filter((g) => g.items.length > 0);
}
