import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { saveImage, loadImage, removeImage, listImages, MAX_BYTES } = require('../src/backgrounds.cjs');

// PNG de 1x1 válido
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiw-bg-')); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('backgrounds', () => {
  it('copia una imagen válida con nombre generado y la devuelve como data URL', () => {
    const src = path.join(tmp, 'mi foto.png');
    fs.writeFileSync(src, PNG);
    const dir = path.join(tmp, 'store');
    const name = saveImage(src, dir);
    expect(name).toMatch(/^[a-f0-9]{16}\.png$/);
    expect(listImages(dir)).toEqual([name]);
    expect(loadImage(dir, name)).toMatch(/^data:image\/png;base64,/);
    expect(removeImage(dir, name)).toBe(true);
    expect(listImages(dir)).toEqual([]);
  });

  it('rechaza extensiones no admitidas, contenido que no es imagen y tamaños excesivos', () => {
    const dir = path.join(tmp, 'store');
    fs.writeFileSync(path.join(tmp, 'a.svg'), '<svg onload="x"/>');
    expect(() => saveImage(path.join(tmp, 'a.svg'), dir)).toThrow(/Formato/);
    fs.writeFileSync(path.join(tmp, 'falsa.png'), 'esto no es un png');
    expect(() => saveImage(path.join(tmp, 'falsa.png'), dir)).toThrow(/contenido/);
    fs.writeFileSync(path.join(tmp, 'png-como-jpg.jpg'), PNG);
    expect(() => saveImage(path.join(tmp, 'png-como-jpg.jpg'), dir)).toThrow(/contenido/);
    const big = path.join(tmp, 'grande.png');
    fs.writeFileSync(big, Buffer.concat([PNG, Buffer.alloc(MAX_BYTES)]));
    expect(() => saveImage(big, dir)).toThrow(/8 MB/);
    expect(() => saveImage(tmp, dir)).toThrow();
  });

  it('solo carga y borra nombres propios: nunca rutas', () => {
    const dir = path.join(tmp, 'store');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(tmp, 'secreto.png'), PNG);
    for (const n of ['../secreto.png', '..\\secreto.png', 'secreto.png', 'C:\\x.png', '', null, 5]) {
      expect(loadImage(dir, n)).toBeNull();
      expect(removeImage(dir, n)).toBe(false);
    }
    expect(fs.existsSync(path.join(tmp, 'secreto.png'))).toBe(true);
  });
});
