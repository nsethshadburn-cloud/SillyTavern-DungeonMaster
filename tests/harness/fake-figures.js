// A fake of src/st/figures.js: nobody is drawn.
import { LIBRARY, libraryLook } from '../../src/core/sprites.js';
export function figureFor() { return libraryLook('human_townsfolk'); }
export function wishesFor() { return ''; }
export function partyFigures() { return []; }
export function ensureFigures() { return Promise.resolve(); }
export async function redoFigure() { return null; }
export function animalFigure() { return null; }
export function ensureAnimalFigures() { return Promise.resolve(); }
export { LIBRARY };
