/**
 * Requests to addresses that tenants give us: webhook subscribers and camera gateways. Such an address
 * could otherwise reach the server's own network (metadata endpoints, Redis, Postgres), so this only
 * ever connects to public addresses, and it never follows a redirect.
 */
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

const blockedIpv4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, and cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], // IETF assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // old 6to4 relays
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 3], // multicast, reserved, broadcast
] as const) {
  blockedIpv4.addSubnet(network, prefix, 'ipv4');
}

// Public IPv6 is 2000::/3, so the rest goes as a whole: loopback, IPv4 written as IPv6, NAT64, link-local,
// site-local, unique local, multicast. Listing ranges one by one is how a form gets missed. A list of its
// own, because a BlockList also matches IPv4 addresses against its IPv6 ranges.
const blockedIpv6 = new BlockList();
for (const [network, prefix] of [
  ['::', 3],
  ['4000::', 2],
  ['8000::', 1],
  ['2001::', 23], // IETF assignments, including Teredo, which can carry any IPv4 address
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4, which can carry any IPv4 address
  ['3fff::', 20], // documentation
] as const) {
  blockedIpv6.addSubnet(network, prefix, 'ipv6');
}

/** Anything that cannot be read as an address counts as private. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blockedIpv4.check(address, 'ipv4');
  return family === 0 || blockedIpv6.check(address.split('%')[0], 'ipv6');
}

export type Resolver = (hostname: string) => Promise<string[]>;

export const dnsResolver: Resolver = async (hostname) => (await lookup(hostname, { all: true })).map((r) => r.address);

/** Runs as the socket connects, so what passes here is what it connects to: DNS gets no second answer. */
function publicLookup(resolve: Resolver): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
          callback(new Error(`${hostname} does not resolve to a public address`), '', 0);
          return;
        }
        const found = addresses.map((address) => ({ address, family: isIP(address) }));
        if (options.all) callback(null, found);
        else callback(null, found[0].address, found[0].family);
      },
      (err: NodeJS.ErrnoException) => callback(err, '', 0),
    );
  };
}

export interface PublicRequest {
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  /** Keep the answer's body, failing if it is larger than this. Left out, only the status is read. */
  maxBytes?: number;
}

export interface PublicResponse {
  status: number;
  body: Buffer;
}

export function requestPublic(raw: string, init: PublicRequest, resolve: Resolver = dnsResolver): Promise<PublicResponse> {
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((done, fail) => {
    // A literal address never goes through the lookup.
    if (isIP(host) && isPrivateAddress(host)) {
      fail(new Error(`${host} is not a public address`));
      return;
    }
    const { method, headers, signal, maxBytes } = init;
    // agent: false, or a kept-alive socket would skip the lookup.
    const request = send(url, { method, headers, signal, lookup: publicLookup(resolve), agent: false }, (response) => {
      const status = response.statusCode ?? 0;
      if (maxBytes === undefined) {
        response.destroy();
        done({ status, body: Buffer.alloc(0) });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        chunks.push(chunk);
        if (size > maxBytes) {
          fail(new Error('The answer is too large'));
          request.destroy();
        }
      });
      response.on('end', () => done({ status, body: Buffer.concat(chunks) }));
      // After a finished answer this changes nothing, and a cut one would otherwise never settle.
      response.on('close', () => fail(new Error('The connection closed early')));
    });
    request.on('error', fail);
    request.end(init.body);
  });
}
