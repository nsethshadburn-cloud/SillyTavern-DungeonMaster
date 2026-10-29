// Speech bubbles on the map: when a companion or NPC speaks, a bubble over their figure shows what
// they said, the words appearing one by one. With voices on, the bubble waits for that line's audio
// to start (and types along with it); with voices off, or when the voice fails, it appears as the
// line is generated. It stays up until a few seconds after they finish, then fades.
// Display only: nothing here is saved or sent to any model.

import { dialogueOf, typingMs, LINGER_MS } from '../core/speech.js';
import { onSpeech } from '../st/voices.js';
import { settings } from '../st/settings.js';

/** name -> {name, text, el, shown, status: 'waiting'|'typing'|'talking'|'done', timers: Set, typer} */
const bubbles = new Map();
let stage = null;        // the element over the map canvas that holds the bubbles
let locate = () => null; // name -> {x, y} pixels on the stage, or null (not on this map)
const WAIT_FOR_VOICE_MS = 30000;

/** The map tells the bubbles where to live and how to find a figure (every render). */
export function setBubbleStage(el, locator) {
    stage = el;
    locate = locator || (() => null);
    for (const b of bubbles.values()) if (b.el) { if (!stage?.contains(b.el)) stage?.appendChild(b.el); place(b); }
}

/** The map closed: the bubbles have nowhere to be (they come back if it reopens while they last). */
export function clearBubbleStage() {
    stage = null;
    for (const b of bubbles.values()) b.el?.remove();
}

/**
 * Someone spoke. voiced = the plugin is voicing this line: wait for its audio before showing.
 * @param {{name: string, text: string, voiced?: boolean}} o
 */
export function sayOnMap({ name, text, voiced = false }) {
    if (settings().mapBubbles === false) return;
    const words = dialogueOf(text);
    if (!words) return;
    const old = bubbles.get(name);
    if (old) drop(old);
    const b = { name, text: words, el: null, shown: 0, status: voiced ? 'waiting' : 'typing', timers: new Set(), typer: null };
    bubbles.set(name, b);
    if (voiced) {
        // The voice never came (no voice for them, the server is down, a long queue): show it anyway.
        later(b, WAIT_FOR_VOICE_MS, () => { if (b.status === 'waiting') show(b, 0); });
    } else show(b, 0);
}

onSpeech(ev => {
    if (ev.type === 'stop') { for (const b of [...bubbles.values()]) drop(b); return; }
    // One bubble per speaker, and their lines play in order: the event for this name is this bubble.
    const b = ev.name ? bubbles.get(ev.name) : null;
    if (!b) return;
    if (ev.type === 'start') { if (b.status === 'waiting') show(b, ev.duration || 0); b.status = 'talking'; }
    else if (ev.type === 'skip') { if (b.status === 'waiting') show(b, 0); }
    else if (ev.type === 'end') { b.status = 'done'; finishTyping(b); later(b, LINGER_MS, () => drop(b)); }
});

function later(b, ms, fn) {
    const t = setTimeout(() => { b.timers.delete(t); fn(); }, ms);
    b.timers.add(t);
}

function show(b, voiceSeconds) {
    if (!b.el) {
        b.el = document.createElement('div');
        b.el.className = 'dm-bubble dm-bubble-in';
        b.el.innerHTML = '<div class="dm-bubble-name"></div><div class="dm-bubble-text"></div>';
        b.el.querySelector('.dm-bubble-name').textContent = b.name;
    }
    if (stage && !stage.contains(b.el)) stage.appendChild(b.el);
    place(b);
    if (b.status === 'waiting') b.status = 'typing';
    // The words appear one by one, paced to the voice when there is one.
    const total = typingMs(b.text.length, voiceSeconds);
    const perChar = total / b.text.length;
    const started = performance.now();
    b.el.classList.add('dm-bubble-typing');
    clearInterval(b.typer);
    b.typer = setInterval(() => {
        const want = Math.min(b.text.length, Math.floor((performance.now() - started) / perChar) + 1);
        if (want > b.shown) { b.shown = want; b.el.querySelector('.dm-bubble-text').textContent = b.text.slice(0, b.shown); }
        if (b.shown >= b.text.length) {
            clearInterval(b.typer); b.typer = null;
            b.el.classList.remove('dm-bubble-typing');
            // No voice to wait for: linger from the moment the last word lands.
            if (b.status !== 'talking') { b.status = 'done'; later(b, LINGER_MS, () => drop(b)); }
        }
    }, 30);
}

function finishTyping(b) {
    if (!b.el) return;
    clearInterval(b.typer); b.typer = null;
    b.shown = b.text.length;
    b.el.querySelector('.dm-bubble-text').textContent = b.text;
    b.el.classList.remove('dm-bubble-typing');
}

function place(b) {
    if (!b.el) return;
    const at = locate(b.name);
    if (!at) { b.el.classList.add('dm-hidden'); return; }
    b.el.classList.remove('dm-hidden');
    b.el.style.left = `${Math.round(at.x)}px`;
    b.el.style.top = `${Math.round(at.y)}px`;
}

function drop(b) {
    for (const t of b.timers) clearTimeout(t);
    b.timers.clear();
    clearInterval(b.typer);
    if (bubbles.get(b.name) === b) bubbles.delete(b.name);
    const el = b.el;
    if (!el) return;
    el.classList.remove('dm-bubble-in');
    el.classList.add('dm-bubble-out');
    setTimeout(() => el.remove(), 350);
}
