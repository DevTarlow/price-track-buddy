/**
 * FloatingPanel — the draggable, always-on-top desktop widget.
 *
 * Layout (all St):
 *   root (vertical, fixed width)
 *   ├─ header   drag handle · title · status dots · refresh · collapse · settings · hide
 *   ├─ body     one card per provider
 *   └─ chip     collapsed minimal rows (tag · headline · spent today)
 *
 * The widget is deliberately view-dumb: it renders whatever state the
 * extension hands it via updateDisplays() and reports user actions through
 * callbacks.
 */

import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

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

/**
 * @param {object} opts
 *   providers  registry descriptors (id, name, badge, accent, defaultCurrency, peak, spark)
 *   callbacks  { onRefresh, onToggleCollapsed, onHide, onOpenSettings, onDragEnd }
 */
export class FloatingPanel {
    constructor({ providers, callbacks }) {
        this._providers = providers ?? [];
        this._providersById = Object.fromEntries(
            this._providers.map((p) => [p.id, p]));
        this._callbacks = callbacks;
        this._sparks = {};
        this._drag = null;
        this._capturedId = 0;
        this._displays = null;
        this._peaks = {};
        this._peakMode = null;
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
        this._dotTooltips = {};
        for (const provider of this._providers) {
            const key = provider.id;
            const name = provider.name;
            const dot = new St.Widget({
                style_class: 'ptb-dot',
                reactive: true,
                track_hover: true,
                // Without an explicit cross-axis alignment the header's
                // horizontal BoxLayout stretches the 8px dot to the row height.
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._header.add_child(dot);
            this._dots[key] = dot;

            const tooltip = new St.Label({
                style_class: 'ptb-tooltip',
                text: name,
                visible: false,
            });
            Main.layoutManager.addChrome(tooltip);
            this._dotTooltips[key] = tooltip;

            dot.connect('enter-event', () => {
                this._showDotTooltip(key);
                return Clutter.EVENT_PROPAGATE;
            });
            dot.connect('leave-event', () => {
                this._hideDotTooltip(key);
                return Clutter.EVENT_PROPAGATE;
            });
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

        this._buttons = [
            this._btnRefresh,
            this._btnCollapse,
            this._btnSettings,
            this._btnHide,
        ];

        this._body = new St.BoxLayout({
            style_class: 'ptb-body',
            vertical: true,
            x_expand: true,
        });
        this._cards = {};
        for (const provider of this._providers) {
            const card = this._buildCard(provider);
            this._cards[provider.id] = card;
            this._body.add_child(card.card);
        }
        this._empty = new St.Label({
            style_class: 'ptb-empty',
            text: 'No providers enabled',
            visible: false,
        });
        this._body.add_child(this._empty);

        // The card list can outgrow the screen once a few providers are on.
        // Scroll it, and cap the height in _fitBody() to the monitor.
        this._bodyScroll = new St.ScrollView({
            style_class: 'ptb-body-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            child: this._body,
        });

        // Collapsed "minimal mode": one compact row per provider, each led by
        // its provider badge so the numbers are attributable at a glance. Rows
        // carry the headline plus today's spend.
        this._chip = new St.BoxLayout({
            style_class: 'ptb-chip',
            vertical: true,
            reactive: true,
            can_focus: false,
            x_expand: true,
        });
        this._chipRows = {};
        for (const provider of this._providers) {
            const key = provider.id;
            const row = new St.BoxLayout({ style_class: 'ptb-chip-row', x_expand: true });
            const badge = new St.Label({
                style_class: 'ptb-badge',
                text: provider.badge,
                style: `background-color: ${provider.accent};`,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const balance = new St.Label({
                style_class: 'ptb-chip-balance',
                text: '—',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const today = new St.Label({
                style_class: 'ptb-chip-today',
                text: '',
                y_align: Clutter.ActorAlign.CENTER,
            });
            row.add_child(badge);
            row.add_child(balance);
            row.add_child(today);
            this._chip.add_child(row);
            this._chipRows[key] = { row, balance, today };
        }
        this._chipEmpty = new St.Label({
            style_class: 'ptb-empty',
            text: 'No providers enabled',
            visible: false,
        });
        this._chip.add_child(this._chipEmpty);
        this._chip.connect('button-press-event', () => {
            this._callbacks.onToggleCollapsed();
            return Clutter.EVENT_STOP;
        });

        this.actor.add_child(this._header);
        this.actor.add_child(this._bodyScroll);
        this.actor.add_child(this._chip);

        // Drag to move the whole panel.
        this.actor.connect('notify::visible', () => {
            if (!this.actor.visible)
                this._hideDotTooltips();
        });
        this._header.connect('button-press-event', (a, ev) => this._onPress(ev));
        this._fitBody();
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

    _buildCard(provider) {
        const key = provider.id;
        const card = new St.BoxLayout({
            style_class: 'ptb-card',
            vertical: true,
            x_expand: true,
        });

        const head = new St.BoxLayout({ style_class: 'ptb-card-head', x_expand: true });
        const badge = new St.Label({
            style_class: 'ptb-badge',
            text: provider.badge,
            style: `background-color: ${provider.accent};`,
        });
        const name = new St.Label({
            style_class: 'ptb-card-name',
            text: provider.name,
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
        if (provider.peak) {
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

        return { card, badge, name, status, balance, delta, sub, statCells, peak, meta, error };
    }

    /* -------------------------------------------------------------- states */

    setCollapsed(collapsed) {
        this._bodyScroll.visible = !collapsed;
        this._chip.visible = collapsed;
        this._btnCollapse.child.icon_name = collapsed ? 'go-down-symbolic' : 'go-up-symbolic';
    }

    /**
     * displays: { [providerId]: { enabled, keySet, loading, error, reading,
     *             points, spentToday, spent7d, lifetimeSpent, toppedUpToday } }
     * peaks:    { [providerId]: { active, priceMultiplier, nextChangeIn,
     *             nextChangeLocal } } for providers with a billing window
     */
    updateDisplays(displays, peaks = {}) {
        this._displays = displays;
        this._peaks = peaks ?? {};
        let shown = 0;
        for (const provider of this._providers) {
            this._updateCard(provider.id, displays[provider.id]);
            this._updatePeak(this._cards[provider.id], this._peaks[provider.id]);
            if (displays[provider.id]?.visible !== false)
                shown++;
        }
        this._empty.visible = shown === 0;
        this._chipEmpty.visible = shown === 0;
        this._applyPeakMode();
        this._updateChip();
        this._fitBody();
    }

    /**
     * Update only the billing-window labels and the panel outline. Called by
     * the extension's per-second tick while the cards are collapsed.
     */
    updatePeaks(peaks = {}) {
        this._peaks = peaks ?? {};
        for (const provider of this._providers)
            this._updatePeak(this._cards[provider.id], this._peaks[provider.id]);
        this._applyPeakMode();
        this._fitBody();
    }

    /**
     * Keep the card area inside the screen: the scroll view is exactly as tall
     * as its content when it fits, and the monitor's height minus the header
     * and margins when it does not. Recomputed on every render so moving the
     * panel to another monitor adapts it.
     */
    _fitBody() {
        if (!this._bodyScroll)
            return;
        const monitor = Main.layoutManager.findMonitorForActor(this.actor)
            ?? Main.layoutManager.primaryMonitor;
        const [, natural] = this._body.get_preferred_height(PANEL_WIDTH - 20);
        const available = Math.max(160, (monitor?.height ?? 900) - 150);
        this._bodyScroll.height = Math.min(Math.ceil(natural), available);
    }

    _updateCard(key, state) {
        const card = this._cards[key];
        const provider = this._providersById[key];
        const visible = state.visible !== false;
        card.card.visible = visible;
        this._dots[key].visible = visible;
        this._chipRows[key].row.visible = visible;
        if (!visible) {
            this._hideDotTooltip(key);
            return;
        }
        card.name.text = state.name ?? provider.name;
        const currency = state.reading?.currency ?? provider.defaultCurrency ?? 'USD';

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
            card.balance.text = fmtMoney(state.reading.headline, currency);
            const net = state.toppedUpToday - state.spentToday;
            card.delta.text = state.spentToday > 0 || state.toppedUpToday > 0
                ? fmtSigned(net, currency)
                : '';
            card.sub.text = (state.reading.detail ?? [])
                .map((d) => `${d.label} ${fmtMoney(d.value, currency)}`)
                .join(' · ') || state.reading.headlineLabel || '';
        } else {
            card.balance.text = '—';
            card.delta.text = '';
            card.sub.text = '';
        }
        card.sub.visible = !!card.sub.text;

        // Stats.
        card.statCells[0].value.text = fmtMoney(state.spentToday, currency);
        card.statCells[0].label.text = 'spent today';
        card.statCells[1].value.text = fmtMoney(state.spent7d, currency);
        card.statCells[1].label.text = 'last 7 days';
        card.statCells[2].value.text = fmtMoney(state.lifetimeSpent, currency);
        card.statCells[2].label.text = 'lifetime';

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

    _updatePeak(card, peak) {
        if (!card?.peak || !peak)
            return;
        const label = peak.active
            ? `PEAK  ·  ${peak.priceMultiplier}× price  ·  ends in ${fmtDuration(peak.nextChangeIn)}`
            : `OFF-PEAK  ·  ½ price  ·  next peak ${peak.nextChangeLocal} in ${fmtDuration(peak.nextChangeIn)}`;
        card.peak.text = label;
        card.peak.style_class = `ptb-peak ${peak.active ? 'ptb-peak-peak' : 'ptb-peak-off'}`;
    }

    /**
     * The panel outline mirrors the first provider with a billing window
     * (DeepSeek today). More peak-aware providers keep their own card banner;
     * only one colour can own the shared border.
     */
    _applyPeakMode() {
        const peak = this._providers
            .map((p) => this._peaks?.[p.id])
            .find(Boolean);
        const mode = peak
            ? (peak.active ? 'ptb-mode-peak' : 'ptb-mode-off')
            : null;
        if (mode === this._peakMode)
            return;
        if (this._peakMode)
            this.actor.remove_style_class_name(this._peakMode);
        if (mode)
            this.actor.add_style_class_name(mode);
        this._peakMode = mode;
    }

    _updateChip() {
        if (!this._displays)
            return;
        for (const provider of this._providers) {
            const key = provider.id;
            const s = this._displays[key];
            if (!s || s.visible === false)
                continue;
            const row = this._chipRows[key];
            const currency = s.reading?.currency ?? provider.defaultCurrency ?? 'USD';
            if (s.reading) {
                const money = fmtMoney(s.reading.headline, currency);
                row.balance.text = s.reading.headlineLabel
                    ? `${s.reading.headlineLabel} ${money}`
                    : money;
                row.today.text = `today ${fmtMoney(s.spentToday, currency)}`;
            } else if (s.loading) {
                row.balance.text = '…';
                row.today.text = '';
            } else if (!s.keySet) {
                row.balance.text = 'not configured';
                row.today.text = '';
            } else {
                row.balance.text = `✕ ${s.error?.code ?? 'error'}`;
                row.today.text = '';
            }

            // Card meta line: updated time.
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

        const colors = this._providersById[key]?.spark ?? {
            line: [0.45, 0.48, 0.56],
            fill: [0.45, 0.48, 0.56, 0.15],
        };

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

    /* ------------------------------------------------------- dot tooltips */

    _showDotTooltip(key) {
        const dot = this._dots[key];
        const tooltip = this._dotTooltips[key];
        if (!dot || !tooltip || this._drag)
            return;

        // These labels are added to the chrome before the panel itself, so
        // lift the one being shown above it.
        tooltip.get_parent()?.set_child_above_sibling(tooltip, null);

        tooltip.text = this._displays?.[key]?.name
            ?? this._providersById[key]?.name
            ?? key;

        const [, preferredWidth] = tooltip.get_preferred_width(-1);
        const [, preferredHeight] = tooltip.get_preferred_height(-1);
        const width = Math.ceil(preferredWidth);
        const height = Math.ceil(preferredHeight);

        const [x, y] = dot.get_transformed_position();
        const left = Math.max(0, Math.min(
            Math.round(x + dot.get_width() / 2 - width / 2),
            global.stage.width - width));
        let top = Math.round(y - height - 6);
        if (top < 0)
            top = Math.round(y + dot.get_height() + 6);

        tooltip.set_position(left, top);
        tooltip.show();
    }

    _hideDotTooltip(key) {
        this._dotTooltips[key]?.hide();
    }

    _hideDotTooltips() {
        for (const tooltip of Object.values(this._dotTooltips ?? {}))
            tooltip.hide();
    }

    /* ----------------------------------------------------------------- drag */

    _onPress(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        const [sx, sy] = event.get_coords();

        // GNOME 49+ St.Button recognizes clicks with a ClutterClickGesture.
        // The event chain is walked deepest-first, so our header handler runs
        // after the button's gesture saw the press. Returning EVENT_STOP here
        // makes Clutter treat the press as "handled by an actor" and call
        // clutter_sprite_remove_all_actions_from_chain(), which cancels that
        // gesture — so the button never emits ::clicked on release. Leave the
        // press strictly alone (no drag, no STOP) when it is on a button.
        if (this._isButtonAt(sx, sy))
            return Clutter.EVENT_PROPAGATE;

        this._hideDotTooltips();
        this._drag = { ox: sx - this.actor.x, oy: sy - this.actor.y, moved: false, sx, sy };
        // Capture on the stage. A fast drag can release over a child that
        // consumes the event (the header buttons use ClutterClickGesture), and
        // a bubble-phase listener never sees that release, leaving the drag
        // armed and the panel stuck to the pointer.
        this._capturedId = global.stage.connect('captured-event',
            (stage, ev) => this._onCapturedEvent(ev));
        return Clutter.EVENT_STOP;
    }

    _isButtonAt(x, y) {
        let actor = global.stage.get_actor_at_pos(
            Clutter.PickMode.REACTIVE, Math.round(x), Math.round(y));
        while (actor && actor !== this.actor) {
            if (this._buttons.includes(actor))
                return true;
            actor = actor.get_parent();
        }
        return false;
    }

    _onCapturedEvent(event) {
        if (!this._drag)
            return Clutter.EVENT_PROPAGATE;

        const type = event.type();
        if (type === Clutter.EventType.MOTION) {
            // A release the stage never saw leaves the button state as the
            // backstop: end the drag on the next motion rather than following
            // a pointer with no button held.
            if (!(event.get_state() & Clutter.ModifierType.BUTTON1_MASK))
                return this._onDragRelease(event);
            return this._onDragMove(event);
        }

        if (type === Clutter.EventType.BUTTON_RELEASE &&
            event.get_button() === Clutter.BUTTON_PRIMARY)
            return this._onDragRelease(event);

        return Clutter.EVENT_PROPAGATE;
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
        if (this._capturedId) {
            global.stage.disconnect(this._capturedId);
            this._capturedId = 0;
        }
        this._drag = null;
    }

    destroy() {
        this._teardownDrag();
        for (const tooltip of Object.values(this._dotTooltips ?? {})) {
            Main.layoutManager.removeChrome(tooltip);
            tooltip.destroy();
        }
        this._dotTooltips = {};
        this.actor.destroy();
    }
}

/* ------------------------------------------------------------------------ */
/* Spark actor: St.DrawingArea on GNOME 45+, Clutter.Canvas fallback.        */
/* ------------------------------------------------------------------------ */

function makeSparkActor(width, height, drawFn) {
    if (typeof St.DrawingArea !== 'undefined') {
        // x_expand lets the sparkline follow the card's real content width,
        // which shrinks when the body's scrollbar appears.
        const area = new St.DrawingArea({ height, x_expand: true });
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