// Accès au worker PDF depuis le fil principal.

import type { BuiltPdf } from './fromDb'
import type { NotebookData } from './codec'
import type { WorkerRequest } from './worker'

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()

type Body = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never

function call<T>(body: Body, transfer: Transferable[] = []): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      const p = pending.get(e.data.id)
      if (!p) return
      pending.delete(e.data.id)
      if (e.data.error !== undefined) p.reject(new Error(e.data.error))
      else p.resolve(e.data.result)
    }
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'Erreur du worker PDF'))
      pending.clear()
      worker = null
    }
  }
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    worker!.postMessage({ id, ...body }, transfer)
  })
}

export function buildPdf(notebookId: string): Promise<BuiltPdf> {
  return call<BuiltPdf>({ type: 'build', notebookId })
}

export function extractData(bytes: Uint8Array): Promise<NotebookData | null> {
  return call<NotebookData | null>({ type: 'extract', bytes })
}
