// Addresses other devices on the Wi-Fi can use. Replaces `lanAddresses` of the old server/identity.js.
// Every function takes an optional `interfaces` (the shape of os.networkInterfaces()) so tests can describe a network.
import { networkInterfaces } from 'node:os';
import { isIPv4 } from 'node:net';

const VIRTUAL = /vEthernet|VirtualBox|VMware|WSL|Hyper-V|Loopback|Bluetooth|docker|Tailscale|ZeroTier|hamachi|vpn/i;

/** `::ffff:192.168.1.5` -> `192.168.1.5`. Anything else is returned unchanged ('' for non-strings). */
export const cleanIp = address => (typeof address === 'string' ? address.replace(/^::ffff:/i, '') : '');

const toInt = ip => ip.split('.').reduce((n, part) => (n * 256) + Number(part), 0);
const prefixOf = mask => {
  if (!isIPv4(mask)) return null;
  const bits = toInt(mask).toString(2).padStart(32, '0');
  return /^1*0*$/.test(bits) ? bits.indexOf('0') === -1 ? 32 : bits.indexOf('0') : null;
};

/** Addresses other devices on the Wi-Fi can use, most likely first: `[{ name, address, netmask, virtual }]`. */
export function lanAddresses(interfaces = networkInterfaces()) {
  const rank = ({ address, virtual }) => (virtual ? 100 : 0)
    + (address.startsWith('192.168.') ? 0 : address.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(address) ? 2 : 3);
  const found = [];
  for (const [name, entries] of Object.entries(interfaces ?? {})) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || entry.address.startsWith('169.254.')) continue;
      found.push({ name, address: entry.address, netmask: entry.netmask || '255.255.255.0', virtual: VIRTUAL.test(name) });
    }
  }
  return found.sort((a, b) => rank(a) - rank(b));
}

/** The local interface whose subnet contains `ip` (netmask match), or null. */
export function subnetOf(ip, interfaces = networkInterfaces()) {
  const target = cleanIp(ip);
  if (!isIPv4(target)) return null;
  const value = toInt(target);
  for (const entry of lanAddresses(interfaces)) {
    const prefix = prefixOf(entry.netmask);
    if (prefix === null || prefix === 0) continue;
    const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
    if (((toInt(entry.address) & mask) >>> 0) === ((value & mask) >>> 0)) {
      return { ...entry, prefix };
    }
  }
  return null;
}

/** The GM computer's address on the same subnet as `playerIp`; the first LAN address when none matches; null without any. */
export function addressFor(playerIp, interfaces = networkInterfaces()) {
  return subnetOf(playerIp, interfaces)?.address ?? lanAddresses(interfaces)[0]?.address ?? null;
}

/** A bound view for consumers that keep one object around (access.lan). `interfaces` may be a function for live data. */
export function createLan(interfaces = networkInterfaces) {
  const get = () => (typeof interfaces === 'function' ? interfaces() : interfaces);
  return {
    addresses: () => lanAddresses(get()),
    subnetOf: ip => subnetOf(ip, get()),
    addressFor: ip => addressFor(ip, get()),
    cleanIp,
  };
}
