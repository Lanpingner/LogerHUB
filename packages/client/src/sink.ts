import type { LoggerOptions, Sink } from './types'
import { createCore } from './logger'

/**
 * The same pipeline as `createLogger`, taking entries a foreign logger already built, so a
 * pino or winston transport can hand them straight over.
 */
export function createSink(opts: LoggerOptions): Sink {
  const core = createCore(opts)
  return {
    write: (entry) => core.accept(entry),
    flush: () => core.flush(),
    close: () => core.close(),
  }
}
