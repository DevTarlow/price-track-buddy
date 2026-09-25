/**
 * Minimal libsoup3 wrapper.
 *
 * gjs 1.88 (GNOME 45-50 era) has no global `fetch`, so all network calls go
 * through Soup. `Soup.Session.send_and_read_async` is used so the shell main
 * loop is never blocked.
 *
 * NOTE: in this gjs, `send_and_read_finish` resolves to a GLib.Bytes directly
 * (not an input stream). The reader handles both shapes defensively.
 */

import Soup from 'gi://Soup';
import GLib from 'gi://GLib';

const session = new Soup.Session();
session.set_timeout(15); // seconds

export function httpGet(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const msg = Soup.Message.new('GET', url);
        const req = msg.get_request_headers();
        req.append('accept', 'application/json');
        for (const [k, v] of Object.entries(headers))
            req.append(k, String(v));

        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, result) => {
            let body = '';
            try {
                const out = sess.send_and_read_finish(result);
                if (out !== null && typeof out.get_data === 'function') {
                    body = new TextDecoder().decode(out.get_data());
                } else if (out !== null && typeof out.read_bytes === 'function') {
                    body = new TextDecoder().decode(out.read_bytes(1 << 20, null).get_data());
                }
            } catch (e) {
                reject(new Error(`request failed: ${String(e)}`));
                return;
            }

            const status = msg.get_status();
            if (status === Soup.Status.TRANSPORT_ERROR || status === Soup.Status.CANCELLED) {
                reject(new Error(`network transport error (status ${status})`));
                return;
            }
            resolve({ status, body });
        });
    });
}