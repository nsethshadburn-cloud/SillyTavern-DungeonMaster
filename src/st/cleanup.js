// When a campaign's chat is deleted, its campaign goes with it: the campaign files (bible, plot,
// notes, story, world, logs), every map in its atlas, and the NPC character cards made for it.
// The extension keeps a small index (campaign id -> chat) in its settings so it knows which
// campaign a deleted chat belonged to, since the chat's own data is already gone by then.
// It always asks first.

import { ST } from './st.js';
import { settings } from './settings.js';
import { FILES, fileName } from './campaign.js';
import { readJson } from './storage.js';

/** Remember which chat a campaign lives in (called whenever a campaign chat is opened). */
export function registerCampaignChat(c) {
    if (!c?.meta?.id) return;
    const s = settings();
    s.campaignIndex ??= {};
    const chat = String(ST.context().getCurrentChatId?.() ?? '');
    const prev = s.campaignIndex[c.meta.id];
    if (prev?.chat === chat && prev?.title === c.meta.title) return;
    s.campaignIndex[c.meta.id] = { chat, group: ST.selectedGroup || null, title: c.meta.title };
    ST.saveSettingsDebounced();
}

async function deleteUserFile(name) {
    const res = await fetch('/api/files/delete', { method: 'POST', headers: ST.getRequestHeaders(), body: JSON.stringify({ path: `user/files/${name}` }) });
    return res.ok || res.status === 404;
}

async function deleteCharacter(avatar) {
    const res = await fetch('/api/characters/delete', { method: 'POST', headers: ST.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar, delete_chats: true }) });
    return res.ok;
}

/** SillyTavern deleted a chat (or a group with its chats): offer to delete that campaign's files too. */
export async function onChatDeleted(chatId) {
    const s = settings();
    const id = String(chatId ?? '').replace(/\.jsonl$/, '');
    const hits = Object.entries(s.campaignIndex || {}).filter(([, e]) => e.chat === id);
    for (const [campaignId, entry] of hits) {
        const files = Object.keys(FILES).map(k => fileName(campaignId, k));
        const atlasDoc = await readJson(fileName(campaignId, 'atlas'), { places: {} });
        const placeFiles = Object.values(atlasDoc?.places || {}).map(p => p.file).filter(Boolean);
        const npcs = await readJson(fileName(campaignId, 'npcs'), []);
        const avatars = (Array.isArray(npcs) ? npcs : []).map(n => n.avatar).filter(Boolean);
        const ok = await ST.callGenericPopup(
            `<h3>Delete the campaign too?</h3><p>That chat was the D&amp;D campaign <b>${escapeHtml(entry.title || campaignId)}</b>.</p><p>Also delete its files (story, notes, plot, ${placeFiles.length} map${placeFiles.length === 1 ? '' : 's'}) and its ${avatars.length} NPC character card${avatars.length === 1 ? '' : 's'}?</p>`,
            ST.POPUP_TYPE.CONFIRM, '', { okButton: 'Delete them', cancelButton: 'Keep them' });
        if (ok !== ST.POPUP_RESULT.AFFIRMATIVE && ok !== true && ok !== 1) continue;
        let removed = 0, failed = 0;
        for (const name of [...files, ...placeFiles]) (await deleteUserFile(name).catch(() => false)) ? removed++ : failed++;
        let cards = 0;
        for (const avatar of avatars) if (await deleteCharacter(avatar).catch(() => false)) cards++;
        if (cards) await ST.getCharacters();
        delete s.campaignIndex[campaignId];
        ST.saveSettingsDebounced();
        toastr.success(`Deleted ${removed} campaign file${removed === 1 ? '' : 's'} and ${cards} NPC card${cards === 1 ? '' : 's'}${failed ? ` (${failed} couldn't be deleted)` : ''}.`, 'Dungeon Master');
    }
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
