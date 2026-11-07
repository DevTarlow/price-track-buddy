/**
 * Price Track Buddy — floating desktop panel tracking provider balances and
 * usage over time.
 *
 * Built by Moss AI Studio. Modeled on the DeepSeek Harness "balance-buddy"
 * plugin: spend is derived from balance deltas, daily buckets accumulate
 * spend/top-ups, and providers with billing windows surface peak/off-peak.
 */

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import GLib from 'gi://GLib';
import St from 'gi://St';

import { ProviderError, movementFor } from './lib/providers.js';
import { PROVIDERS, providerById } from './lib/registry.js';
import { Ledger } from './lib/ledger.js';
import { peakStatus, localTimeZone } from './lib/peak.js';
import { FloatingPanel } from './lib/widget.js';
import { fmtMoney } from './lib/format.js';

export default class PriceTrackBuddyExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._dir = `${GLib.get_user_data_dir()}/price-track-buddy`;

        this._state = {};
        this._ledgers = {};
        for (const provider of PROVIDERS) {
            this._state[provider.id] = { loading: false, error: null, reading: null };
            this._ledgers[provider.id] = new Ledger({
                provider: provider.id,
                currency: provider.ledgerCurrency ?? null,
                dir: this._dir,
            }).load();
        }
        this._buildProviders();

        this._refreshing = false;
        this._refreshId = 0;
        this._tickId = 0;
        this._signalIds = [];
        this._fullscreenId = 0;

        // Floating panel.
        this._widget = new FloatingPanel({
            providers: PROVIDERS,
            callbacks: {
                onRefresh: () => this._refreshNow(),
                onToggleCollapsed: () => this._settings.set_boolean(
                    'collapsed', !this._settings.get_boolean('collapsed')),
                onHide: () => this._setVisible(false),
                onOpenSettings: () => this.openPreferences(),
                onDragEnd: (x, y) => {
                    this._settings.set_int('position-x', Math.round(x));
                    this._settings.set_int('position-y', Math.round(y));
                    // The panel may have moved onto another monitor; that
                    // monitor's fullscreen state decides its visibility.
                    this._applyVisibility();
                },
            },
        });
        // Tracked chrome rather than a raw uiGroup child: it stays above the
        // window group and its input region is kept in sync. Visibility over
        // fullscreen is handled by _applyVisibility() below.
        Main.layoutManager.addChrome(this._widget.actor, {
            affectsStruts: false,
            trackFullscreen: false,
        });
        this._widget.actor.set_position(
            this._settings.get_int('position-x'),
            this._settings.get_int('position-y'));
        if (this._settings.get_int('position-x') < 0 || this._settings.get_int('position-y') < 0)
            this._placeDefault();
        this._widget.setCollapsed(this._settings.get_boolean('collapsed'));
        this._applyOpacity();
        this._applyVisibility();

        // Top panel indicator (control surface for the floating widget).
        this._indicator = null;
        this._indItems = {};
        // Keep a broken indicator from aborting enable(). The floating widget is
        // the primary UI, so it must still get its timers and first refresh.
        if (this._settings.get_boolean('show-indicator')) {
            try {
                this._buildIndicator();
            } catch (e) {
                logError(e, 'Price Track Buddy: could not build the panel indicator');
                this._indicator?.destroy();
                this._indicator = null;
                this._indItems = {};
            }
        }

        // Settings listeners.
        this._signalIds.push(this._settings.connect(
            'changed::refresh-interval', () => this._reschedule()));
        this._signalIds.push(this._settings.connect(
            'changed::collapsed',
            () => this._widget.setCollapsed(this._settings.get_boolean('collapsed'))));
        this._signalIds.push(this._settings.connect(
            'changed::visible', () => this._applyVisibility()));
        this._signalIds.push(this._settings.connect(
            'changed::always-on-top', () => this._applyVisibility()));
        this._signalIds.push(this._settings.connect(
            'changed::opacity', () => this._applyOpacity()));
        this._signalIds.push(this._settings.connect(
            'changed::position-x',
            () => { if (this._settings.get_int('position-x') < 0) this._placeDefault(); }));
        this._signalIds.push(this._settings.connect(
            'changed::show-indicator', () => this._rebuildIndicator()));
        // "Always on top" off means a fullscreen window on the panel's monitor
        // covers it, so a fullscreen change can alter its visibility.
        this._fullscreenId = global.display.connect(
            'in-fullscreen-changed', () => this._applyVisibility());
        for (const provider of PROVIDERS) {
            for (const key of Object.values(provider.settings)) {
                if (!key)
                    continue;
                const isName = key === provider.settings.name;
                this._signalIds.push(this._settings.connect(`changed::${key}`, () => {
                    if (isName)
                        this._render();
                    else
                        this._onProviderSettingsChanged(provider.id);
                }));
            }
        }

        // Timers. GLib 2.88 annotates these as (priority, interval, callback).
        // The per-second pass feeds the peak countdown, the "updated Ns ago"
        // line and the panel's peak/off-peak outline. While collapsed only the
        // outline is on screen, so update just that instead of re-rendering
        // the hidden cards.
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            if (!this._widget) return GLib.SOURCE_CONTINUE;
            if (!this._widget.actor.visible) return GLib.SOURCE_CONTINUE;
            if (this._settings.get_boolean('collapsed'))
                this._widget.updatePeaks(this._currentPeaks());
            else
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
        if (this._fullscreenId) {
            global.display.disconnect(this._fullscreenId);
            this._fullscreenId = 0;
        }

        this._widget?.destroy();
        this._widget = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._indItems = {};
        this._providers = null;
        this._ledgers = null;
        this._state = null;
    }

    /* ------------------------------------------------------------ providers */

    _buildProviders() {
        this._providers = {};
        for (const provider of PROVIDERS) {
            const s = provider.settings;
            this._providers[provider.id] = provider.create({
                apiKey: this._settings.get_string(s.apiKey),
                baseUrl: s.baseUrl
                    ? this._settings.get_string(s.baseUrl) || undefined
                    : undefined,
                preferredCurrency: s.currency
                    ? this._settings.get_string(s.currency)
                    : '',
                authMode: s.authMode
                    ? this._settings.get_string(s.authMode)
                    : undefined,
                authHeader: s.authHeader
                    ? this._settings.get_string(s.authHeader)
                    : undefined,
            });
        }
    }

    _onProviderSettingsChanged(providerId) {
        this._buildProviders();
        // The reading belongs to the previous key/config. Drop it so the card
        // shows a loading state instead of stale data until the new fetch
        // lands. (If a refresh is already running, _refreshNow() returns early
        // and that fetch's results still apply — a separate, pre-existing
        // overlap we leave alone.)
        const st = this._state?.[providerId];
        if (st) {
            st.reading = null;
            st.loading = true;
        }
        this._refreshNow();
    }

    /** Whether this provider has everything it needs to be polled. */
    _keySet(provider) {
        const requiresKey = typeof provider.requiresKey === 'function'
            ? provider.requiresKey(this._settings)
            : provider.requiresKey !== false;
        return !requiresKey || !!this._settings.get_string(provider.settings.apiKey);
    }

    _cfg(providerId) {
        const provider = providerById(providerId);
        return {
            enabled: this._settings.get_boolean(provider.settings.enabled),
            keySet: this._keySet(provider),
            provider: this._providers[providerId],
        };
    }

    /* ------------------------------------------------------------- refresh */

    async _refreshNow() {
        if (this._refreshing)
            return;
        this._refreshing = true;

        const tasks = [];
        for (const provider of PROVIDERS) {
            const key = provider.id;
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
            const promise = cfg.provider.read();
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
                headline: cur.lastTotal,
                usage: cur.lastExtra?.usage ?? 0,
                purchased: cur.lastExtra?.purchased ?? 0,
            };
            const m = movementFor(reading.movement ?? providerById(key).movement,
                prev, reading);
            spentDelta = m.spentDelta;
            toppedUpDelta = m.toppedUpDelta;
        }

        cur.record({
            at: reading.at,
            total: reading.headline,
            spentDelta,
            toppedUpDelta,
            extra: reading.extra ?? null,
        });
        this._state[key].reading = reading;
    }

    /* -------------------------------------------------------------- display */

    _displayState(key) {
        const ledger = this._ledgers[key];
        const st = this._state[key];
        const provider = providerById(key);
        const s = provider.settings;
        const name = s.name
            ? (this._settings.get_string(s.name) || provider.name)
            : provider.name;
        return {
            enabled: this._settings.get_boolean(s.enabled),
            keySet: this._keySet(provider),
            visible: provider.isVisible ? provider.isVisible(this._settings) : true,
            name,
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

    /** Billing-window status for every provider that declares one. */
    _currentPeaks() {
        const peaks = {};
        for (const provider of PROVIDERS) {
            if (provider.peak)
                peaks[provider.id] = peakStatus(Date.now(), localTimeZone());
        }
        return peaks;
    }

    _render() {
        if (!this._widget)
            return;
        const displays = {};
        for (const provider of PROVIDERS)
            displays[provider.id] = this._displayState(provider.id);
        this._widget.updateDisplays(displays, this._currentPeaks());
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
        this._applyVisibility();
    }

    _applyOpacity() {
        if (!this._widget)
            return;
        const opacity = Math.min(1, Math.max(0.2, this._settings.get_double('opacity')));
        this._widget.actor.opacity = Math.round(opacity * 255);
    }

    /**
     * Master visibility is the `visible` setting. With "always on top" off, a
     * fullscreen window on the widget's monitor also hides it; with it on the
     * widget stays visible over fullscreen. We own the actor's `visible` flag
     * (the chrome is tracked with trackFullscreen:false) so the hide button is
     * never undone by the layout manager.
     */
    _applyVisibility() {
        if (!this._widget)
            return;
        let visible = this._settings.get_boolean('visible');
        if (visible && !this._settings.get_boolean('always-on-top')) {
            const monitor = Main.layoutManager.findMonitorForActor(this._widget.actor);
            visible = !(monitor?.inFullscreen ?? false);
        }
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
        this._indItems = {};
        for (const provider of PROVIDERS) {
            const item = new PopupMenu.PopupMenuItem(`${provider.name} —`);
            this._indItems[provider.id] = item;
            this._indicator.menu.addMenuItem(item);
        }
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
        for (const provider of PROVIDERS) {
            const item = this._indItems[provider.id];
            if (!item)
                continue;
            const state = this._displayState(provider.id);
            item.visible = state.visible !== false;
            let markup;
            if (state.error) {
                markup = `${state.name}  ✕ ${esc(state.error.code ?? 'error')}`;
            } else if (!state.reading) {
                markup = `${state.name}  —`;
            } else {
                const currency = state.reading.currency ?? provider.defaultCurrency ?? 'USD';
                const spent = state.spentToday;
                const colour = spent > 0 ? '#ffcc66' : '#9aa1ad';
                const spentPart =
                    `   <span foreground="${colour}">today ${esc(fmtMoney(spent, currency))}</span>`;
                const label = state.reading.headlineLabel
                    ? `${esc(state.reading.headlineLabel)} `
                    : '';
                markup = `${state.name}  ${label}${esc(fmtMoney(state.reading.headline, currency))}${spentPart}`;
            }
            item.label.clutter_text.set_markup(markup);
        }
    }
}