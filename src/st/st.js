// The one place that imports SillyTavern internals. Everything else goes through here,
// so if a SillyTavern update moves something, only this file needs fixing.
// Served from /scripts/extensions/third-party/SillyTavern-DungeonMaster/src/st/

import {
    is_send_press,
    chat,
    chat_metadata,
    characters,
    eventSource,
    event_types,
    getRequestHeaders,
    saveSettingsDebounced,
    saveChatConditional,
    addOneMessage,
    updateMessageBlock,
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
    Generate,
    generateRaw,
    substituteParams,
    getCharacters,
    name1,
    main_api,
    max_context,
    amount_gen,
    messageFormatting,
    deactivateSendButtons,
    activateSendButtons,
    stopGeneration,
} from '../../../../../../script.js';
import { extension_settings, saveMetadataDebounced } from '../../../../../extensions.js';
import { groups, selected_group, is_group_generating, openGroupById, editGroup } from '../../../../../group-chats.js';
import { user_avatar } from '../../../../../personas.js';
import { power_user } from '../../../../../power-user.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT, Popup } from '../../../../../popup.js';
import { loadWorldInfo, METADATA_KEY as WORLD_INFO_KEY } from '../../../../../world-info.js';

export const MODULE = 'dungeon_master';
export const EXT_PATH = 'scripts/extensions/third-party/SillyTavern-DungeonMaster';

export const ST = {
    get chat() { return chat; },
    get chatMetadata() { return chat_metadata; },
    get characters() { return characters; },
    get groups() { return groups; },
    get selectedGroup() { return selected_group; },
    get isBusy() { return Boolean(is_send_press || is_group_generating); },
    get userName() { return name1; },
    get userAvatar() { return user_avatar; },
    get mainApi() { return main_api; },
    get maxContext() { return Number(max_context) || 0; },
    get responseLength() { return Number(amount_gen) || 0; },
    get powerUser() { return power_user; },
    get extensionSettings() { return extension_settings; },
    eventSource,
    eventTypes: event_types,
    getRequestHeaders,
    saveSettingsDebounced,
    saveChat: saveChatConditional,
    saveMetadataDebounced,
    addOneMessage,
    updateMessageBlock,
    setExtensionPrompt,
    promptTypes: extension_prompt_types,
    promptRoles: extension_prompt_roles,
    Generate,
    generateRaw,
    substituteParams,
    getCharacters,
    openGroupById,
    editGroup,
    messageFormatting,
    deactivateSendButtons,
    activateSendButtons,
    stopGeneration,
    callGenericPopup,
    Popup,
    POPUP_TYPE,
    POPUP_RESULT,
    loadWorldInfo,
    WORLD_INFO_KEY,
    context: () => SillyTavern.getContext(),
};

export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Wait until SillyTavern isn't generating anything. */
export async function waitUntilIdle(timeoutMs = 120000) {
    const start = Date.now();
    while (ST.isBusy) {
        if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for SillyTavern to finish generating.');
        await sleep(150);
    }
}

/** The group object for the current chat, if any. */
export function currentGroup() {
    if (!selected_group) return null;
    return groups.find(g => g.id === selected_group) ?? null;
}

/** Character index (chid) for a character name or avatar. */
export function findCharacterIndex(nameOrAvatar) {
    const key = String(nameOrAvatar ?? '').toLowerCase();
    let idx = characters.findIndex(c => c.avatar?.toLowerCase() === key);
    if (idx === -1) idx = characters.findIndex(c => c.name?.toLowerCase() === key);
    return idx;
}

/** Display name for a persona avatar id. */
export function personaName(avatar) {
    return power_user.personas?.[avatar] || name1;
}

export function personaDescription(avatar) {
    return power_user.persona_descriptions?.[avatar]?.description || '';
}
