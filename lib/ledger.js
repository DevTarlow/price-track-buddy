/**
 * Time series ledger for one provider, persisted as JSON under
 * $XDG_DATA_HOME/price-track-buddy/<provider>.json.
 *
 * Mirrors the balance-buddy ledger discipline:
 *  - spend is derived from consecutive readings (delta of balance / usage);
 *  - daily buckets accumulate spent / topped-up per local calendar day;
 *  - the point series is capped and halved (averaged) when it grows too big;
 *  - a currency change resets tracking (a new currency is not comparable).
 */

import GLib from 'gi://GLib';

import { localDayKey } from './format.js';

export const LEDGER_VERSION = 1;
export const MAX_POINTS = 480;
const DAY_MS = 24 * 60 * 60 * 1000;

function freshData(provider, currency) {
    return {
        version: LEDGER_VERSION,
        provider,
        currency: currency || null,
        trackedSince: null,
        openingTotal: null,
        lastAt: null,
        lastTotal: null,
        lastExtra: null,
        lifetimeSpent: 0,
        lifetimeToppedUp: 0,
        daily: {},
        points: [],
    };
}

export class Ledger {
    constructor({ provider, currency = null, dir }) {
        this.provider = provider;
        this.currency = currency ?? null;
        this.dir = dir;
        this.file = `${dir}/${provider}.json`;
        this.data = freshData(provider, currency);
    }

    load() {
        let parsed = null;
        try {
            const [ok, contents] = GLib.file_get_contents(this.file);
            if (ok)
                parsed = JSON.parse(new TextDecoder().decode(contents));
        } catch (e) {
            parsed = null;
        }

        if (!parsed || parsed.version !== LEDGER_VERSION || parsed.provider !== this.provider)
            parsed = null;
        // Currency changed since the last tracking run → start fresh.
        if (parsed && this.currency && parsed.currency && parsed.currency !== this.currency)
            parsed = null;

        if (parsed) {
            parsed.daily = parsed.daily && typeof parsed.daily === 'object' ? parsed.daily : {};
            parsed.points = Array.isArray(parsed.points) ? parsed.points.slice(0, MAX_POINTS) : [];
            this.data = parsed;
            // Adopt the currency a previous run recorded, if we did not know one.
            if (!this.currency && parsed.currency)
                this.currency = parsed.currency;
        }
        return this;
    }

    save() {
        try {
            GLib.mkdir_with_parents(this.dir, 0o755);
            const tmp = `${this.file}.tmp`;
            GLib.file_set_contents(tmp, JSON.stringify(this.data));
            GLib.rename(tmp, this.file);
        } catch (e) {
            console.log(`PriceTrackBuddy: could not persist ledger ${this.file}: ${e}`);
        }
    }

    hasData() {
        return this.data.lastAt !== null;
    }

    get points() {
        return this.data.points;
    }

    get lastTotal() {
        return this.data.lastTotal;
    }

    get lastExtra() {
        return this.data.lastExtra;
    }

    get lifetimeSpent() {
        return this.data.lifetimeSpent;
    }

    get lifetimeToppedUp() {
        return this.data.lifetimeToppedUp;
    }

    record({ at, total, spentDelta = 0, toppedUpDelta = 0, extra = null }) {
        const d = this.data;
        if (!d.trackedSince) {
            d.trackedSince = at;
            d.openingTotal = total;
        }
        d.lastAt = at;
        d.lastTotal = total;
        if (this.currency && !d.currency)
            d.currency = this.currency;
        if (extra !== null)
            d.lastExtra = extra;

        const day = localDayKey(at);
        if (!d.daily[day])
            d.daily[day] = { spent: 0, toppedUp: 0 };
        d.daily[day].spent += spentDelta;
        d.daily[day].toppedUp += toppedUpDelta;
        d.lifetimeSpent += spentDelta;
        d.lifetimeToppedUp += toppedUpDelta;
        d.points.push({ at, total });
        this._trimPoints();
        this.save();
        return this;
    }

    _trimPoints() {
        const pts = this.data.points;
        if (pts.length <= MAX_POINTS)
            return;
        // Halve the series by averaging neighbours, roughly preserving shape.
        const half = [];
        for (let i = 0; i + 1 < pts.length; i += 2)
            half.push({
                at: (pts[i].at + pts[i + 1].at) / 2,
                total: (pts[i].total + pts[i + 1].total) / 2,
            });
        this.data.points = half;
    }

    spentToday(at = Date.now()) {
        const b = this.data.daily[localDayKey(at)];
        return b ? b.spent : 0;
    }

    toppedUpToday(at = Date.now()) {
        const b = this.data.daily[localDayKey(at)];
        return b ? b.toppedUp : 0;
    }

    spentLastNDays(n, at = Date.now()) {
        let sum = 0;
        for (let i = 0; i < n; i++) {
            const key = localDayKey(at - i * DAY_MS);
            sum += this.data.daily[key]?.spent ?? 0;
        }
        return sum;
    }
}