// Character sheets.
// Persona sheets come from an uploaded PDF (converted once, then locked).
// Party members get a best-guess sheet written by Claude from their character card (also locked).
// Only YOU can replace a sheet, by uploading/regenerating with a confirmation.

import { ST, findCharacterIndex } from './st.js';
import { settings, saveSettings } from './settings.js';
import { writeFile, readFile } from './storage.js';
import { callClaude } from './llm.js';
import { SHEET_FROM_PDF_INSTRUCTIONS, SHEET_FROM_CARD_INSTRUCTIONS, LEVEL_SHEET_INSTRUCTIONS } from '../core/protocol.js';
import { extractJson, slug, shortId, trimToTokens } from '../core/text.js';

export async function loadPdfJs() {
    if (!('pdfjsLib' in window)) {
        await import('../../../../../../lib/pdf.min.mjs');
        await import('../../../../../../lib/pdf.worker.min.mjs');
    }
    return window.pdfjsLib;
}

/**
 * Read a PDF: page text AND filled-in form fields (official 5e sheets are fillable forms,
 * and plain text extraction misses the values typed into the boxes).
 */
export async function extractPdf(file) {
    const pdfjsLib = await loadPdfJs();
    const buffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
    const fields = {};
    try {
        const objects = await pdf.getFieldObjects?.();
        if (objects) {
            for (const [name, list] of Object.entries(objects)) {
                for (const obj of list || []) {
                    const value = obj?.value ?? obj?.fieldValue;
                    if (value === undefined || value === null || value === '' || value === 'Off') continue;
                    fields[name] = typeof value === 'object' ? JSON.stringify(value) : String(value);
                }
            }
        }
    } catch (error) {
        console.warn('[Dungeon Master] getFieldObjects failed, trying annotations', error);
    }
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        pages.push(content.items.map(item => item.str).join(' '));
        if (!Object.keys(fields).length) {
            try {
                const annotations = await page.getAnnotations();
                for (const a of annotations) {
                    if (a.fieldName && a.fieldValue !== undefined && a.fieldValue !== null && a.fieldValue !== '' && a.fieldValue !== 'Off') {
                        fields[a.fieldName] = String(a.fieldValue);
                    }
                }
            } catch { /* ignore */ }
        }
    }
    return { text: pages.join('\n\n').replace(/[ \t]+/g, ' ').trim(), fields, pages: pdf.numPages };
}

function parseSheetReply(text) {
    const json = extractJson(text);
    if (!json || !json.markdown) throw new Error('Claude did not return a usable sheet. Try again.');
    return { markdown: String(json.markdown), stats: json.stats && typeof json.stats === 'object' ? json.stats : null };
}

/**
 * Persona sheet from any file: PDF (text, form fields, or page pictures for scans), a photo or
 * screenshot, a Word/OpenDocument file, or text. Overwrites only when the user confirmed (caller's job).
 */
export async function createPersonaSheetFromFile(personaAvatar, personaName, file, onStep = () => { }) {
    onStep(`Reading ${file.name}`);
    const { readSheetFile } = await import('./sheetfile.js');
    const read = await readSheetFile(file);
    if (!read.images.length && !read.text && !Object.keys(read.fields).length) throw new Error(`Couldn't find anything to read in "${file.name}".`);
    const fieldLines = Object.entries(read.fields).map(([k, v]) => `${k}: ${v}`).join('\n');
    const user = [
        `Character (persona) name in the app: ${personaName}`,
        `Source: ${read.kind} file "${file.name}"${read.images.length ? ` (${read.images.length} picture${read.images.length > 1 ? 's' : ''} attached: read everything you can see, including handwriting)` : ''}`,
        fieldLines ? `\n## Form fields (name: value)\n${trimToTokens(fieldLines, 12000)}` : '',
        read.text ? `\n## Text\n${trimToTokens(read.text, 12000)}` : '',
    ].filter(Boolean).join('\n');
    onStep('Claude is converting the sheet');
    const reply = await callClaude({ system: SHEET_FROM_PDF_INSTRUCTIONS, user, images: read.images, task: 'persona_sheet', label: 'persona sheet', maxTokens: 8000, effort: 'low', force: true });
    const sheet = parseSheetReply(reply.text);
    const fileName = `dmsheet_persona_${slug(personaName, 30)}_${shortId()}.md`;
    await writeFile(fileName, sheet.markdown);
    const s = settings();
    s.personaSheets[personaAvatar] = { file: fileName, name: personaName, created: new Date().toISOString(), source: file.name, stats: sheet.stats };
    saveSettings();
    return { ...s.personaSheets[personaAvatar], usd: reply.usd };
}

