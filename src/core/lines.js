// Canned lines: what someone on the map says, in their speech bubble, when they notice a party
// member somewhere they're allowed to be. Vague on purpose, so they fit any scene, and free: no
// model is called. A guard sounds like a guard, a shopkeeper like a shopkeeper, and anyone can see
// you're hurt. Pure module.

import { random01 } from './dice.js';

const LINES = Object.freeze({
    guard: [
        'Hope you\'re not up to any trouble.', 'Keep moving.', 'Mind yourself.', 'Nothing to see here.', 'Evening.', 'I\'ve got my eye on you.',
        'Don\'t touch anything.', 'Stay where I can see you.', 'You lost?', 'Move along now.', 'Quiet night. Let\'s keep it that way.',
    ],
    keeper: [
        'Have a look around.', 'Let me know if you need anything.', 'We\'re open, come in.', 'Don\'t break anything.', 'What can I get you?',
        'Welcome, welcome.', 'Mind the step.', 'Coin first, then goods.',
    ],
    prisoner: [
        'Psst. Got anything to eat?', 'They\'ll come for you too.', 'Keep your voice down.', 'How long have you been in here?', 'Don\'t trust the turnkey.',
    ],
    people: [
        'Hello there.', 'Fine night for it.', 'Haven\'t seen you around here.', 'Good day to you.', 'Mind how you go.', 'Hm. Visitors.',
        'Don\'t mind me.', 'You new here?', 'Keep it down, would you.',
    ],
    hurt: {
        guard: ['You look half dead. Keep it that way, not all the way.', 'Someone did a number on you.', 'You need the infirmary, not the halls.'],
        keeper: ['You don\'t look so good, friend.', 'Sit down before you fall down.', 'That looks like it hurts.'],
        prisoner: ['They got you good, didn\'t they.', 'You look worse than me.'],
        people: ['You don\'t look so good.', 'Are you all right?', 'Gods, what happened to you?'],
    },
});

/** How likely someone is to say anything at all when they notice you. */
export const SPEAK_CHANCE = 0.5;

/** The kind of line this person gives: by their role and description. */
export function lineRole(person) {
    const role = String(person?.role || '');
    if (role === 'guard' || /\b(guard|watch|turnkey|jailer|gaoler|sentr|soldier|constable|warden|marine|bouncer)/i.test(`${person?.name} ${person?.description}`)) return 'guard';
    if (role === 'prisoner' || /\bprisoner|inmate|captive\b/i.test(`${person?.name} ${person?.description}`)) return 'prisoner';
    if (role === 'keeper' || /\b(keeper|owner|shopkeep|barkeep|innkeep|merchant|trader|smith|baker|tailor|priest|clerk|seller|landlord|landlady|proprietor)/i.test(`${person?.name} ${person?.description}`)) return 'keeper';
    return 'people';
}

/**
 * A line, or '' when they say nothing this time (SPEAK_CHANCE). hurt = the one they noticed is
 * badly hurt (under half HP). rng in [0, 1).
 */
export function cannedLine(person, { hurt = false, chance = SPEAK_CHANCE, rng = random01 } = {}) {
    if (rng() >= chance) return '';
    const role = lineRole(person);
    const pool = hurt && rng() < 0.7 ? LINES.hurt[role] : LINES[role];
    return pool[Math.floor(rng() * pool.length)] ?? '';
}
