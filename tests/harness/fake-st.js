// A fake of src/st/st.js: the SillyTavern surface the extension uses, in memory. The chat is an
// array; "generating" a companion's reply pushes the next scripted line; popups answer "yes".
export const MODULE = 'dungeon_master';
export const EXT_PATH = 'scripts/extensions/third-party/SillyTavern-DungeonMaster';

export const fake = {
    chat: [],
    chatMetadata: {},
    characters: [{ name: 'Judy Hopps', avatar: 'judy.png', description: 'A rabbit constable.' }],
    groups: [{ id: 'g1', members: ['judy.png'] }],
    selectedGroup: 'g1',
    extensionSettings: {},
    /** Scripted companion lines, oldest first (a function gets the speaker's name). */
    lines: [],
    /** Every popup asked, with what the fake answered. */
    popups: [],
    popupAnswer: () => POPUP_RESULT.AFFIRMATIVE,
    generated: [],
    reset() {
        this.chat = []; this.chatMetadata = {}; this.extensionSettings = {}; this.lines = []; this.popups = []; this.generated = [];
        this.popupAnswer = () => POPUP_RESULT.AFFIRMATIVE;
    },
};

const listeners = new Map();
const eventSource = {
    on(ev, fn) { listeners.set(ev, [...(listeners.get(ev) || []), fn]); },
    removeListener(ev, fn) { listeners.set(ev, (listeners.get(ev) || []).filter(f => f !== fn)); },
    async emit(ev, ...args) { for (const fn of listeners.get(ev) || []) await fn(...args); },
};

export const POPUP_TYPE = { CONFIRM: 'confirm', INPUT: 'input', TEXT: 'text' };
export const POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null, CUSTOM1: 1001, CUSTOM2: 1002 };

export const ST = {
    get chat() { return fake.chat; },
    get chatMetadata() { return fake.chatMetadata; },
    get characters() { return fake.characters; },
    get groups() { return fake.groups; },
    get selectedGroup() { return fake.selectedGroup; },
    get isBusy() { return false; },
    get userName() { return 'Amber'; },
    get userAvatar() { return 'amber.png'; },
    get mainApi() { return 'textgenerationwebui'; },
    get maxContext() { return 8192; },
    get responseLength() { return 512; },
    get powerUser() { return { personas: { 'amber.png': 'Amber' }, persona_descriptions: { 'amber.png': { description: 'A thief going straight.' } }, instruct: { enabled: false } }; },
    get extensionSettings() { return fake.extensionSettings; },
    eventSource,
    eventTypes: { CHAT_CHANGED: 'chat_changed', MESSAGE_SENT: 'message_sent', MESSAGE_RECEIVED: 'message_received', GENERATION_STOPPED: 'generation_stopped', GENERATION_ENDED: 'generation_ended', GROUP_WRAPPER_FINISHED: 'gwf', GROUP_MEMBER_DRAFTED: 'gmd', CHARACTER_MESSAGE_RENDERED: 'cmr', USER_MESSAGE_RENDERED: 'umr', MESSAGE_SWIPED: 'ms', MESSAGE_DELETED: 'md', GENERATE_AFTER_COMBINE_PROMPTS: 'gacp', CHAT_DELETED: 'cd', GROUP_CHAT_DELETED: 'gcd', CONNECTION_PROFILE_LOADED: 'cpl', SETTINGS_UPDATED: 'su' },
    getRequestHeaders: () => ({}),
    saveSettingsDebounced() { },
    async saveChat() { },
    saveMetadataDebounced() { },
    addOneMessage() { },
    updateMessageBlock() { },
    setExtensionPrompt() { },
    promptTypes: { IN_CHAT: 0 },
    promptRoles: { SYSTEM: 0, USER: 1 },
    /** A companion's reply: the next scripted line lands in the chat as their message. */
    async Generate(_kind, { force_chid } = {}) {
        const ch = fake.characters[force_chid];
        const next = fake.lines.shift();
        const mes = typeof next === 'function' ? next(ch?.name) : (next ?? `"Right behind you," ${ch?.name?.split(' ')[0] || 'she'} says.`);
        fake.generated.push({ name: ch?.name, mes });
        fake.chat.push({ name: ch?.name || 'Someone', is_user: false, is_system: false, send_date: new Date().toISOString(), mes, extra: {} });
    },
    async generateRaw() { return ''; },
    substituteParams: s => s,
    async getCharacters() { },
    async openGroupById() { },
    async editGroup() { },
    messageFormatting: s => s,
    deactivateSendButtons() { },
    activateSendButtons() { },
    stopGeneration() { },
    async callGenericPopup(html, type, _value, opts = {}) { const r = fake.popupAnswer(html, type, opts); fake.popups.push({ html: String(html), type, answer: r }); return r; },
    Popup: class { constructor() { } show() { return Promise.resolve(POPUP_RESULT.NEGATIVE); } },
    POPUP_TYPE,
    POPUP_RESULT,
    async loadWorldInfo() { return null; },
    WORLD_INFO_KEY: 'world_info',
    context: () => ({ name1: 'Amber', name2: '', getCurrentChatId: () => 'chat1', uuidv4: () => 'uuid', parseReasoningFromString: null, getWorldInfoNames: () => [], saveWorldInfo: async () => { }, updateWorldInfoList: async () => { } }),
};

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
export async function waitUntilIdle() { }
export function currentGroup() { return fake.groups.find(g => g.id === fake.selectedGroup) ?? null; }
export function findCharacterIndex(nameOrAvatar) {
    const key = String(nameOrAvatar ?? '').toLowerCase();
    let idx = fake.characters.findIndex(c => c.avatar?.toLowerCase() === key);
    if (idx === -1) idx = fake.characters.findIndex(c => c.name?.toLowerCase() === key);
    return idx;
}
export function personaName(avatar) { return ST.powerUser.personas?.[avatar] || 'Amber'; }
export function personaDescription(avatar) { return ST.powerUser.persona_descriptions?.[avatar]?.description || ''; }