/** Kept for older callers. */
export const createPersonaSheetFromPdf = (...args) => createPersonaSheetFromFile(...args);

/** Best-guess sheet for a character card. */
export async function createCharacterSheet(characterAvatar, onStep = () => { }) {
    const chid = findCharacterIndex(characterAvatar);
    if (chid === -1) throw new Error('Character not found.');
    const ctx = ST.context();
    try { await ctx.unshallowCharacter?.(chid); } catch { /* ok */ }
    const ch = ST.characters[chid];
    const card = [
        `Name: ${ch.name}`,
        ch.description ? `Description: ${ch.description}` : '',
        ch.personality ? `Personality: ${ch.personality}` : '',
        ch.scenario ? `Scenario: ${ch.scenario}` : '',
        ch.mes_example ? `Example dialogue: ${trimToTokens(ch.mes_example, 800)}` : '',
    ].filter(Boolean).join('\n\n');
    onStep(`Claude is writing a sheet for ${ch.name}`);
    const reply = await callClaude({
        system: SHEET_FROM_CARD_INSTRUCTIONS,
        user: ST.substituteParams(trimToTokens(card, 6000)),
        task: 'character_sheet',
        label: `${ch.name} sheet`,
        maxTokens: 6000,
        effort: 'low',
    });
    const sheet = parseSheetReply(reply.text);
    const fileName = `dmsheet_char_${slug(ch.name, 30)}_${shortId()}.md`;
    await writeFile(fileName, sheet.markdown);
    const s = settings();
    s.characterSheets[ch.avatar] = { file: fileName, name: ch.name, created: new Date().toISOString(), source: 'card', stats: sheet.stats };
    saveSettings();
    return { ...s.characterSheets[ch.avatar], usd: reply.usd };
}

/**
 * Rewrite a companion's sheet for another level (up or down), following 5e rules.
 * The old sheet file is kept; the record points at the new one.
 */
export async function levelCharacterSheet(characterAvatar, level) {
    const s = settings();
    const record = s.characterSheets[characterAvatar];
    if (!record) throw new Error('This character has no sheet yet.');
    const current = await sheetMarkdown(record);
    const reply = await callClaude({
        system: LEVEL_SHEET_INSTRUCTIONS,
        user: `# REQUESTED LEVEL\n${level}\n\n# CURRENT SHEET\n${trimToTokens(current, 6000)}`,
        task: 'character_sheet',
        label: `${record.name} to level ${level}`,
        maxTokens: 6000,
        effort: 'low',
    });
    const sheet = parseSheetReply(reply.text);
    const fileName = `dmsheet_char_${slug(record.name, 30)}_L${level}_${shortId()}.md`;
    await writeFile(fileName, sheet.markdown);
    s.characterSheets[characterAvatar] = { ...record, file: fileName, created: new Date().toISOString(), source: `level ${level}`, stats: sheet.stats ?? record.stats };
    saveSettings();
    return { ...s.characterSheets[characterAvatar], usd: reply.usd };
}

export function personaSheet(avatar) {
    return settings().personaSheets[avatar] ?? null;
}

export function characterSheet(avatar) {
    return settings().characterSheets[avatar] ?? null;
}

export async function sheetMarkdown(record) {
    if (!record?.file) return '';
    return readFile(record.file, '');
}

/** Stats for a party member or the player by display name. */
export function statsForName(name, campaignMeta) {
    if (!campaignMeta) return null;
    if (campaignMeta.persona?.name === name) return personaSheet(campaignMeta.persona.avatar)?.stats ?? null;
    const member = campaignMeta.party?.find(p => p.name === name);
    if (member) return characterSheet(member.avatar)?.stats ?? null;
    return null;
}
