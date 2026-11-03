// A fake of src/st/storage.js: the campaign's files live in a map.
export const files = new Map();

export async function readFile(name, fallback = '') { return files.has(name) ? files.get(name) : fallback; }
export async function readJson(name, fallback = null) { return files.has(name) ? JSON.parse(files.get(name)) : fallback; }
export async function writeFile(name, text) { files.set(name, String(text)); }
export async function writeJson(name, value) { files.set(name, JSON.stringify(value)); }
export function writeLater(name, getter) { const v = getter(); files.set(name, typeof v === 'string' ? v : JSON.stringify(v)); }
export async function flushWrites() { }
export function forgetAll() { }
