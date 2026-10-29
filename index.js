// Dungeon Master for SillyTavern: Claude runs the campaign, your local model plays the characters.
// See DESIGN.md for how it all fits together.

import { ST, MODULE, EXT_PATH } from './src/st/st.js';
import { settings } from './src/st/settings.js';
import { campaign, loadForCurrentChat, clearActive, saveMeta } from './src/st/campaign.js';
import { runTurn, askDmNow, loadDeck, syncPartyHp, isRunning, stopAll, levelUp } from './src/st/orchestrator.js';
import { refreshStandingPrompt, clearPrompts, injectDirection, clearDirection, stripReplyNamePrefix, cleanPartyReply, hideNarrationFromBot, addNoteToChat, briefForMessage } from './src/st/actors.js';
import { syncTtsTakeover, voiceLine, stopVoices, ttsConfig } from './src/st/voices.js';
import { toggleMap, refreshMap, closeMap } from './src/ui/map.js';
import { postDiceCard } from './src/st/messages.js';
import { forgetAll, flushWrites } from './src/st/storage.js';
import { recap } from './src/st/dm.js';
import { mountSettingsPanel, renderSpend, refreshProfileSelects } from './src/ui/settings-panel.js';
import { mountPersonaButton } from './src/ui/persona.js';
import { toggleScreen, renderScreen, runResync } from './src/ui/screen.js';
import { openWizard } from './src/ui/wizard.js';
import { hideStatus } from './src/ui/status.js';
import { roll } from './src/core/dice.js';
import { startDiceWatch } from './src/st/dicewatch.js';
import { npcForName } from './src/st/npccards.js';
import { forgetPlaces, loadCurrentPlace, requestBuild, rebuildPlace } from './src/st/atlas.js';
import { onMessagesDeleted, forgetTurns } from './src/st/undo.js';
import { registerCampaignChat, onChatDeleted } from './src/st/cleanup.js';
import { ensureFigures, redoFigure, partyFigures } from './src/st/figures.js';
import { openFiguresWindow } from './src/ui/figures-window.js';

let pendingUserMessage = false;
const BREAK_HOURS = 6;

async function onChatChanged() {
    pendingUserMessage = false;
    stopVoices();
    closeMap();
    // Finish the previous campaign's queued saves before its files are reloaded or dropped.
    try {
        await flushWrites();
    } catch (error) {
        console.error('[Dungeon Master] Saving before the chat change failed', error);
    }
    forgetAll();
    forgetPlaces();
    clearActive();
    clearPrompts();
    hideStatus();
    try {
        const c = await loadForCurrentChat();
        if (c) {
            registerCampaignChat(c);
            await loadCurrentPlace(c);
            // Map figures for the player and companions who don't have one yet (in the background).
            ensureFigures(c);
            syncPartyHp();
            const away = (Date.now() - (c.meta.session?.lastActivity || Date.now())) / 3600000;
            if (away >= BREAK_HOURS) {
                c.meta.session = { startedAt: Date.now(), lastActivity: Date.now() };
                saveMeta();
                offerRecap(away);
            }
            if (!c.meta.paused) refreshStandingPrompt();
        }
    } catch (error) {
        console.error('[Dungeon Master] Could not load the campaign', error);
        toastr.error('Could not load this chat\'s campaign files. See the console.', 'Dungeon Master');
    }
    const active = campaign();
    syncTtsTakeover(Boolean(active && !active.meta.paused));
    if (active?.docs.world.combat?.map || active?.docs.world.sceneMap?.map || active?.docs.world.place) refreshMap();
    renderScreen();
    updateMenuState();
}

function offerRecap(hours) {
    const t = toastr.info(`Welcome back! It's been ${Math.round(hours)} hours. Click here for a "Previously on…" recap.`, 'Dungeon Master', {
        timeOut: 20000,
        extendedTimeOut: 10000,
        onclick: async () => {
            toastr.clear(t);
            try {
                const { postNarration } = await import('./src/st/messages.js');
                const r = await recap();
                await postNarration(`**Previously…** ${r.text}`);
            } catch (error) {
                toastr.error(String(error?.message || error), 'Dungeon Master');
            }
        },
    });
}

