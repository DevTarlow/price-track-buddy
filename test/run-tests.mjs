/**
 * Price Track Buddy — gjs unit / integration tests.
 *
 * Run:   gjs -m test/run-tests.mjs
 *
 * Covers the pure logic (peak windows, formatting, ledger persistence,
 * movement math) and the live provider error paths (bogus key → 401).
 * Network probes are skipped with a warning when the machine is offline.
 */

import GLib from 'gi://GLib';
import System from 'system';

import {
    isPeak,
    nextTransition,
    peakStatus,
    localTimeZone,
} from '../lib/peak.js';
import {
    fmtMoney,
    fmtSigned,
    fmtDuration,
    fmtClock,
    fmtAgo,
    localDayKey,
    errorText,
} from '../lib/format.js';
import { Ledger } from '../lib/ledger.js';
import {
    DeepSeekProvider,
    OpenRouterProvider,
    ProviderError,
    deepseekMovement,
    openrouterMovement,
} from '../lib/providers.js';

let pass = 0;
let fail = 0;
let warn = 0;

function check(name, cond, detail = '') {
    if (cond) {
        pass++;
        console.log(`PASS  ${name}`);
    } else {
        fail++;
        console.log(`FAIL  ${name}  ${detail}`);
    }
}

function near(a, b, eps = 1e-9) {
    return Math.abs(a - b) <= eps;
}

/* ------------------------------------------------------------- peak windows */

// 2024-01-08 is a Monday (UTC).
const MON_OFF = Date.UTC(2024, 0, 8, 5, 0);   // 13:00 Beijing → off
const MON_PEAK = Date.UTC(2024, 0, 8, 2, 0);  // 10:00 Beijing → peak
const MON_PEAK2 = Date.UTC(2024, 0, 8, 7, 30); // 15:30 Beijing → peak
const MON_NIGHT = Date.UTC(2024, 0, 8, 23, 0); // 07:00 Beijing Tue → off
const SAT = Date.UTC(2024, 0, 6, 2, 0);        // Saturday → off always

check('isPeak weekday morning window', isPeak(MON_PEAK) === true);
check('isPeak weekday midday gap', isPeak(MON_OFF) === false);
check('isPeak weekday afternoon window', isPeak(MON_PEAK2) === true);
check('isPeak weekday night', isPeak(MON_NIGHT) === false);
check('isPeak weekend', isPeak(SAT) === false);

check('nextTransition leaves peak at 04:00 UTC',
    nextTransition(MON_PEAK) === Date.UTC(2024, 0, 8, 4, 0));
check('nextTransition enters peak at 06:00 UTC',
    nextTransition(MON_OFF) === Date.UTC(2024, 0, 8, 6, 0));
check('nextTransition is strictly in the future',
    nextTransition(Date.now()) > Date.now());

const psPeak = peakStatus(MON_PEAK, 'Asia/Shanghai');
const psOff = peakStatus(SAT, 'Asia/Shanghai');
check('peakStatus active flag', psPeak.active === true);
check('peakStatus multiplier 1 during peak', psPeak.priceMultiplier === 1);
check('peakStatus nextIsPeak false after peak window', psPeak.nextIsPeak === false);
check('peakStatus weekend off-peak', psOff.active === false);
check('peakStatus half price off-peak', psOff.priceMultiplier === 0.5);
check('peakStatus next is peak after weekend',
    psOff.nextIsPeak === true && psOff.nextChangeAt > SAT);
check('peakStatus local render', typeof psOff.nextChangeLocal === 'string' &&
    psOff.nextChangeLocal.length > 0);
check('localTimeZone returns a sane zone',
    typeof localTimeZone() === 'string' && localTimeZone().includes('/'));

/* ---------------------------------------------------------------- formatting */

check('fmtMoney USD', fmtMoney(12.3, 'USD') === '$12.30');
check('fmtMoney tiny amount uses 4 decimals', fmtMoney(0.001, 'USD') === '$0.0010');
check('fmtMoney NaN dash', fmtMoney(NaN) === '—');
check('fmtMoney unknown currency fallback', fmtMoney(5, 'XYZ').includes('XYZ'));
check('fmtSigned positive ▲', fmtSigned(5, 'USD').startsWith('▲ +'));
check('fmtSigned negative ▼', fmtSigned(-5, 'USD').startsWith('▼ −'));
check('fmtSigned zero empty', fmtSigned(0) === '');
check('fmtDuration hours', fmtDuration(3661000) === '1h 01m');
check('fmtDuration minutes', fmtDuration(65000) === '1m 05s');
check('fmtDuration seconds', fmtDuration(3000) === '3s');
check('fmtClock', fmtClock(new Date(2024, 0, 8, 9, 5)) === '09:05');
check('localDayKey', localDayKey(new Date(2024, 0, 5, 23, 59)) === '2024-01-05');
check('errorText unauthorized mentions 401', errorText('unauthorized').includes('401'));
check('errorText no-key', errorText('no-key').includes('key'));
check('errorText fallback', errorText('bogus') === 'Something went wrong.');

