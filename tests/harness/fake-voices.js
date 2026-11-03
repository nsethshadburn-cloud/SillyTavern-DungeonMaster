// A fake of src/st/voices.js: nothing is spoken.
export const voiced = [];
export function onSpeech() { return () => { }; }
export function ttsConfig() { return { enabled: false, isChatterbox: false, provider: '', endpoint: '', rules: { narrate_user: false } }; }
export function syncTtsTakeover() { }
export function voicesActive() { return false; }
export async function fetchVoices() { return []; }
export function guessGender(name) { return /judy|olwen|martha|she\b/i.test(String(name)) ? 'female' : 'male'; }
export async function syncVoicePool() { return {}; }
export function pickNpcVoice() { return ''; }
export async function voiceForCharacter() { return ''; }
export function speechText(text) { return String(text); }
export function stopVoices() { }
export function voiceLine(line) { voiced.push(line); }
export function speak() { }
