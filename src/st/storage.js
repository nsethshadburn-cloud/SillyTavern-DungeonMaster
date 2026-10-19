// Campaign files live in SillyTavern's user files folder (data/<user>/user/files/),
// written through SillyTavern's own upload endpoint so nothing outside the extension changes.

import { ST } from './st.js';

const cache = new Map(); // name -> text

function toBase64(text) {
    const bytes = new TextEncoder().encode(String(text ?? ''));
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

/** Write a text file. name: letters, numbers, _ - . only. */
export async function writeFile(name, text) {
    // SillyTavern rejects empty uploads, so an empty document is stored as a single newline.
    const body = String(text ?? '') || '\n';
    const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: ST.getRequestHeaders(),
        body: JSON.stringify({ name, data: toBase64(body) }),
    });
    if (!response.ok) {
        throw new Error(`Could not save ${name}: ${response.status} ${await response.text().catch(() => '')}`);
    }
    cache.set(name, String(text ?? ''));
    return name;
}

/** Read a text file; returns fallback if it doesn't exist. */
export async function readFile(name, fallback = '') {
    if (cache.has(name)) return cache.get(name);
    const response = await fetch(`/user/files/${encodeURIComponent(name)}`, {
        method: 'GET',
        headers: ST.getRequestHeaders(),
        cache: 'no-store',
    });
    if (!response.ok) return fallback;
    let text = await response.text();
    if (!text.trim()) text = '';
    cache.set(name, text);
    return text;
}

export async function readJson(name, fallback) {
    const text = await readFile(name, '');
    if (!text) return structuredClone(fallback);
    try {
        return JSON.parse(text);
    } catch {
        console.warn(`[Dungeon Master] ${name} is not valid JSON; using defaults.`);
        return structuredClone(fallback);
    }
}

export async function writeJson(name, value) {
    return writeFile(name, JSON.stringify(value, null, 2));
}

export function forget(name) {
    cache.delete(name);
}

export function forgetAll() {
    cache.clear();
}

/** Debounced writer so rapid updates collapse into one save. */
const pending = new Map();
export function writeLater(name, producer, delay = 800) {
    if (pending.has(name)) clearTimeout(pending.get(name).timer);
    const timer = setTimeout(async () => {
        pending.delete(name);
        try {
            const value = producer();
            if (value === null || value === undefined) return;
            await (typeof value === 'string' ? writeFile(name, value) : writeJson(name, value));
        } catch (error) {
            console.error('[Dungeon Master] Save failed', name, error);
            toastr.error(`Could not save ${name}. Check the console.`, 'Dungeon Master');
        }
    }, delay);
    pending.set(name, { timer, producer });
}

/** Write everything that's waiting right now. */
export async function flushWrites() {
    const entries = [...pending.entries()];
    pending.clear();
    for (const [name, { timer, producer }] of entries) {
        clearTimeout(timer);
        const value = producer();
        if (value === null || value === undefined) continue;
        await (typeof value === 'string' ? writeFile(name, value) : writeJson(name, value));
    }
}
