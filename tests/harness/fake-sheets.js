// A fake of src/st/sheets.js: character sheets as plain stats tables.
export const sheets = {
    Amber: { name: 'Amber', class: 'Rogue', level: 5, ac: 14, hp_max: 24, speed: 30, proficiency: 3, abilities: { STR: 10, DEX: 18, CON: 12, INT: 13, WIS: 12, CHA: 14 }, saves: { STR: 0, DEX: 7, CON: 1, INT: 4, WIS: 1, CHA: 2 }, skills: { Acrobatics: 7, Athletics: 0, Perception: 4, Stealth: 10, 'Sleight of Hand': 10, Investigation: 4 }, tools: { "Thieves' Tools": 10 }, attacks: [{ name: 'Short sword', to_hit: 7, damage: '1d6+4' }], initiative: 4 },
    'Judy Hopps': { name: 'Judy Hopps', class: 'Fighter', level: 4, ac: 15, hp_max: 27, speed: 30, proficiency: 2, abilities: { STR: 12, DEX: 16, CON: 14, INT: 12, WIS: 14, CHA: 13 }, saves: { STR: 3, DEX: 3, CON: 4, INT: 1, WIS: 2, CHA: 1 }, skills: { Athletics: 3, Perception: 4, Stealth: 5, Insight: 4 }, tools: {}, attacks: [{ name: 'Baton', to_hit: 5, damage: '1d6+3' }], initiative: 3 },
};

export function statsForName(name) { return sheets[name] ?? null; }
export function personaSheet() { return null; }
export function characterSheet() { return null; }
export async function sheetMarkdown() { return ''; }
export async function createCharacterSheet() { return { usd: 0 }; }
export async function createPersonaSheetFromFile() { return { usd: 0 }; }
export const createPersonaSheetFromPdf = createPersonaSheetFromFile;
export async function levelCharacterSheet(_avatar, level) { return { usd: 0, stats: { hp_max: 10 + level * 6 } }; }
export async function loadPdfJs() { return null; }
export async function extractPdf() { return ''; }
