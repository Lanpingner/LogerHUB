/** Client-facing option types only. Wire types live in `@logguber/shared`. */

export interface RedactOptions {
  /** Keys whose values are replaced with `[redacted]`, matched case-insensitively at any depth. */
  redactKeys?: string[]
  /** When set, only these top-level fields are captured; everything else is dropped. */
  allowFields?: string[]
}
