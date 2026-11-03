// A module hook for the smoke tests: the SillyTavern-side modules the extension can't run under node
// (the one that imports SillyTavern's own files, the canvas map, the DOM status strip, the voices,
// the NPC cards, the files on the server, the model calls) are swapped for small fakes, so the real
// turn loop, DM prompt, campaign store and actors run end to end with a scripted DM.
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const FAKES = {
    'src/st/st.js': 'fake-st.js',
    'src/st/llm.js': 'fake-llm.js',
    'src/st/storage.js': 'fake-storage.js',
    'src/st/sheets.js': 'fake-sheets.js',
    'src/st/voices.js': 'fake-voices.js',
    'src/st/npccards.js': 'fake-npccards.js',
    'src/st/figures.js': 'fake-figures.js',
    'src/ui/map.js': 'fake-map.js',
    'src/ui/status.js': 'fake-status.js',
    'src/ui/thinking.js': 'fake-thinking.js',
    'src/ui/sound.js': 'fake-sound.js',
};

export async function resolve(specifier, context, next) {
    const r = await next(specifier, context);
    if (r.url?.startsWith('file:')) {
        const rel = path.relative(root, fileURLToPath(r.url)).split(path.sep).join('/');
        if (FAKES[rel]) return { ...r, url: pathToFileURL(path.join(here, FAKES[rel])).href, shortCircuit: true };
    }
    return r;
}
