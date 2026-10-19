import { describe, expect, it } from 'vitest';
import { redact, redactString, REDACTED } from '../src';

describe('redacción de secretos', () => {
  it('redacta patrones conocidos dentro de texto', () => {
    const s = 'key sk-ant-api03-abcdefghijklmnopqrstu y Bearer abcdefghijklmnop123 y ghp_abcdefghijklmnopqrstuvwxyz';
    const out = redactString(s);
    expect(out).not.toMatch(/sk-ant|abcdefghijklmnop123|ghp_/);
    expect(out).toContain(REDACTED);
  });

  it('redacta por nombre de clave en objetos anidados', () => {
    const out = redact({ user: 'a', auth: { Authorization: 'x', nested: [{ apiKey: 'k', ok: 1 }] }, password: 'p' });
    expect(out).toEqual({ user: 'a', auth: { Authorization: REDACTED, nested: [{ apiKey: REDACTED, ok: 1 }] }, password: REDACTED });
  });

  it('redacta claves privadas PEM', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----';
    expect(redactString(`x ${pem} y`)).toBe(`x ${REDACTED} y`);
  });

  it('no altera texto normal', () => {
    expect(redactString('hola mundo, compilación OK')).toBe('hola mundo, compilación OK');
  });
});
