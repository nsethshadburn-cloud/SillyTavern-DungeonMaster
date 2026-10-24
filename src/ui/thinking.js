// A "Dungeon Master is thinking…" bubble at the bottom of the chat while Claude works, so the
// screen doesn't look idle. Display only: it is never added to the chat or saved.

import { EXT_PATH } from '../st/st.js';

let bubble = null;

export function showDmThinking(label = 'The Dungeon Master is thinking') {
    const chat = document.getElementById('chat');
    if (!chat) return;
    if (!bubble) {
        bubble = document.createElement('div');
        bubble.className = 'mes dm-thinking';
        bubble.innerHTML = `<div class="mesAvatarWrapper"><div class="avatar"><img src="/${EXT_PATH}/assets/dm.svg" alt=""></div></div>
<div class="mes_block"><div class="ch_name"><span class="name_text">Dungeon Master</span></div>
<div class="mes_text"><span class="dm-thinking-label"></span><span class="dm-dots"><i></i><i></i><i></i></span></div></div>`;
    }
    bubble.querySelector('.dm-thinking-label').textContent = label;
    chat.appendChild(bubble);
    bubble.scrollIntoView({ block: 'end', behavior: 'smooth' });
}

export function hideDmThinking() {
    bubble?.remove();
}

/** Show the bubble while fn runs. */
export async function withDmThinking(label, fn) {
    showDmThinking(label);
    try {
        return await fn();
    } finally {
        hideDmThinking();
    }
}
