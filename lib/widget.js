/**
 * FloatingPanel — the draggable, always-on-top desktop widget.
 *
 * Layout (all St):
 *   root (vertical, fixed width)
 *   ├─ header   drag handle · title · status dots · refresh · collapse · settings · hide
 *   ├─ body     DeepSeek card + OpenRouter card
 *   └─ chip     collapsed summary row
 *
 * The widget is deliberately view-dumb: it renders whatever state the
 * extension hands it via updateDisplays() and reports user actions through
 * callbacks.
 */

import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {
    fmtMoney,
    fmtSigned,
    fmtDuration,
    fmtClock,
    fmtAgo,
    errorText,
} from './format.js';

const PANEL_WIDTH = 340;
const SPARK_HEIGHT = 36;

const SPARK_COLORS = {
    deepseek: { line: [0.30, 0.62, 1.0], fill: [0.30, 0.62, 1.0, 0.15] },
    openrouter: { line: [1.0, 0.54, 0.24], fill: [1.0, 0.54, 0.24, 0.15] },
};

/**
 * @param {object} opts
 *   settings   Gio.Settings (for collapse state only)
 *   callbacks  { onRefresh, onToggleCollapsed, onHide, onOpenSettings, onDragEnd }
 */
export class FloatingPanel {
    constructor({ callbacks }) {
        this._callbacks = callbacks;
        this._sparks = {};
        this._drag = null;
        this._motionId = 0;
        this._releaseId = 0;
        this._displays = null;
        this._build();
    }

    /* -------------------------------------------------------------- build */

    _build() {
        // Must be a BoxLayout: a plain St.Widget has no layout manager, so its
        // children are all allocated at the origin and the header draws over
        // the first card.
        this.actor = new St.BoxLayout({
            style_class: 'ptb-root',
            vertical: true,
            width: PANEL_WIDTH,
            reactive: true,
            can_focus: false,
        });

        this._header = new St.BoxLayout({
            style_class: 'ptb-header',
            reactive: true,
            can_focus: false,
            x_expand: true,
        });

        const title = new St.Label({ style_class: 'ptb-title', text: 'Price Track Buddy' });
        this._header.add_child(title);

        const spacer = new St.Widget({ x_expand: true });
        this._header.add_child(spacer);

        this._dots = {};
        for (const key of ['deepseek', 'openrouter']) {
            const dot = new St.Widget({ style_class: 'ptb-dot' });
            this._header.add_child(dot);
            this._dots[key] = dot;
        }

        this._btnRefresh = this._iconButton('view-refresh-symbolic', 'Refresh now');
        this._btnRefresh.connect('clicked', () => this._callbacks.onRefresh());
        this._header.add_child(this._btnRefresh);

        this._btnCollapse = this._iconButton('go-up-symbolic', 'Collapse');
        this._btnCollapse.connect('clicked', () => this._callbacks.onToggleCollapsed());
        this._header.add_child(this._btnCollapse);

        this._btnSettings = this._iconButton('emblem-system-symbolic', 'Settings');
        this._btnSettings.connect('clicked', () => this._callbacks.onOpenSettings());
        this._header.add_child(this._btnSettings);

        this._btnHide = this._iconButton('window-close-symbolic', 'Hide widget');
        this._btnHide.connect('clicked', () => this._callbacks.onHide());
        this._header.add_child(this._btnHide);

        this._body = new St.BoxLayout({
            style_class: 'ptb-body',
            vertical: true,
            x_expand: true,
        });
        this._cards = {
            deepseek: this._buildCard('deepseek'),
            openrouter: this._buildCard('openrouter'),
        };
        for (const key of ['deepseek', 'openrouter'])
            this._body.add_child(this._cards[key].card);

        this._chip = new St.BoxLayout({
            style_class: 'ptb-chip',
            reactive: true,
            can_focus: false,
            x_expand: true,
        });
        this._chipDotDs = new St.Widget({ style_class: 'ptb-dot' });
        this._chipDotOr = new St.Widget({ style_class: 'ptb-dot' });
        this._chipLabel = new St.Label({ style_class: 'ptb-chip-label', text: '—' });
        const chipSpacer = new St.Widget({ x_expand: true });
        this._chip.add_child(this._chipDotDs);
        this._chip.add_child(this._chipDotOr);
        this._chip.add_child(this._chipLabel);
        this._chip.add_child(chipSpacer);
        this._chip.connect('button-press-event', () => {
            this._callbacks.onToggleCollapsed();
            return Clutter.EVENT_STOP;
        });

        this.actor.add_child(this._header);
        this.actor.add_child(this._body);
        this.actor.add_child(this._chip);

        // Drag to move the whole panel.
        this._header.connect('button-press-event', (a, ev) => this._onPress(ev));
    }

