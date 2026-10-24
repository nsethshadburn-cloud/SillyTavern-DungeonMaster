// "Character sheet" button in the Persona panel.

import { ST, personaName } from '../st/st.js';
import { personaSheet, sheetMarkdown, createPersonaSheetFromFile } from '../st/sheets.js';
import { beginTurn } from './status.js';
import { renderSheets } from './settings-panel.js';
import { resetCaches, syncPartyHp } from '../st/orchestrator.js';
import { escapeHtml } from '../core/text.js';

export function mountPersonaButton() {
    const block = document.querySelector('#persona_controls .persona_controls_buttons_block');
    if (!block || document.getElementById('dm-persona-sheet')) return;
    const btn = document.createElement('div');
    btn.id = 'dm-persona-sheet';
    btn.className = 'menu_button fa-solid fa-scroll';
    btn.title = 'D&D character sheet (Dungeon Master)';
    btn.addEventListener('click', onClick);
    block.insertBefore(btn, block.firstChild);
}

async function onClick() {
    const avatar = ST.userAvatar;
    const name = personaName(avatar);
    const existing = personaSheet(avatar);
    if (existing) {
        const md = await sheetMarkdown(existing);
        const html = ST.messageFormatting(md, '', false, false, -1);
        const result = await ST.callGenericPopup(
            `<div class="dm-sheet-view"><h3>📜 ${escapeHtml(name)}: character sheet</h3><small>🔒 Locked. Made ${escapeHtml(new Date(existing.created).toLocaleString())} from ${escapeHtml(existing.source || 'your sheet')}. The Dungeon Master can read it but never change it.</small><hr>${html}</div>`,
            ST.POPUP_TYPE.CONFIRM, '',
            { okButton: 'Replace with a new sheet…', cancelButton: 'Close', wide: true, large: true, allowVerticalScrolling: true },
        );
        if (result !== ST.POPUP_RESULT.AFFIRMATIVE) return;
        const sure = await ST.callGenericPopup(`Replace ${escapeHtml(name)}'s locked sheet with a new sheet? The old one stays in your files but won't be used.`, ST.POPUP_TYPE.CONFIRM, '', { okButton: 'Yes, pick a file', cancelButton: 'No' });
        if (sure !== ST.POPUP_RESULT.AFFIRMATIVE) return;
    } else {
        const go = await ST.callGenericPopup(
            `<h3>📜 Upload a character sheet for ${escapeHtml(name)}</h3><p>Pick your D&amp;D 5e character sheet in any form: a PDF (fillable sheets work best), a photo or screenshot of a paper sheet, a Word document, or a text file. Claude converts it once into a clean text sheet (about one cent). After that it's <b>locked</b>: the DM uses it but can't change it. Only you can replace it.</p>`,
            ST.POPUP_TYPE.CONFIRM, '', { okButton: 'Choose file', cancelButton: 'Cancel' },
        );
        if (go !== ST.POPUP_RESULT.AFFIRMATIVE) return;
    }
    const file = await pickFile();
    if (!file) return;
    const status = beginTurn(`Reading ${name}'s sheet`);
    let step = null;
    try {
        const rec = await createPersonaSheetFromFile(avatar, name, file, (label) => {
            step?.done();
            step = status.step(label);
        });
        step?.done('', rec.usd);
        status.finish('Sheet saved and locked');
        toastr.success(`${name}'s sheet is saved and locked.`, 'Dungeon Master');
        resetCaches();
        syncPartyHp();
        renderSheets();
    } catch (error) {
        step?.fail(error);
        status.finish('Sheet failed');
        toastr.error(String(error?.message || error), 'Dungeon Master');
    }
}

function pickFile() {
    return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        // Any file: PDFs, photos/screenshots, Word/OpenDocument, text. (No accept filter, so phones offer the camera and every app.)
        input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
        input.addEventListener('cancel', () => resolve(null));
        input.click();
    });
}
