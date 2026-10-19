const SENSITIVE_KEY = /(token|secret|password|passwd|authorization|api[_-]?key|cookie|credential|private[_-]?key)/i;

const PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g, // claves tipo OpenAI/Anthropic
  /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // tokens de GitHub
  /AIza[0-9A-Za-z_-]{30,}/g, // claves de Google
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export const REDACTED = '[REDACTED]';

export function redactString(input: string): string {
  let out = input;
  for (const p of PATTERNS) out = out.replace(p, REDACTED);
  return out;
}

/** Copia profunda con valores sensibles reemplazados (por nombre de clave o por patrón). */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 12) return REDACTED as unknown as T;
  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