    _iconButton(iconName, tooltip) {
        const btn = new St.Button({
            style_class: 'ptb-icon-btn',
            reactive: true,
            can_focus: true,
            child: new St.Icon({ icon_name: iconName, icon_size: 14 }),
        });
        return btn;
    }

    _buildCard(key) {
        const isDs = key === 'deepseek';
        const card = new St.BoxLayout({
            style_class: 'ptb-card',
            vertical: true,
            x_expand: true,
        });

        const head = new St.BoxLayout({ style_class: 'ptb-card-head', x_expand: true });
        const badge = new St.Label({
            style_class: `ptb-badge ${isDs ? 'ptb-badge-ds' : 'ptb-badge-or'}`,
            text: isDs ? 'DS' : 'OR',
        });
        const name = new St.Label({
            style_class: 'ptb-card-name',
            text: isDs ? 'DeepSeek' : 'OpenRouter',
        });
        const spacer = new St.Widget({ x_expand: true });
        const status = new St.Label({ style_class: 'ptb-card-status', text: '' });
        head.add_child(badge);
        head.add_child(name);
        head.add_child(spacer);
        head.add_child(status);
        card.add_child(head);

        const balanceRow = new St.BoxLayout({ style_class: 'ptb-balance-row', x_expand: true });
        const balance = new St.Label({ style_class: 'ptb-balance', text: '—', x_expand: true });
        const delta = new St.Label({ style_class: 'ptb-delta', text: '' });
        balanceRow.add_child(balance);
        balanceRow.add_child(delta);
        card.add_child(balanceRow);

        const sub = new St.Label({ style_class: 'ptb-sub', text: '' });
        card.add_child(sub);

        const stats = new St.BoxLayout({ style_class: 'ptb-stats', x_expand: true });
        const statCells = [];
        for (let i = 0; i < 3; i++) {
            const cell = new St.BoxLayout({ style_class: 'ptb-stat', vertical: true, x_expand: true });
            const value = new St.Label({ style_class: 'ptb-stat-value', text: '—' });
            const label = new St.Label({ style_class: 'ptb-stat-label', text: '' });
            cell.add_child(value);
            cell.add_child(label);
            stats.add_child(cell);
            statCells.push({ value, label });
        }
        card.add_child(stats);

        const spark = makeSparkActor(PANEL_WIDTH - 28, SPARK_HEIGHT, (cr, w, h) =>
            this._sparkDraw(key, cr, w, h));
        spark.actor.add_style_class_name('ptb-spark');
        this._sparks[key] = spark;
        card.add_child(spark.actor);

        let peak = null;
        if (isDs) {
            peak = new St.Label({ style_class: 'ptb-peak ptb-peak-off', text: '' });
            card.add_child(peak);
        }

        const meta = new St.Label({ style_class: 'ptb-meta', text: '' });
        card.add_child(meta);

        const error = new St.Label({
            style_class: 'ptb-error',
            text: '',
            visible: false,
            x_expand: true,
        });
        error.clutter_text.line_wrap = true; // eslint-disable-line no-undef
        card.add_child(error);

        return { card, status, balance, delta, sub, statCells, peak, meta, error };
    }

    /* -------------------------------------------------------------- states */

    setCollapsed(collapsed) {
        this._body.visible = !collapsed;
        this._chip.visible = collapsed;
        this._btnCollapse.child.icon_name = collapsed ? 'go-down-symbolic' : 'go-up-symbolic';
    }

    /**
     * displays: {
     *   deepseek:  { enabled, keySet, loading, error, reading, points, spentToday,
     *               spent7d, lifetimeSpent, toppedUpToday },
     *   openrouter: same shape,
     *   peak: { active, priceMultiplier, nextChangeIn, nextChangeLocal }
     * }
     */
    updateDisplays(displays) {
        this._displays = displays;
        for (const key of ['deepseek', 'openrouter'])
            this._updateCard(key, displays[key]);
        if (displays.peak)
            this._updatePeak(displays.peak);
        this._updateChip();
    }

