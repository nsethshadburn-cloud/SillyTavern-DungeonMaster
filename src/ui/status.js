// Live status bar shown just above the chat input while the Dungeon Master works.
// It is plain page UI: never saved into the chat and never sent to any model.

import { escapeHtml } from '../core/text.js';
import { formatUsd } from '../core/budget.js';
import { settings } from '../st/settings.js';

const ICONS = { run: '⏳', ok: '✓', fail: '✗', skip: '·', info: 'ℹ' };
const history = []; // recent finished turns for the DM Screen

let root = null;
let current = null;

function ensureRoot() {
    if (root && document.body.contains(root)) return root;
    root = document.createElement('div');
    root.id = 'dm-status';
    root.className = 'dm-status dm-hidden';
    root.innerHTML = '<div class="dm-status-head"><span class="dm-status-title"></span><span class="dm-status-meta"></span><span class="dm-status-toggle fa-solid fa-chevron-down" title="Show steps"></span><span class="dm-status-close fa-solid fa-xmark" title="Hide"></span></div><ol class="dm-status-steps"></ol>';
    const anchor = document.getElementById('form_sheld');
    if (anchor?.parentElement) anchor.parentElement.insertBefore(root, anchor);
    else document.body.appendChild(root);
    root.querySelector('.dm-status-toggle').addEventListener('click', () => root.classList.toggle('dm-collapsed'));
    root.querySelector('.dm-status-close').addEventListener('click', () => root.classList.add('dm-hidden'));
    return root;
}

class Step {
    constructor(turn, label) {
        this.turn = turn;
        this.label = label;
        this.state = 'run';
        this.started = performance.now();
        this.detail = '';
        this.usd = 0;
        this.el = document.createElement('li');
        this.turn.list?.appendChild(this.el);
        this.render();
    }

    render() {
        const secs = this.ended ? ((this.ended - this.started) / 1000).toFixed(1) + 's' : '';
        const parts = [secs, this.usd ? formatUsd(this.usd) : '', this.detail].filter(Boolean).join(' · ');
        this.el.className = `dm-step dm-step-${this.state}`;
        this.el.innerHTML = `<span class="dm-step-icon">${ICONS[this.state]}</span> <span class="dm-step-label">${escapeHtml(this.label)}</span>${parts ? ` <span class="dm-step-detail">${escapeHtml(parts)}</span>` : ''}`;
        this.turn.renderHead();
    }

    done(detail = '', usd = 0) {
        this.state = 'ok';
        this.ended = performance.now();
        this.detail = detail;
        this.usd = usd;
        this.turn.usd += usd;
        this.render();
    }

    skip(detail = '') {
        this.state = 'skip';
        this.ended = performance.now();
        this.detail = detail;
        this.render();
    }

    fail(error) {
        this.state = 'fail';
        this.ended = performance.now();
        this.detail = String(error?.message || error || 'failed').slice(0, 160);
        this.render();
    }
}

class Turn {
    constructor(title) {
        this.title = title;
        this.usd = 0;
        this.started = performance.now();
        this.steps = [];
        this.finished = false;
        const el = settings().showStatus ? ensureRoot() : null;
        if (el) {
            el.classList.remove('dm-hidden', 'dm-collapsed', 'dm-done', 'dm-error');
            this.list = el.querySelector('.dm-status-steps');
            this.list.innerHTML = '';
        }
        this.renderHead();
    }

    step(label) {
        const s = new Step(this, label);
        this.steps.push(s);
        return s;
    }

    note(label) {
        const s = new Step(this, label);
        s.state = 'info';
        s.ended = performance.now();
        s.render();
        this.steps.push(s);
        return s;
    }

    renderHead() {
        if (!root || !this.list) return;
        const secs = ((performance.now() - this.started) / 1000).toFixed(1);
        const running = this.steps.find(s => s.state === 'run');
        root.querySelector('.dm-status-title').textContent = this.finished ? this.title : `🎲 ${running ? running.label : this.title}…`;
        root.querySelector('.dm-status-meta').textContent = [this.usd ? `${formatUsd(this.usd)} est.` : '', `${secs}s`].filter(Boolean).join(' · ');
    }

    finish(summary = '') {
        this.finished = true;
        const failed = this.steps.some(s => s.state === 'fail');
        this.title = summary || (failed ? 'Turn finished with problems' : 'Turn done');
        this.renderHead();
        if (root && this.list) {
            root.classList.add(failed ? 'dm-error' : 'dm-done');
            if (settings().statusAutoCollapse && !failed) root.classList.add('dm-collapsed');
        }
        history.push({
            at: new Date().toLocaleTimeString(),
            title: this.title,
            usd: this.usd,
            secs: (performance.now() - this.started) / 1000,
            steps: this.steps.map(s => ({ label: s.label, state: s.state, detail: s.detail, usd: s.usd })),
        });
        if (history.length > 30) history.shift();
        if (current === this) current = null;
    }
}

/** Start a new status sequence. */
export function beginTurn(title) {
    if (current && !current.finished) current.finish('Interrupted');
    current = new Turn(title);
    return current;
}

export function turnHistory() {
    return history;
}

export function hideStatus() {
    root?.classList.add('dm-hidden');
}
