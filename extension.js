/**
 * Price Track Buddy — floating desktop panel tracking DeepSeek and OpenRouter
 * balances and usage over time.
 *
 * Built by Moss AI Studio. Modeled on the DeepSeek Harness "balance-buddy"
 * plugin: spend is derived from balance deltas, daily buckets accumulate
 * spend/top-ups, and DeepSeek peak/off-peak billing windows are surfaced.
 */

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import GLib from 'gi://GLib';
import St from 'gi://St';

import {
    DeepSeekProvider,
    OpenRouterProvider,
    ProviderError,
    deepseekMovement,
    openrouterMovement,
} from './lib/providers.js';
import { Ledger } from './lib/ledger.js';
import { peakStatus, localTimeZone } from './lib/peak.js';
import { FloatingPanel } from './lib/widget.js';
import { fmtMoney } from './lib/format.js';

const PROVIDER_KEYS = ['deepseek', 'openrouter'];

export default class PriceTrackBuddyExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._dir = `${GLib.get_user_data_dir()}/price-track-buddy`;

        this._state = {
            deepseek: { loading: false, error: null, reading: null },
            openrouter: { loading: false, error: null, reading: null },
        };
        this._ledgers = {
            deepseek: new Ledger({ provider: 'deepseek', dir: this._dir }).load(),
            openrouter: new Ledger({ provider: 'openrouter', currency: 'USD', dir: this._dir }).load(),
        };
        this._buildProviders();
        this._readings = { deepseek: null, openrouter: null };

        this._refreshing = false;
        this._refreshId = 0;
        this._tickId = 0;
        this._signalIds = [];

        // Floating panel.
        this._widget = new FloatingPanel({
            callbacks: {
                onRefresh: () => this._refreshNow(),
                onToggleCollapsed: () => this._settings.set_boolean(
                    'collapsed', !this._settings.get_boolean('collapsed')),
                onHide: () => this._setVisible(false),
                onOpenSettings: () => this.openPreferences(),
                onDragEnd: (x, y) => {
                    this._settings.set_int('position-x', Math.round(x));
                    this._settings.set_int('position-y', Math.round(y));
                },
            },
        });
        Main.layoutManager.uiGroup.add_child(this._widget.actor);
        this._widget.actor.set_position(
            this._settings.get_int('position-x'),
            this._settings.get_int('position-y'));
        if (this._settings.get_int('position-x') < 0 || this._settings.get_int('position-y') < 0)
            this._placeDefault();
        this._widget.setCollapsed(this._settings.get_boolean('collapsed'));
        this._widget.actor.visible = this._settings.get_boolean('visible');

        // Top panel indicator (control surface for the floating widget).
        this._indicator = null;
        this._indDS = null;
        this._indOR = null;
        // Keep a broken indicator from aborting enable(). The floating widget is
        // the primary UI, so it must still get its timers and first refresh.
        if (this._settings.get_boolean('show-indicator')) {
            try {
                this._buildIndicator();
            } catch (e) {
                logError(e, 'Price Track Buddy: could not build the panel indicator');
                this._indicator?.destroy();
                this._indicator = null;
                this._indDS = null;
                this._indOR = null;
            }
        }

        // Settings listeners.
        this._signalIds.push(this._settings.connect(
            'changed::refresh-interval', () => this._reschedule()));
        this._signalIds.push(this._settings.connect(
            'changed::collapsed',
            () => this._widget.setCollapsed(this._settings.get_boolean('collapsed'))));
        this._signalIds.push(this._settings.connect(
            'changed::visible',
            () => { this._widget.actor.visible = this._settings.get_boolean('visible'); }));
        this._signalIds.push(this._settings.connect(
            'changed::position-x',
            () => { if (this._settings.get_int('position-x') < 0) this._placeDefault(); }));
        this._signalIds.push(this._settings.connect(
            'changed::show-indicator', () => this._rebuildIndicator()));
        for (const key of [
            'deepseek-api-key', 'deepseek-enabled', 'deepseek-base-url', 'deepseek-currency',
            'openrouter-api-key', 'openrouter-enabled', 'openrouter-base-url',
        ]) {
            this._signalIds.push(this._settings.connect(`changed::${key}`,
                () => this._onProviderSettingsChanged(key)));
        }

        // Timers. GLib 2.88 annotates these as (priority, interval, callback).
        // The per-second pass only feeds the peak countdown and the "updated
        // Ns ago" line, both of which live in the expanded body. Skip it while
        // the widget is hidden or collapsed — no on-screen text changes.
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            if (!this._widget) return GLib.SOURCE_CONTINUE;
            if (!this._widget.actor.visible || this._settings.get_boolean('collapsed'))
                return GLib.SOURCE_CONTINUE;
            this._render();
            return GLib.SOURCE_CONTINUE;
        });
        this._reschedule();
        this._refreshNow();
    }

    disable() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
        if (this._refreshId) {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
        }
        for (const id of this._signalIds)
            this._settings.disconnect(id);
        this._signalIds = [];

        this._widget?.destroy();
        this._widget = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._providers = null;
        this._ledgers = null;
        this._state = null;
    }

    /* ------------------------------------------------------------ providers */

    _buildProviders() {
        this._providers = {
            deepseek: new DeepSeekProvider({
                apiKey: this._settings.get_string('deepseek-api-key'),
                baseUrl: this._settings.get_string('deepseek-base-url') || undefined,
                preferredCurrency: this._settings.get_string('deepseek-currency'),
            }),
            openrouter: new OpenRouterProvider({
                apiKey: this._settings.get_string('openrouter-api-key'),
                baseUrl: this._settings.get_string('openrouter-base-url') || undefined,
            }),
        };
    }

    _onProviderSettingsChanged(key) {
        this._buildProviders();
        // The reading belongs to the previous key/config. Drop it so the card
        // shows a loading state instead of stale data until the new fetch
        // lands. (If a refresh is already running, _refreshNow() returns early
        // and that fetch's results still apply — a separate, pre-existing
        // overlap we leave alone.)
        const st = this._state?.[key];
        if (st) {
            st.reading = null;
            st.loading = true;
        }
        this._refreshNow();
    }

    _cfg(key) {
        return {
            enabled: this._settings.get_boolean(`${key}-enabled`),
            keySet: !!this._settings.get_string(`${key}-api-key`),
            provider: this._providers[key],
        };
    }

    /* ------------------------------------------------------------- refresh */

    async _refreshNow() {
        if (this._refreshing)
            return;
        this._refreshing = true;

        const tasks = [];
        for (const key of PROVIDER_KEYS) {
            const cfg = this._cfg(key);
            if (!cfg.enabled) {
                this._state[key].loading = false;
                this._state[key].error = null;
                continue;
            }
            if (!cfg.keySet) {
                this._state[key].loading = false;
                this._state[key].error = new ProviderError('no-key', 'not configured');
                continue;
            }
            this._state[key].loading = true;
            this._state[key].error = null;
            const promise = key === 'deepseek'
                ? cfg.provider.getBalance()
                : cfg.provider.getCredits();
            tasks.push({
                key,
                promise: promise.then(
                    (value) => ({ key, value }),
                    (err) => ({ key, error: err })),
            });
        }
        this._render();

        const results = await Promise.all(tasks.map((t) => t.promise));
        for (const r of results) {
            const st = this._state[r.key];
            st.loading = false;
            if (r.error) {
                st.error = r.error instanceof ProviderError
                    ? r.error
                    : new ProviderError('network', String(r.error));
            } else {
                st.error = null;
                this._applyReading(r.key, r.value);
            }
        }
        this._refreshing = false;
        this._render();
    }

    _applyReading(key, reading) {
        const ledger = this._ledgers[key];
        if (reading.currency) {
            if (ledger.currency && ledger.currency !== reading.currency) {
                // Currency changed → the old totals are not comparable.
                this._ledgers[key] = new Ledger({
                    provider: key,
                    currency: reading.currency,
                    dir: this._dir,
                }).load();
            } else {
                ledger.currency = reading.currency;
            }
        }

        const cur = this._ledgers[key];
        let spentDelta = 0;
        let toppedUpDelta = 0;
        if (cur.hasData()) {
            const prev = {
                total: cur.lastTotal,
                usage: cur.lastExtra?.usage ?? 0,
                purchased: cur.lastExtra?.purchased ?? 0,
            };
            const m = key === 'deepseek'
                ? deepseekMovement(prev, reading)
                : openrouterMovement(prev, reading);
            spentDelta = m.spentDelta;
            toppedUpDelta = m.toppedUpDelta;
        }

        const extra = key === 'deepseek'
            ? { granted: reading.granted, toppedUp: reading.toppedUp }
            : { usage: reading.usage, purchased: reading.purchased };
        cur.record({
            at: reading.at,
            total: key === 'deepseek' ? reading.total : reading.remaining,
            spentDelta,
            toppedUpDelta,
            extra,
        });
        this._state[key].reading = reading;
        this._readings[key] = reading;
    }

    /* -------------------------------------------------------------- display */

    _displayState(key) {
        const ledger = this._ledgers[key];
        const st = this._state[key];
        return {
            enabled: this._settings.get_boolean(`${key}-enabled`),
            keySet: !!this._settings.get_string(`${key}-api-key`),
            loading: st.loading,
            error: st.error,
            reading: st.reading,
            points: ledger.points,
            spentToday: ledger.spentToday(),
            spent7d: ledger.spentLastNDays(7),
            lifetimeSpent: ledger.lifetimeSpent,
            toppedUpToday: ledger.toppedUpToday(),
        };
    }

    _render() {
        if (!this._widget)
            return;
        this._widget.updateDisplays({
            deepseek: this._displayState('deepseek'),
            openrouter: this._displayState('openrouter'),
            peak: peakStatus(Date.now(), localTimeZone()),
        });
        this._updateIndicator();
    }

    /* ------------------------------------------------------------- widget */

    _placeDefault() {
        const monitor = Main.layoutManager.primaryMonitor;
        const margin = 16;
        const [, naturalH] = this._widget.actor.get_preferred_height(-1);
        const x = monitor.x + monitor.width - this._widget.actor.width - margin;
        const y = monitor.y + monitor.height - (naturalH || 220) - margin;
        this._settings.set_int('position-x', Math.round(x));
        this._settings.set_int('position-y', Math.round(y));
    }

    _setVisible(visible) {
        this._settings.set_boolean('visible', visible);
        this._widget.actor.visible = visible;
    }

    _reschedule() {
        if (this._refreshId) {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
        }
        const interval = Math.max(20, this._settings.get_int('refresh-interval'));
        this._refreshId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._refreshNow();
            return GLib.SOURCE_CONTINUE;
        });
    }

    /* ------------------------------------------------------------ indicator */

    _buildIndicator() {
        this._indicator = new PanelMenu.Button(0.0, 'Price Track Buddy', false);
        this._indicator.add_child(new St.Label({ text: '$', style_class: 'ptb-indicator' }));
        this._indicator.menu.addAction('Show / hide widget',
            () => this._setVisible(!this._settings.get_boolean('visible')));
        this._indicator.menu.addAction('Refresh now', () => this._refreshNow());
        this._indicator.menu.addAction('Open settings…', () => this.openPreferences());
        this._indicator.menu.addAction('Reset widget position', () => this._placeDefault());
        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._indDS = new PopupMenu.PopupMenuItem('DeepSeek —');
        this._indOR = new PopupMenu.PopupMenuItem('OpenRouter —');
        this._indicator.menu.addMenuItem(this._indDS);
        this._indicator.menu.addMenuItem(this._indOR);
        Main.panel.addToStatusArea('price-track-buddy', this._indicator, 0, 'right');
        this._updateIndicator();
    }

    _rebuildIndicator() {
        const want = this._settings.get_boolean('show-indicator');
        if (want && !this._indicator)
            this._buildIndicator();
        else if (!want && this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    _updateIndicator() {
        if (!this._indicator)
            return;

        // Pango markup, so today's spend can carry its own colour.
        const esc = (s) => String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const mk = (key) => {
            const name = key === 'deepseek' ? 'DeepSeek' : 'OpenRouter';
            const st = this._state[key];
            if (st.error)
                return `${name}  ✕ ${esc(st.error.code ?? 'error')}`;
            if (!st.reading)
                return `${name}  —`;

            const currency = st.reading.currency ?? (key === 'deepseek' ? 'CNY' : 'USD');
            const main = key === 'deepseek' ? st.reading.total : st.reading.remaining;
            const spent = this._displayState(key).spentToday;
            const colour = spent > 0 ? '#ffcc66' : '#9aa1ad';
            const spentPart =
                `   <span foreground="${colour}">today ${esc(fmtMoney(spent, currency))}</span>`;
            return `${name}  ${esc(fmtMoney(main, currency))}${spentPart}`;
        };
        this._indDS.label.clutter_text.set_markup(mk('deepseek'));
        this._indOR.label.clutter_text.set_markup(mk('openrouter'));
    }
}