    _updateCard(key, state) {
        const card = this._cards[key];
        const isDs = key === 'deepseek';
        const currency = state.reading?.currency ?? (isDs ? 'CNY' : 'USD');

        // Status dot + status text.
        const dot = this._dots[key];
        if (state.error)
            dot.style_class = 'ptb-dot ptb-dot-err';
        else if (!state.keySet)
            dot.style_class = 'ptb-dot';
        else
            dot.style_class = 'ptb-dot ptb-dot-ok';

        if (state.loading && !state.reading) {
            card.status.text = 'reading…';
        } else if (state.error) {
            card.status.text = state.error.code ?? 'error';
        } else if (!state.keySet) {
            card.status.text = 'not configured';
        } else if (state.reading) {
            card.status.text = fmtClock(state.reading.at);
        } else {
            card.status.text = '';
        }

        // Main figure.
        if (state.reading) {
            const main = isDs ? state.reading.total : state.reading.remaining;
            card.balance.text = fmtMoney(main, currency);
            const net = state.toppedUpToday - state.spentToday;
            card.delta.text = state.spentToday > 0 || state.toppedUpToday > 0
                ? fmtSigned(net, currency)
                : '';
            if (isDs) {
                card.sub.text = `granted ${fmtMoney(state.reading.granted, currency)} · ` +
                    `topped-up ${fmtMoney(state.reading.toppedUp, currency)}`;
            } else {
                card.sub.text = `purchased ${fmtMoney(state.reading.purchased, currency)} · ` +
                    `used ${fmtMoney(state.reading.usage, currency)}`;
            }
        } else {
            card.balance.text = '—';
            card.delta.text = '';
            card.sub.text = '';
        }

        // Stats.
        const spent = state.spentToday;
        const week = state.spent7d;
        const lifetime = state.lifetimeSpent;
        card.statCells[0].value.text = fmtMoney(spent, currency);
        card.statCells[0].label.text = 'spent today';
        card.statCells[1].value.text = fmtMoney(week, currency);
        card.statCells[1].label.text = 'last 7 days';
        card.statCells[2].value.text = fmtMoney(lifetime, currency);
        card.statCells[2].label.text = isDs ? 'lifetime' : 'lifetime';

        // Sparkline.
        this._sparks[key].refresh(state.points ?? []);

        // Error line.
        if (state.error) {
            card.error.text = `${errorText(state.error.code)} ${state.error.detail ? `(${state.error.detail})` : ''}`;
            card.error.visible = true;
        } else {
            card.error.text = '';
            card.error.visible = false;
        }
    }

    _updatePeak(peak) {
        const card = this._cards.deepseek;
        if (!card.peak)
            return;
        const label = peak.active
            ? `PEAK  ·  ${peak.priceMultiplier}× price  ·  ends in ${fmtDuration(peak.nextChangeIn)}`
            : `OFF-PEAK  ·  ½ price  ·  next peak ${peak.nextChangeLocal} in ${fmtDuration(peak.nextChangeIn)}`;
        card.peak.text = label;
        card.peak.style_class = `ptb-peak ${peak.active ? 'ptb-peak-peak' : 'ptb-peak-off'}`;
    }

    _updateChip() {
        if (!this._displays)
            return;
        const parts = [];
        for (const key of ['deepseek', 'openrouter']) {
            const s = this._displays[key];
            const dot = key === 'deepseek' ? this._chipDotDs : this._chipDotOr;
            if (s.error)
                dot.style_class = 'ptb-dot ptb-dot-err';
            else if (!s.keySet)
                dot.style_class = 'ptb-dot';
            else
                dot.style_class = 'ptb-dot ptb-dot-ok';

            if (s.reading) {
                const currency = s.reading.currency ?? (key === 'deepseek' ? 'CNY' : 'USD');
                const main = key === 'deepseek' ? s.reading.total : s.reading.remaining;
                parts.push(`${key === 'deepseek' ? 'DS' : 'OR'} ${fmtMoney(main, currency)}`);
            } else if (s.loading) {
                parts.push(`${key === 'deepseek' ? 'DS' : 'OR'} …`);
            } else {
                parts.push(`${key === 'deepseek' ? 'DS' : 'OR'} ✕`);
            }
        }
        this._chipLabel.text = parts.join('  ·  ');

        // Cards' meta line: updated time (if peaked, append peak note).
        for (const key of ['deepseek', 'openrouter']) {
            const s = this._displays[key];
            const card = this._cards[key];
            if (s.reading) {
                card.meta.text = `updated ${fmtAgo(s.reading.at)}`;
            } else if (s.loading) {
                card.meta.text = 'fetching…';
            } else {
                card.meta.text = 'no data yet';
            }
        }
    }

