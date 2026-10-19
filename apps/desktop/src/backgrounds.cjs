'use strict';
// Imágenes de fondo del lienzo. Se copian a una carpeta propia de la app (userData/backgrounds) y el
// renderer solo ve nombres generados por nosotros: nunca rutas del disco. Se limita tipo y tamaño.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 8 * 1024 * 1024;
const EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const NAME = /^[a-f0-9]{16}\.(png|jpe?g|webp|gif)$/;

/** Firma de archivo: no se confía solo en la extensión. */
function sniff(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'gif';
  return null;
}

function saveImage(srcPath, dir) {
  const ext = path.extname(srcPath).slice(1).toLowerCase();
  if (!EXT_MIME[ext]) throw new Error('Formato no admitido (usa PNG, JPG, WEBP o GIF)');
  const st = fs.statSync(srcPath);
  if (!st.isFile()) throw new Error('No es un archivo');
  if (st.size > MAX_BYTES) throw new Error('La imagen supera 8 MB');
  const buf = fs.readFileSync(srcPath);
  const kind = sniff(buf);
  if (!kind || (kind === 'jpg' ? !['jpg', 'jpeg'].includes(ext) : kind !== ext)) throw new Error('El contenido no coincide con una imagen válida');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${crypto.randomBytes(8).toString('hex')}.${kind}`;
  fs.writeFileSync(path.join(dir, name), buf);
  return name;
}

function loadImage(dir, name) {
  if (typeof name !== 'string' || !NAME.test(name)) return null;
  try {
    const buf = fs.readFileSync(path.join(dir, name));
    return `data:${EXT_MIME[path.extname(name).slice(1)]};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

function removeImage(dir, name) {
  if (typeof name !== 'string' || !NAME.test(name)) return false;
  try {
    fs.rmSync(path.join(dir, name), { force: true });
    return true;
  } catch {
    return false;
  }
}

function listImages(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => NAME.test(n)).sort();
  } catch {
    return [];
  }
}

module.exports = { saveImage, loadImage, removeImage, listImages, NAME, MAX_BYTES };
