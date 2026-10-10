// The three colours, widths and sizes each writing tool keeps at hand in the
// toolbar. They are chosen once and follow on every device.

import type { ToolState } from './ui/canvas'

export interface ToolPresets {
  pen?: { colors: string[]; widths: number[] }
  pencil?: { colors: string[]; widths: number[] }
  highlighter?: { colors: string[]; widths: number[] }
  eraser?: { sizes: number[] }
}

/** As kept on the device: `at` is when they were last changed, `dirty` that OneDrive does not have them yet. */
export interface SyncedTools {
  at: number
  dirty?: boolean
  presets: ToolPresets
}

export const TOOLS_KEY = 'tools'

export function currentPresets(tool: ToolState): ToolPresets {
  const ink = (t: ToolState['pen']) => ({ colors: [...(t.colors ?? [])], widths: [...(t.widths ?? [])] })
  return { pen: ink(tool.pen), pencil: ink(tool.pencil), highlighter: ink(tool.highlighter), eraser: { sizes: [...(tool.eraser.sizes ?? [])] } }
}

const three = <T>(v: unknown, ok: (x: unknown) => x is T): T[] | undefined => (Array.isArray(v) && v.length === 3 && v.every(ok) ? (v as T[]) : undefined)
const isColor = (x: unknown): x is string => typeof x === 'string' && /^#[0-9a-f]{6}$/i.test(x)
const isSize = (x: unknown): x is number => typeof x === 'number' && x > 0 && x <= 60

/** Presets read from a file: anything that is not three valid values is left out. */
export function readPresets(raw: unknown): ToolPresets {
  const out: ToolPresets = {}
  const r = (raw ?? {}) as Record<string, { colors?: unknown; widths?: unknown; sizes?: unknown } | undefined>
  for (const kind of ['pen', 'pencil', 'highlighter'] as const) {
    const colors = three(r[kind]?.colors, isColor)
    const widths = three(r[kind]?.widths, isSize)
    if (colors && widths) out[kind] = { colors, widths }
  }
  const sizes = three(r.eraser?.sizes, isSize)
  if (sizes) out.eraser = { sizes }
  return out
}