// fmtAgo is time-dependent; just verify it does not throw and returns text.
check('fmtAgo recent', typeof fmtAgo(Date.now() - 30000) === 'string');

/* ------------------------------------------------------------------- ledger */

const TEST_DIR = `${GLib.getenv('TMPDIR') ?? '/tmp'}/ptb-ledger-test-${Date.now()}`;
GLib.mkdir_with_parents(TEST_DIR, 0o755);

{
    const l = new Ledger({ provider: 'deepseek', currency: 'CNY', dir: TEST_DIR }).load();
    check('fresh ledger has no data', l.hasData() === false);

    l.record({ at: 1000, total: 100 });
    const m = deepseekMovement({ total: 100 }, { total: 97.5 });
    check('deepseek spend delta', near(m.spentDelta, 2.5) && m.toppedUpDelta === 0);
    const up = deepseekMovement({ total: 97.5 }, { total: 102 });
    check('deepseek top-up delta', near(up.toppedUpDelta, 4.5) && up.spentDelta === 0);

    l.record({ at: 2000, total: 97.5, spentDelta: m.spentDelta, toppedUpDelta: 0, extra: { granted: 10, toppedUp: 90 } });
    l.record({ at: 3000, total: 102, spentDelta: 0, toppedUpDelta: 4.5, extra: { granted: 10, toppedUp: 94.5 } });
    check('ledger lifetimeSpent', near(l.lifetimeSpent, 2.5));
    check('ledger lifetimeToppedUp', near(l.lifetimeToppedUp, 4.5));
    check('ledger lastExtra', l.lastExtra?.toppedUp === 94.5);
    check('ledger today spent', l.spentToday(2000) === 2.5);
    check('ledger today toppedUp', l.toppedUpToday(3000) === 4.5);
    check('ledger points length', l.points.length === 3);

    const l2 = new Ledger({ provider: 'deepseek', currency: 'CNY', dir: TEST_DIR }).load();
    check('ledger round-trips through disk', l2.hasData() === true &&
        near(l2.lifetimeSpent, 2.5) && l2.points.length === 3);

    const l3 = new Ledger({ provider: 'deepseek', currency: 'USD', dir: TEST_DIR }).load();
    check('ledger resets on currency change', l3.hasData() === false);
}

{
    // OpenRouter usage movement + series trimming.
    const l = new Ledger({ provider: 'openrouter', currency: 'USD', dir: TEST_DIR }).load();
    const m = openrouterMovement(
        { usage: 10, purchased: 50 },
        { usage: 12.5, purchased: 50 });
    check('openrouter spend delta', near(m.spentDelta, 2.5) && m.toppedUpDelta === 0);
    const up = openrouterMovement(
        { usage: 12.5, purchased: 50 },
        { usage: 12.5, purchased: 70 });
    check('openrouter top-up delta', near(up.toppedUpDelta, 20) && up.spentDelta === 0);

    const start = Date.now();
    for (let i = 0; i < 500; i++)
        l.record({ at: start + i * 1000, total: 100 - i * 0.01 });
    check('ledger trims past MAX_POINTS', l.points.length <= 480 && l.points.length > 240);
}

/* --------------------------------------------------- provider error paths */

async function expectProviderError(name, promise, code) {
    try {
        await promise;
        check(`${name} rejects`, false, 'resolved instead of rejecting');
    } catch (e) {
        if (e instanceof ProviderError) {
            if (e.code === 'network') {
                warn++;
                console.log(`WARN  ${name} — no network (${e.message}); skipping`);
            } else {
                check(`${name} rejects with ${code}`, e.code === code, `got ${e.code}`);
            }
        } else {
            check(`${name} rejects with ProviderError`, false, String(e));
        }
    }
}

await expectProviderError('DeepSeek no-key', new DeepSeekProvider({ apiKey: '' }).getBalance(), 'no-key');
await expectProviderError('OpenRouter no-key', new OpenRouterProvider({ apiKey: '' }).getCredits(), 'no-key');
await expectProviderError('DeepSeek bogus key', new DeepSeekProvider({ apiKey: 'sk-ptb-bogus-test' }).getBalance(), 'unauthorized');
await expectProviderError('OpenRouter bogus key', new OpenRouterProvider({ apiKey: 'sk-or-v1-ptb-bogus-test' }).getCredits(), 'unauthorized');

/* ------------------------------------------------------------------ summary */

console.log(`\nRESULT  ${pass} passed, ${fail} failed, ${warn} warned`);
System.exit(fail > 0 ? 1 : 0);