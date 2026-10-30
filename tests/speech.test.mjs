// Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import { dialogueOf, typingMs, LINGER_MS } from '../src/core/speech.js';
import { DEFAULT_TEMPLATES, OLD_DEFAULTS, renderTemplate } from '../src/core/notes.js';

test('a speech bubble shows the words in quotation marks, else the reply without its actions', () => {
    assert.equal(dialogueOf('*Judy grips the bars.* "Hey, over here. You can get me out of this." *She shakes them.* "Please."'), 'Hey, over here. You can get me out of this. Please.');
    assert.equal(dialogueOf('“Got it.” *She steps closer.*'), 'Got it.');
    assert.equal(dialogueOf('*Judy nods and falls in behind him without a word.*'), '', 'only an action: nothing said');
    assert.equal(dialogueOf('Lead the way. There is a door ahead.'), 'Lead the way. There is a door ahead.', 'no quotes at all: the plain text stands in');
    assert.equal(dialogueOf('<div>hidden</div> "Right behind you."'), 'Right behind you.');
    const long = dialogueOf(`"${'word '.repeat(100).trim()}"`);
    assert.ok(long.length <= 260 && long.endsWith('…'), 'long speeches are cut with an ellipsis');
});

test('typing keeps pace with the voice, or reads at a steady pace without one', () => {
    assert.equal(typingMs(100, 10), 9000, '10 s of voice: the words land a little before it ends');
    assert.equal(typingMs(10, 10), 1200, 'few words, long audio: they still appear within a second or so');
    assert.equal(typingMs(50), 1100, 'no voice: about 22 ms a character');
    assert.equal(typingMs(1000), 7000, 'never longer than 7 s');
    assert.equal(LINGER_MS, 5000);
});

test('the notes ask for dialogue in quotation marks, and the old defaults are kept for migration', () => {
    assert.match(renderTemplate(DEFAULT_TEMPLATES.scene, { player: 'Amber' }), /inside "double quotation marks"/);
    assert.match(renderTemplate(DEFAULT_TEMPLATES.npc, { npc: 'Wren', description: 'a turnkey', pronouns: 'he/him', attitude: 'wary', player: 'Amber', party: 'Judy' }), /Wren says out loud goes inside "double quotation marks"/);
    assert.notEqual(OLD_DEFAULTS.sceneV30, DEFAULT_TEMPLATES.scene);
    assert.notEqual(OLD_DEFAULTS.npcV30, DEFAULT_TEMPLATES.npc);
    assert.doesNotMatch(OLD_DEFAULTS.sceneV30, /quotation/);
});
