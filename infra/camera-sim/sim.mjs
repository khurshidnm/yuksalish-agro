#!/usr/bin/env node
/**
 * Acts as the farm's edge device for the simulated cameras, through the same API a real one uses.
 *   node infra/camera-sim/sim.mjs setup                   register two cameras and create an API key
 *   node infra/camera-sim/sim.mjs run                     send heartbeats and serve snapshots
 *   node infra/camera-sim/sim.mjs event <type> [severity] send a detection with a real frame
 *
 * Types the platform names in every language: animal_count, inactivity, isolation, lambing_activity,
 * trough_empty, person, vehicle, gate_open, smoke, fire. Severity `urgent` raises an alert and reaches
 * Telegram, repeating until acknowledged, so use it on purpose. The server makes smoke and fire urgent
 * whatever is given here.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const API = process.env.YAP_API ?? 'http://localhost:4000/api/v1';
const KEY_FILE = join(here, '.key');
const SNAPSHOT_PORT = 8891;
const HEARTBEAT_MS = 60_000;
const CAMERAS = [
  { name: 'Molxona ichi — 1', path: 'barn-1' },
  { name: 'Molxona ichi — 2', path: 'barn-2' },
];

const state = () => JSON.parse(readFileSync(KEY_FILE, 'utf8'));

async function login() {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '+998900000001', password: process.env.YAP_PASSWORD ?? 'Yuksalish2026!' }),
  });
  const body = await res.json();
  if (!body.data?.accessToken) throw new Error(`Sign-in failed: ${res.status}`);
  return body.data.accessToken;
}

async function setup() {
  const token = await login();
  const api = async (path, method = 'GET', body) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
    return json.data;
  };
  const devices = await api('/devices?pageSize=100');
  const key = await api('/settings/api-keys', 'POST', { name: 'Simulated edge device', scopes: ['events:write'] });
  const cameras = {};
  for (const camera of CAMERAS) {
    const device = devices.find((d) => d.name === camera.name);
    if (!device) throw new Error(`Camera not found: ${camera.name}. Is the demo data seeded?`);
    await api(`/devices/${device.id}`, 'PATCH', {
      streamUrl: `rtsp://localhost:8554/${camera.path}`,
      liveUrl: `http://localhost:8889/${camera.path}`,
      notes: 'Simulated camera: looping video, see infra/camera-sim/README.md',
    });
    cameras[camera.path] = device.id;
    console.log(`${camera.name}: connected to ${camera.path}`);
  }
  writeFileSync(KEY_FILE, JSON.stringify({ key: key.key, cameras }, null, 2), { mode: 0o600 });
  console.log('API key saved to infra/camera-sim/.key');
}

async function send(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': state().key },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Grab one real frame from the running stream, the way an edge device would. */
function snapshot(path) {
  const file = `${path}-${Date.now()}.jpg`;
  execFileSync('docker', [
    'exec', 'yap-camera-camera-1', 'ffmpeg', '-loglevel', 'error', '-rtsp_transport', 'tcp',
    '-i', `rtsp://localhost:8554/${path}`, '-frames:v', '1', '-y', `/snapshots/${file}`,
  ]);
  return `http://localhost:${SNAPSHOT_PORT}/${file}`;
}

async function event(type, severity = 'attention') {
  const path = 'barn-1';
  const snapshotUrl = snapshot(path);
  const result = await send('/devices/events', {
    deviceId: state().cameras[path],
    type,
    severity,
    data: { simulated: true, source: 'infra/camera-sim', confidence: 0.91 },
    snapshotUrl,
  });
  console.log(`Sent ${type}: ${JSON.stringify(result.data)}`);
}

function run() {
  createServer((req, res) => {
    const name = (req.url ?? '').split('?')[0].replace(/^\/+/, '');
    if (!/^[a-z0-9-]+\.jpg$/.test(name)) return void res.writeHead(404).end();
    try {
      res.writeHead(200, { 'content-type': 'image/jpeg' }).end(readFileSync(join(here, 'snapshots', name)));
    } catch {
      res.writeHead(404).end();
    }
  }).listen(SNAPSHOT_PORT, '127.0.0.1');

  const beat = async () => {
    for (const id of Object.values(state().cameras)) {
      await send('/devices/heartbeat', { deviceId: id }).catch((e) => console.error(e.message));
    }
    console.log(`Heartbeat sent at ${new Date().toLocaleTimeString()}`);
  };
  beat();
  setInterval(beat, HEARTBEAT_MS);
}

const [command, ...args] = process.argv.slice(2);
const commands = { setup, run, event: () => event(...args) };
if (!commands[command]) {
  console.log('Usage: sim.mjs setup | run | event <type> [info|attention|urgent]');
  process.exit(1);
}
Promise.resolve(commands[command]()).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
