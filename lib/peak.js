/**
 * DeepSeek peak / off-peak billing windows.
 *
 * Ported from the DeepSeek Harness "balance-buddy" plugin (peak.ts) so the
 * panel shows the same windows the Harness uses: peak is Monday-Friday
 * 09:00-12:00 and 14:00-18:00 Beijing time; weekends are off-peak all day.
 *
 * The schedule is fixed in UTC: UTC 01:00-04:00 and 06:00-10:00 on weekdays.
 * All rendered times use the host time zone.
 */

export const PEAK_WINDOWS_UTC = [
    { startMinute: 1 * 60, endMinute: 4 * 60 },
    { startMinute: 6 * 60, endMinute: 10 * 60 },
];

export const PEAK_WEEKDAYS_UTC = [1, 2, 3, 4, 5];

export const OFF_PEAK_MULTIPLIER = 0.5;

const SCAN_MINUTES = 8 * 24 * 60;

export function isPeak(instant) {
    const d = new Date(instant);
    if (!PEAK_WEEKDAYS_UTC.includes(d.getUTCDay()))
        return false;
    const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
    return PEAK_WINDOWS_UTC.some(
        (w) => minutes >= w.startMinute && minutes < w.endMinute);
}

/**
 * Next instant (epoch ms) at which the billing state flips, scanning forward
 * in whole minutes. Always returns a future instant; on the boundary of an
 * active window it steps one extra minute so the result is strictly > now.
 */
export function nextTransition(instant) {
    let probe = Math.floor(instant / 60000) * 60000;
    while (probe - instant < SCAN_MINUTES * 60000) {
        if (isPeak(probe) !== isPeak(instant))
            return probe;
        probe += 60000;
    }
    return instant + SCAN_MINUTES * 60000; // unreachable safety net
}

export function localTimeZone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Local weekday + 12-hour clock, e.g. `Thu 11:00 PM` (no locale comma). */
export function formatLocal(instant, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
    }).formatToParts(instant);
    const part = (type) => parts.find((p) => p.type === type)?.value ?? '';
    return `${part('weekday')} ${part('hour')}:${part('minute')} ${part('dayPeriod')}`;
}

/**
 * Snapshot of the billing state for the widget.
 * @param {number} instant epoch ms
 * @param {string} timeZone IANA zone, defaults to the host zone
 */
export function peakStatus(instant, timeZone = localTimeZone()) {
    const active = isPeak(instant);
    const nextChangeAt = nextTransition(instant);
    return {
        active,
        priceMultiplier: active ? 1 : OFF_PEAK_MULTIPLIER,
        timeZone,
        nextChangeAt,
        nextChangeIn: nextChangeAt - instant,
        nextIsPeak: isPeak(nextChangeAt),
        nextChangeLocal: formatLocal(nextChangeAt, timeZone),
    };
}