// Host and Origin rules (design 3.2 row 2, 4.3, test group C), and the one definition of "this computer".
//
// DNS rebinding works because the attacker's page keeps using ITS name (evil.example) while the name resolves to the
// GM's address. The browser therefore always sends `Host: evil.example`. A strict allowlist of the names a real user
// types (an IP literal, localhost, this machine's own name) refuses it. An IP literal cannot be rebound: the browser
// connects to exactly the address in the URL, so it is allowed without a list of addresses (strictIp opts into one).
import { hostname as osHostname } from 'node:os';
import { isIP } from 'node:net';
import { cleanIp } from './lan.js';

const HOST_HEADER = /^(?:\[[0-9a-fA-F:.%]{2,60}\]|[A-Za-z0-9.-]{1,253})(?::\d{1,5})?$/;
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1']);
// Capacitor's installed player uses one of these fixed local WebView origins.
// They are not general wildcards: table admission still requires the invite
// proof and every request must target an allowed Host header.
const NATIVE_PLAYER_ORIGINS = new Set(['https://localhost', 'capacitor://localhost']);

/** Splits a Host header into `{ hostname, port }` (hostname lowercase, brackets removed) or null when malformed. */
export function parseHost(value) {
  if (typeof value !== 'string' || value.length > 300 || !HOST_HEADER.test(value)) return null;
  let name = value;
  let port = null;
  if (name.startsWith('[')) {
    const end = name.indexOf(']');
    if (end < 0) return null;
    port = name.slice(end + 2) || null;
    name = name.slice(1, end);
    if (isIP(name) !== 6) return null;
  } else {
    const colon = name.lastIndexOf(':');
    if (colon >= 0) { port = name.slice(colon + 1); name = name.slice(0, colon); }
    if (name.includes(':') || name.length === 0 || name.endsWith('.') || name.startsWith('.') || name.includes('..')) return null;
  }
  if (port !== null && (Number(port) < 1 || Number(port) > 65535)) return null;
  return { hostname: name.toLowerCase(), port };
}

/**
 * @param {object} options
 * @param {() => Array<{address: string}>} [options.getAddresses]  this computer's LAN addresses (only used with strictIp)
 * @param {string} [options.hostname]  this computer's name (defaults to os.hostname())
 * @param {boolean} [options.strictIp]  accept only this computer's own addresses (and loopback) as IP-literal hosts
 */
export function createHostGuard({ getAddresses = () => [], hostname = osHostname(), strictIp = false } = {}) {
  const own = String(hostname || '').toLowerCase();
  const ownNames = new Set(own ? [own, `${own}.local`] : []);
  const loopbackHost = hostname_ => LOOPBACK_NAMES.has(hostname_) || /^127(?:\.\d{1,3}){3}$/.test(hostname_);

  const hostAllowed = value => {
    const parsed = parseHost(value);
    if (!parsed) return false;
    const { hostname: name } = parsed;
    if (name === 'localhost' || ownNames.has(name)) return true;
    if (isIP(name)) {
      if (!strictIp || loopbackHost(name)) return true;
      return getAddresses().some(entry => entry.address === name);
    }
    return false;
  };

  /** The names a browser on the GM computer itself uses. The GM role is only ever served for these. */
  const loopbackHostAllowed = value => {
    const parsed = parseHost(value);
    return Boolean(parsed) && loopbackHost(parsed.hostname);
  };

  /** Normal form of a host for comparing it with an Origin: lowercase, default port 80 dropped. */
  const hostKey = ({ hostname: name, port }) => {
    const shown = name.includes(':') ? `[${name}]` : name;
    return port && port !== '80' ? `${shown}:${port}` : shown;
  };

  /**
   * An Origin is acceptable when it is `http://<the same host:port as the Host header>` and that Host is allowed.
   * A missing Origin is acceptable only when `required` is false; `null` and any other scheme never are.
   */
  const originAllowed = (origin, host, { required = false } = {}) => {
    if (origin === undefined || origin === null || origin === '') return !required;
    if (typeof origin !== 'string' || origin.length > 300 || !hostAllowed(host)) return false;
    if (NATIVE_PLAYER_ORIGINS.has(origin)) return true;
    const match = /^http:\/\/([^/?#]+)$/.exec(origin);
    if (!match) return false;
    const fromOrigin = parseHost(match[1]);
    const fromHost = parseHost(host);
    return Boolean(fromOrigin && fromHost) && hostKey(fromOrigin) === hostKey(fromHost);
  };

  /** True only for the computer's own loopback addresses (127.0.0.0/8, ::1, and their IPv4-mapped forms). */
  const isLoopback = address => {
    if (typeof address !== 'string') return false;
    const ip = cleanIp(address);
    return ip === '::1' || (isIP(ip) === 4 && ip.startsWith('127.'));
  };

  return { hostAllowed, loopbackHostAllowed, originAllowed, isNativePlayerOrigin: origin => NATIVE_PLAYER_ORIGINS.has(origin), isLoopback, parseHost };
}