function onMessageSent(messageId) {
    const c = campaign();
    if (!c || c.meta.paused || !settings().enabled) return;
    const m = ST.chat[messageId];
    if (!m?.is_user || m.is_system) return;
    pendingUserMessage = true;
    // Single-character chats (no group wrapper) wouldn't fire GROUP_WRAPPER_FINISHED.
    if (!ST.selectedGroup) setTimeout(() => maybeRun(), 300);
}

function onGroupWrapperFinished() {
    maybeRun();
}

function maybeRun() {
    if (!pendingUserMessage) return;
    pendingUserMessage = false;
    // Let SillyTavern finish its own bookkeeping first.
    setTimeout(() => runTurn().finally(() => { renderScreen(); renderSpend(); }), 60);
}

function updateMenuState() {
    const c = campaign();
    $('#dm-menu-screen').toggle(true);
    $('#dm-menu-step-in').toggle(Boolean(c));
    $('#dm-menu-map').toggle(Boolean(c));
}

function addWandMenu() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('dm-menu-start')) return;
    const items = [
        ['dm-menu-start', 'fa-dice-d20', 'Start D&D campaign', () => openWizard()],
        ['dm-menu-screen', 'fa-scroll', 'DM Screen', () => toggleScreen()],
        ['dm-menu-step-in', 'fa-hat-wizard', 'DM: step in now', () => runTurn({ force: 'manual' })],
        ['dm-menu-map', 'fa-chess-board', 'Map', () => toggleMap()],
        ['dm-menu-resync', 'fa-rotate', 'DM: fix mismatch with chat', () => runResync()],
        ['dm-menu-figures', 'fa-person-rays', 'Map figures', () => openFiguresWindow()],
    ];
    for (const [id, icon, label, fn] of items) {
        const el = document.createElement('div');
        el.id = id;
        el.className = 'list-group-item flex-container flexGap5 interactable';
        el.tabIndex = 0;
        el.innerHTML = `<div class="fa-solid ${icon} extensionsMenuExtensionButton"></div><span>${label}</span>`;
        el.addEventListener('click', fn);
        menu.appendChild(el);
    }
}

