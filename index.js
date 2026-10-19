// Dungeon Master for SillyTavern: Claude runs the campaign, your local model plays the characters.
// See DESIGN.md for how it all fits together.

import { ST, MODULE } from './src/st/st.js';
import { settings } from './src/st/settings.js';
import { campaign, loadForCurrentChat, clearActive, saveMeta } from './src/st/campaign.js';
import { runTurn, askDmNow, loadDeck, syncPartyHp, isRunning, stopAll } from './src/st/orchestrator.js';
import { refreshStandingPrompt, clearPrompts, injectDirection, clearDirection, stripReplyNamePrefix, cleanPartyReply } from './src/st/actors.js';
import { postDiceCard } from './src/st/messages.js';
import { forgetAll } from './src/st/storage.js';
import { recap } from './src/st/dm.js';
import { mountSettingsPanel, renderSpend, refreshProfileSelects } from './src/ui/settings-panel.js';
import { mountPersonaButton } from './src/ui/persona.js';
import { toggleScreen, renderScreen } from './src/ui/screen.js';
import { openWizard } from './src/ui/wizard.js';
import { hideStatus } from './src/ui/status.js';
import { roll } from './src/core/dice.js';

let pendingUserMessage = false;
const BREAK_HOURS = 6;

async function onChatChanged() {
    pendingUserMessage = false;
    forgetAll();
    clearActive();
    clearPrompts();
    hideStatus();
    try {
        const c = await loadForCurrentChat();
        if (c) {
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
}

function addWandMenu() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('dm-menu-start')) return;
    const items = [
        ['dm-menu-start', 'fa-dice-d20', 'Start D&D campaign', () => openWizard()],
        ['dm-menu-screen', 'fa-scroll', 'DM Screen', () => toggleScreen()],
        ['dm-menu-step-in', 'fa-hat-wizard', 'DM: step in now', () => runTurn({ force: 'manual' })],
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
        name: 'dmstart',
        helpString: 'Start a new D&D campaign.',
        callback: async () => {
            await openWizard();
            return '';
        },
    }));
}

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
    eventSource.on(eventTypes.GROUP_WRAPPER_FINISHED, onGroupWrapperFinished);
    eventSource.on(eventTypes.GENERATION_STOPPED, () => {
        if (!isRunning()) {
            stopAll();
            clearDirection();
        }
    });
    // Swipes/regenerates of a party member's reply happen outside the turn loop:
    // give the character the same stage direction that reply was written with.
    eventSource.on(eventTypes.GROUP_MEMBER_DRAFTED, (chId) => {
        const c = campaign();
        if (!c || c.meta.paused || isRunning()) return;
        const name = ST.characters[chId]?.name;
        const last = ST.chat[ST.chat.length - 1];
        const direction = name && last && !last.is_user && last.name === name ? last.extra?.dm_direction : '';
        if (direction) injectDirection(name, direction);
    });
    // Group chats prefix the reply with "Name:", which breaks thinking models. Campaign chats only.
    eventSource.on(eventTypes.GENERATE_AFTER_COMBINE_PROMPTS, stripReplyNamePrefix);
    // Remove an echoed "Name:" from party replies, swipes included (registered before TTS reads it).
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, (id) => cleanPartyReply(id).catch(() => { }));
    eventSource.on(eventTypes.GENERATION_ENDED, () => { if (!isRunning()) clearDirection(); });
    if (eventTypes.CONNECTION_PROFILE_LOADED) eventSource.on(eventTypes.CONNECTION_PROFILE_LOADED, refreshProfileSelects);
    if (eventTypes.SETTINGS_UPDATED) eventSource.on(eventTypes.SETTINGS_UPDATED, () => renderSpend());

    // A chat may already be open.
    if (ST.chatMetadata && Object.keys(ST.chatMetadata).length) await onChatChanged();
    console.log(`[Dungeon Master] Ready (${MODULE}).`);
});
