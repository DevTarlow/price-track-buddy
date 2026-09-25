/**
 * Small pure formatting helpers shared by the widget and the indicator.
 */

export function fmtMoney(amount, currency = 'USD') {
    if (!Number.isFinite(amount))
        return '—';
    const digits = amount !== 0 && Math.abs(amount) < 0.01 ? 4 : 2;
    try {
        return new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency,
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
        }).format(amount);
    } catch (e) {
        return `${amount.toFixed(digits)} ${currency}`;
    }
}

export function fmtSigned(amount, currency = 'USD') {
    if (!Number.isFinite(amount) || amount === 0)
        return '';
    return amount > 0
        ? `▲ +${fmtMoney(amount, currency)}`
        : `▼ −${fmtMoney(-amount, currency)}`;
}

export function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0)
        return '…';
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0)
        return `${h}h ${String(m).padStart(2, '0')}m`;
    if (m > 0)
        return `${m}m ${String(s).padStart(2, '0')}s`;
    return `${s}s`;
}

export function fmtClock(ms) {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtAgo(ms) {
    const s = Math.floor((Date.now() - ms) / 1000);
    if (s < 60)
        return `${Math.max(1, s)}s ago`;
    if (s < 3600)
        return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
}

/** Local calendar day key, YYYY-MM-DD. */
export function localDayKey(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function errorText(code) {
    switch (code) {
    case 'no-key':
        return 'No API key set — open Settings and add one.';
    case 'unauthorized':
        return 'API key rejected (401) — check it in Settings.';
    case 'http':
        return 'Server answered with an unexpected status.';
    case 'malformed':
        return 'Unexpected response from the API.';
    case 'empty':
        return 'API returned no balance information.';
    case 'network':
        return 'Network error — is the machine online?';
    default:
        return 'Something went wrong.';
    }
}