function registerSlashCommands() {
    const ctx = SillyTavern.getContext();
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx;
    if (!SlashCommandParser?.addCommandObject) return;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dm',
        helpString: 'Ask the Dungeon Master something out of character, or with no text, have the DM step in now.',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'question', typeList: [ARGUMENT_TYPE.STRING], isRequired: false })],
        callback: async (_args, text) => {
            await askDmNow(String(text || '').trim());
            return '';
        },
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dmroll',
        helpString: 'Roll dice with the Dungeon Master\'s roller and show a dice card, e.g. /dmroll 2d6+3',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'dice notation', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        callback: async (_args, text) => {
            const r = roll(String(text || '1d20'));
            if (!r) {
                toastr.warning('Couldn\'t read that dice notation. Try 1d20+5 or 2d6.', 'Dungeon Master');
                return '';
            }
            await postDiceCard(`🎲 ${r.notation}: ${r.detail} = **${r.total}**`);
            return String(r.total);
        },
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dmscreen',
        helpString: 'Open or close the DM Screen.',
        callback: async () => {
            toggleScreen();
            return '';
        },
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dmmap',
        helpString: 'Open or close the battle map.',
        callback: async () => {
            toggleMap();
            return '';
        },
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dmbuild',
        helpString: 'Build a map for a place, e.g. /dmbuild big Blackmoor Manor, or /dmbuild small Hollowbrook village. A place that already has a map is reopened, never rebuilt.',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'big|small and the place name', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        callback: async (_args, text) => {
            const m = String(text || '').trim().match(/^(big|small)\s+(.+)$/i);
            if (!campaign() || !m) {
                toastr.warning('Use it like /dmbuild big Blackmoor Manor in a campaign chat.', 'Dungeon Master');
                return '';
            }
            const name = m[2].trim();
            const kind = /(town|village|hamlet|city)/i.exec(name)?.[1] ?? '';
            try {
                await requestBuild({ name, size: m[1].toLowerCase(), kind: kind.toLowerCase(), why: 'the player asked for it' });
            } catch (error) {
                toastr.error(String(error?.message || error), 'Dungeon Master');
            }
            return '';
        },
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dmrebuild',
        helpString: 'Throw a saved map away and build it again with the newest rules: /dmrebuild for the map you\'re on, or /dmrebuild Blackmoor Manor. Asks first.',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'the place name (optional: the map you\'re on)', typeList: [ARGUMENT_TYPE.STRING], isRequired: false })],
        callback: async (_args, text) => {
            if (!campaign()) {
                toastr.warning('Use it in a campaign chat.', 'Dungeon Master');
                return '';
            }
            try {
                await rebuildPlace(String(text || '').trim());
            } catch (error) {
                toastr.error(String(error?.message || error), 'Dungeon Master');
            }
            return '';
        },
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dmfigure',
        helpString: 'Redraw the little map figure for you or a companion, with your own instructions if you like: /dmfigure Judy give her a red cloak and a bow',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'name, then your instructions (optional)', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        callback: async (_args, text) => {
            const raw = String(text || '').trim();
            // The longest party name (or first name) the text starts with; the rest is the instructions.
            const names = partyFigures().flatMap(f => [f.name, f.name.split(/\s+/)[0]]).sort((a, b) => b.length - a.length);
            const hit = names.find(n => raw.toLowerCase().startsWith(n.toLowerCase()));
            const custom = hit ? raw.slice(hit.length).replace(/^[\s:,-]+/, '') : '';
            try {
                toastr.info('Drawing the map figure…', 'Dungeon Master', { timeOut: 2500 });
                await redoFigure(hit ?? raw, custom || null);
                toastr.success('New map figure ready. /dmfigures shows it.', 'Dungeon Master', { timeOut: 3000 });
            } catch (error) {
                toastr.error(String(error?.message || error), 'Dungeon Master');
            }
            return '';
        },
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dmfigures',
        helpString: 'See your party\'s little map figures (animated) and redraw them with your own instructions.',
        callback: async () => {
            openFiguresWindow();
            return '';
        },
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dmresync',
        helpString: 'After deleting or editing messages: Claude re-reads the chat and fixes what the DM has logged.',
        callback: async () => {
            await runResync();
            return '';
        },
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dmlevel',
        helpString: 'Set a companion\'s level, e.g. /dmlevel Judy 5 (Claude rewrites their sheet).',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'name and level', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        callback: async (_args, text) => {
            const c = campaign();
            const m = String(text || '').trim().match(/^(.+?)\s+(\d{1,2})$/);
            const member = c && m ? c.meta.party.find(p => p.name.toLowerCase().startsWith(m[1].trim().toLowerCase())) : null;
            if (!member) {
                toastr.warning('Use it like /dmlevel Judy 5 in a campaign chat.', 'Dungeon Master');
                return '';
            }
            await levelUp(c, member, Number(m[2]));
            renderScreen();
            return '';
        },
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dmstart',
        helpString: 'Start a new D&D campaign.',
        callback: async () => {
            await openWizard();
            return '';
        },
    }));
}

/** The version of the code this browser actually loaded (keep equal to manifest.json; a test checks). */
export const LOADED_VERSION = '0.27.0-beta';

/**
 * After an update, browsers can keep running the old cached plugin code while SillyTavern shows
 * the new version number. Compare and tell the player to hard-refresh.
 */
async function checkLoadedVersion() {
    try {
        const res = await fetch(`/${EXT_PATH}/manifest.json`, { cache: 'no-store' });
        const onServer = (await res.json())?.version;
        if (onServer && onServer !== LOADED_VERSION) {
            toastr.warning(`Dungeon Master was updated to ${onServer}, but this page is still running ${LOADED_VERSION} from the browser cache. Press Ctrl+Shift+R to load the new version.`, 'Dungeon Master', { timeOut: 0, extendedTimeOut: 0 });
        }
    } catch { /* offline or blocked: nothing to compare */ }
}

// SillyTavern generation interceptor (named in manifest.json): hides the DM's narration from the bot.
globalThis.dungeonMasterInterceptor = async (chat) => {
    hideNarrationFromBot(chat);
    addNoteToChat(chat);
};

