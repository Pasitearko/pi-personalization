import type { MarkerPoint } from "./gutter.ts";

export interface PickerPlacement { row: number; col: number; width: number; maxHeight: number }

/** Absolute overlay coordinates; reserve the alps right border and the gutter. */
export function pickerPlacement(columns: number, rows: number, count: number,
  point?: MarkerPoint, chatHeight = rows): PickerPlacement {
  const cols = Math.max(1, Math.floor(columns)), screenRows = Math.max(1, Math.floor(rows));
  const top = Math.max(0, Math.min(screenRows - 1, Math.floor(point?.top ?? 0)));
  const availableRows = Math.max(1, Math.min(screenRows - top, Math.floor(chatHeight)));
  const height = Math.min(availableRows, count <= 6 ? Math.max(3, count + 2) : 9);
  // Four-column gutter glyph is at columns - 3. Keep its adjacent alps border exposed.
  const right = Math.max(1, Math.min(cols, Math.floor(point?.x ?? cols - 3) - 3));
  const margin = right >= 12 ? 1 : 0;
  const width = Math.max(1, Math.min(42, right - margin));
  const y = Math.floor(point?.y ?? top + availableRows / 2);
  return { width, maxHeight: height, col: right - width,
    row: Math.max(top, Math.min(top + availableRows - height, y - Math.floor(height / 2))) };
}
