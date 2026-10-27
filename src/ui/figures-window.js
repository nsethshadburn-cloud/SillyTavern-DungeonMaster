// The Map figures window: your persona and companions as their little animated map figures, with
// a box for your own instructions ("give her a red cloak and a bow") and a Redraw button.

import { ST } from '../st/st.js';
import { campaign } from '../st/campaign.js';
import { partyFigures, redoFigure, figureFor } from '../st/figures.js';
import { drawFigure } from './sprite-render.js';
import { escapeHtml } from '../core/text.js';

const ANIMS = [['all', 'All'], ['idle', 'Idle'], ['walk', 'Walk'], ['attack', 'Attack'], ['hurt', 'Hurt'], ['down', 'Down']];
const CYCLE = ['idle', 'walk', 'attack', 'hurt', 'down'];
const SCALE = 4;

export function openFiguresWindow() {
    const c = campaign();
    if (!c) {
        toastr.info('Open a campaign chat to see its map figures.', 'Dungeon Master');
        return;
    }
    const root = document.createElement('div');
    root.className = 'dm-figures';
    root.innerHTML = `<h3>Map figures</h3>
<p class="dm-muted">How you and your companions look on the map. Write what you'd like changed and press <b>Redraw</b>: Claude redraws the figure from the card, the picture and your instructions (about 1-2 cents). Your instructions are kept for later redraws; <b>Back to the card</b> drops them.</p>
<div class="dm-figures-list"></div>`;
    const list = root.querySelector('.dm-figures-list');
    const cards = [];
    for (const f of partyFigures(c)) {
        const card = document.createElement('div');
        card.className = 'dm-figure-card';
        card.innerHTML = `
<div class="dm-figure-stage"><canvas width="${24 * SCALE}" height="${24 * SCALE}"></canvas></div>
<div class="dm-figure-side">
  <div class="dm-figure-name"><b>${escapeHtml(f.name)}</b> <small class="dm-muted">${f.kind === 'persona' ? 'you' : 'companion'}${f.drawn ? '' : ' · stand-in until Claude draws it'}</small></div>
  <div class="dm-figure-anims">${ANIMS.map(([k, label]) => `<span class="dm-figure-anim${k === 'all' ? ' on' : ''}" data-anim="${k}">${label}</span>`).join('')}</div>
  <textarea class="text_pole" rows="2" placeholder="Your instructions, e.g. &quot;give her a red cloak and a bow&quot; or &quot;he's a fox, not a wolf&quot;">${escapeHtml(f.wishes || '')}</textarea>
  <div class="dm-figure-buttons">
    <div class="menu_button" data-act="redraw"><i class="fa-solid fa-wand-magic-sparkles"></i> Redraw</div>
    <div class="menu_button" data-act="reset" title="Redraw from the card and picture only, without your instructions">Back to the card</div>
    <span class="dm-figure-status dm-muted"></span>
  </div>
</div>`;
        list.appendChild(card);
        const state = { name: f.name, look: f.look, anim: 'all', canvas: card.querySelector('canvas'), card };
        cards.push(state);
        card.querySelectorAll('.dm-figure-anim').forEach(el => el.addEventListener('click', () => {
            card.querySelectorAll('.dm-figure-anim').forEach(x => x.classList.toggle('on', x === el));
            state.anim = el.dataset.anim;
        }));
        const status = card.querySelector('.dm-figure-status');
        const run = async custom => {
            const buttons = card.querySelectorAll('.menu_button');
            buttons.forEach(b => b.classList.add('disabled'));
            status.textContent = 'Claude is drawing…';
            try {
                state.look = await redoFigure(f.name, custom);
                card.querySelector('.dm-figure-name small').textContent = f.kind === 'persona' ? 'you' : 'companion';
                status.textContent = 'Done.';
                if (custom === '') card.querySelector('textarea').value = '';
            } catch (error) {
                status.textContent = String(error?.message || error);
            } finally {
                buttons.forEach(b => b.classList.remove('disabled'));
            }
        };
        card.querySelector('[data-act="redraw"]').addEventListener('click', () => run(card.querySelector('textarea').value.trim()));
        card.querySelector('[data-act="reset"]').addEventListener('click', () => run(''));
    }

    // Animate the previews while the window is open (cheap: a few small canvases).
    const start = performance.now();
    const tick = () => {
        if (!root.isConnected && performance.now() - start > 2000) return;
        const t = performance.now() - start;
        for (const s of cards) {
            const ctx = s.canvas.getContext('2d');
            ctx.clearRect(0, 0, s.canvas.width, s.canvas.height);
            const anim = s.anim === 'all' ? CYCLE[Math.floor(t / 1600) % CYCLE.length] : s.anim;
            const elapsed = s.anim === 'all' ? t % 1600 : (anim === 'attack' || anim === 'hurt' ? t % 1100 : t);
            drawFigure(ctx, s.look ?? figureFor(s.name), 0, 0, s.canvas.width, { anim, elapsed, red: anim === 'hurt' && Math.floor(elapsed / 120) % 2 === 0 });
        }
        setTimeout(() => requestAnimationFrame(tick), 100);
    };
    tick();
    ST.callGenericPopup(root, ST.POPUP_TYPE.TEXT, '', { wide: true, okButton: 'Close', allowVerticalScrolling: true });
}