jQuery(async () => {
    settings();
    try {
        await mountSettingsPanel({ onStart: () => openWizard(), onScreen: () => toggleScreen() });
    } catch (error) {
        console.error('[Dungeon Master] settings panel failed', error);
    }
    addWandMenu();
    mountPersonaButton();
    registerSlashCommands();
    loadDeck();

    const { eventSource, eventTypes } = ST;
    eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
    eventSource.on(eventTypes.MESSAGE_SENT, onMessageSent);
    // A deleted campaign chat takes its campaign files, maps and NPC cards with it (after asking).
    for (const ev of [eventTypes.CHAT_DELETED, eventTypes.GROUP_CHAT_DELETED]) if (ev) eventSource.on(ev, id => onChatDeleted(id).catch(error => console.error('[Dungeon Master] cleanup failed', error)));
    startDiceWatch(() => setTimeout(() => runTurn().finally(() => { renderScreen(); renderSpend(); }), 60));
    eventSource.on(eventTypes.GROUP_WRAPPER_FINISHED, onGroupWrapperFinished);
    eventSource.on(eventTypes.GENERATION_STOPPED, () => {
        if (!isRunning()) {
            stopAll();
            clearDirection();
        }
    });
    // Swipes/regenerates of a party member's reply happen outside the turn loop:
    // give the character the same brief that reply was written with (or none, for free roleplay).
    eventSource.on(eventTypes.GROUP_MEMBER_DRAFTED, (chId) => {
        const c = campaign();
        if (!c || c.meta.paused || isRunning()) return;
        const name = ST.characters[chId]?.name;
        const last = ST.chat[ST.chat.length - 1];
        const saved = name && last && !last.is_user && last.name === name ? briefForMessage(last) : null;
        const npc = npcForName(name);
        if (saved || npc || c.meta.party.some(p => p.name === name)) injectDirection(saved?.brief ?? '', saved?.length ?? 'normal', npc, name);
    });
    // Group chats prefix the reply with "Name:", which breaks thinking models. Campaign chats only.
    eventSource.on(eventTypes.GENERATE_AFTER_COMBINE_PROMPTS, stripReplyNamePrefix);
    // Party replies (swipes included): remove an echoed "Name:", then voice them in order.
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, async (id) => {
        try {
            await cleanPartyReply(id);
            const c = campaign();
            const msg = ST.chat[Number(id)];
            if (c && !c.meta.paused && msg && !msg.is_user && c.meta.party.some(p => p.name === msg.name)) {
                voiceLine({ kind: 'party', name: msg.name, text: msg.mes });
            } else if (c && !c.meta.paused && msg && !msg.is_user) {
                const npc = npcForName(msg.name);
                if (npc) voiceLine({ kind: 'npc', name: npc.name, text: msg.mes, voice: npc.voice });
            }
        } catch (error) {
            console.warn('[Dungeon Master] party reply handling failed', error);
        }
    });
    eventSource.on(eventTypes.USER_MESSAGE_RENDERED, (id) => {
        const c = campaign();
        const msg = ST.chat[Number(id)];
        if (c && !c.meta.paused && msg?.is_user && ttsConfig().rules.narrate_user) voiceLine({ kind: 'party', name: msg.name, text: msg.mes });
    });
    eventSource.on(eventTypes.MESSAGE_SWIPED, () => { if (campaign()) stopVoices(); });
    // Deleting a DM turn's narration undoes what that turn did to HP, items and the map.
    if (eventTypes.MESSAGE_DELETED) eventSource.on(eventTypes.MESSAGE_DELETED, () => { if (campaign()) onMessagesDeleted().catch(err => console.warn('[Dungeon Master] undo failed', err)); });
    eventSource.on(eventTypes.CHAT_CHANGED, forgetTurns);
    eventSource.on(eventTypes.GENERATION_ENDED, () => { if (!isRunning()) clearDirection(); });
    if (eventTypes.CONNECTION_PROFILE_LOADED) eventSource.on(eventTypes.CONNECTION_PROFILE_LOADED, refreshProfileSelects);
    if (eventTypes.SETTINGS_UPDATED) eventSource.on(eventTypes.SETTINGS_UPDATED, () => renderSpend());

    // A chat may already be open. If not, make sure SillyTavern's TTS isn't left paused by us.
    if (ST.chatMetadata && Object.keys(ST.chatMetadata).length) await onChatChanged();
    else syncTtsTakeover(false);
    checkLoadedVersion();
    console.log(`[Dungeon Master] Ready (${MODULE} ${LOADED_VERSION}).`);
});
