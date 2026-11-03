// A fake of src/ui/map.js: the panel records what it was asked to do instead of drawing.
export const mapCalls = [];
export function openMap() { mapCalls.push('open'); }
export function closeMap() { mapCalls.push('close'); }
export function refreshMap() { mapCalls.push('refresh'); }
export function toggleMap() { mapCalls.push('toggle'); }
export function playAnim(name, anim) { mapCalls.push(`anim:${name}:${anim}`); }
export function setMapBusy(on) { mapCalls.push(`busy:${on}`); }
