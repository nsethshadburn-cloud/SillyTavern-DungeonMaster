// Character sheets.
// Persona sheets come from an uploaded PDF (converted once, then locked).
// Party members get a best-guess sheet written by Claude from their character card (also locked).
// Only YOU can replace a sheet, by uploading/regenerating with a confirmation.

import { ST, findCharacterIndex } from './st.js';
import { settings, saveSettings } from './settings.js';
import { writeFile, readFile } from './storage.js';
import { callClaude } from './llm.js';
import { SHEET_FROM_PDF_INSTRUCTIONS, SHEET_FROM_CARD_INSTRUCTIONS } from '../core/protocol.js';
import { extractJson, slug, shortId, trimToTokens } from '../core/text.js';

async function loadPdfJs() {
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

/** Persona sheet from PDF. Overwrites only when the user confirmed (caller's job). */
export async function createPersonaSheetFromPdf(personaAvatar, personaName, file, onStep = () => { }) {
    onStep('Reading the PDF');
    const pdf = await extractPdf(file);
    if (!pdf.text && !Object.keys(pdf.fields).length) throw new Error('No text or form fields found in this PDF. Is it a scanned image?');
    const fieldLines = Object.entries(pdf.fields).map(([k, v]) => `${k}: ${v}`).join('\n');
    const user = [
        `Character (persona) name in the app: ${personaName}`,
        '',
        '## Form fields (name: value)',
        trimToTokens(fieldLines || '(none)', 12000),
        '',
        '## Page text',
        trimToTokens(pdf.text || '(none)', 12000),
    ].join('\n');
    onStep('Claude is converting the sheet');
    const reply = await callClaude({ system: SHEET_FROM_PDF_INSTRUCTIONS, user, label: 'persona sheet', maxTokens: 8000, effort: 'low', force: true });
    const sheet = parseSheetReply(reply.text);
    const fileName = `dmsheet_persona_${slug(personaName, 30)}_${shortId()}.md`;
    await writeFile(fileName, sheet.markdown);
    const s = settings();
    s.personaSheets[personaAvatar] = { file: fileName, name: personaName, created: new Date().toISOString(), source: file.name, stats: sheet.stats };
    saveSettings();
    return { ...s.personaSheets[personaAvatar], usd: reply.usd };
}

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