    /* ------------------------------------------------------------- sparkline */

    _sparkDraw(key, cr, w, h) {
        const pts = this._displays?.[key]?.points ?? [];
        if (pts.length === 0) {
            cr.setSourceRGBA(0.45, 0.48, 0.56, 0.35);
            cr.setLineWidth(1);
            cr.moveTo(0, h / 2);
            cr.lineTo(w, h / 2);
            cr.stroke();
            return;
        }

        let min = Infinity;
        let max = -Infinity;
        for (const p of pts) {
            if (p.total < min)
                min = p.total;
            if (p.total > max)
                max = p.total;
        }
        const span = max - min || Math.max(1e-9, Math.abs(max) * 0.01);
        const pad = 2;
        const W = Math.max(1, w - pad * 2);
        const H = Math.max(1, h - pad * 2);
        const t0 = pts[0].at;
        const t1 = pts[pts.length - 1].at;
        const X = (p) => pad + (t1 > t0 ? (p.at - t0) / (t1 - t0) : 0.5) * W;
        const Y = (v) => pad + H - ((v - min) / span) * H;

        const colors = SPARK_COLORS[key] ?? SPARK_COLORS.deepseek;

        // Area fill.
        cr.moveTo(X(pts[0]), Y(pts[0].total));
        for (const p of pts)
            cr.lineTo(X(p), Y(p.total));
        cr.lineTo(X(pts[pts.length - 1]), pad + H);
        cr.lineTo(X(pts[0]), pad + H);
        cr.closePath();
        const [fr, fg, fb, fa] = colors.fill;
        cr.setSourceRGBA(fr, fg, fb, fa);
        cr.fill();

        // Line.
        cr.moveTo(X(pts[0]), Y(pts[0].total));
        for (const p of pts)
            cr.lineTo(X(p), Y(p.total));
        const [lr, lg, lb] = colors.line;
        cr.setSourceRGBA(lr, lg, lb, 0.95);
        cr.setLineWidth(1.4);
        cr.stroke();
    }

    /* ----------------------------------------------------------------- drag */

    _onPress(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        const [sx, sy] = event.get_coords();
        this._drag = { ox: sx - this.actor.x, oy: sy - this.actor.y, moved: false, sx, sy };
        this._motionId = global.stage.connect('motion-event', (st, ev) => this._onDragMove(ev));
        this._releaseId = global.stage.connect('button-release-event', (st, ev) => this._onDragRelease(ev));
        return Clutter.EVENT_STOP;
    }

    _onDragMove(event) {
        if (!this._drag)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        if (Math.abs(x - this._drag.sx) + Math.abs(y - this._drag.sy) > 3)
            this._drag.moved = true;
        this.actor.set_position(Math.round(x - this._drag.ox), Math.round(y - this._drag.oy));
        return Clutter.EVENT_STOP;
    }

    _onDragRelease(event) {
        if (!this._drag)
            return Clutter.EVENT_PROPAGATE;
        const moved = this._drag.moved;
        this._teardownDrag();
        if (moved)
            this._callbacks.onDragEnd(this.actor.x, this.actor.y);
        return Clutter.EVENT_STOP;
    }

    _teardownDrag() {
        if (this._motionId) {
            global.stage.disconnect(this._motionId);
            this._motionId = 0;
        }
        if (this._releaseId) {
            global.stage.disconnect(this._releaseId);
            this._releaseId = 0;
        }
        this._drag = null;
    }

    destroy() {
        this._teardownDrag();
        this.actor.destroy();
    }
}

/* ------------------------------------------------------------------------ */
/* Spark actor: St.DrawingArea on GNOME 45+, Clutter.Canvas fallback.        */
/* ------------------------------------------------------------------------ */

function makeSparkActor(width, height, drawFn) {
    if (typeof St.DrawingArea !== 'undefined') {
        const area = new St.DrawingArea({ width, height });
        area.connect('repaint', () => {
            const cr = area.get_context?.();
            if (cr)
                drawFn(cr, area.get_width() ?? width, area.get_height() ?? height);
        });
        return { actor: area, refresh: (pts) => area.queue_repaint() };
    }

    const actor = new St.Widget({ width, height });
    const canvas = new Clutter.Canvas();
    canvas.connect('draw', (c, cr, w, h) => {
        drawFn(cr, w, h);
        return true;
    });
    actor.set_content(canvas);
    canvas.set_size(width, height);
    return { actor, refresh: () => canvas.invalidate() };
}