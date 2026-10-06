// Worker : fabrique et relit les PDF hors du fil principal, pour ne jamais
// ralentir l'écriture.

import { buildFromDb } from './fromDb'
import { extractPlumeData } from './extract'

export type WorkerRequest = { id: number; type: 'build'; notebookId: string } | { id: number; type: 'extract'; bytes: Uint8Array }

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  try {
    if (msg.type === 'build') {
      const built = await buildFromDb(msg.notebookId)
      self.postMessage({ id: msg.id, result: built }, { transfer: [built.bytes.buffer] })
    } else {
      self.postMessage({ id: msg.id, result: await extractPlumeData(msg.bytes) })
    }
  } catch (err) {
    self.postMessage({ id: msg.id, error: err instanceof Error ? err.message : String(err) })
  }
}
