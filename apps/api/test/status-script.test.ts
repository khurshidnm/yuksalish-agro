import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** The real scripts, with Docker and the rest of a server replaced by small fakes in a bin folder. */
const INFRA = resolve(__dirname, '../../../infra');
const TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ';

let root: string;
let bin: string;

function fake(name: string, script: string) {
  writeFileSync(join(bin, name), `#!/bin/bash\n${script}\n`);
  chmodSync(join(bin, name), 0o755);
}

function bash(args: string[], extra: Record<string, string> = {}) {
  const { stdout, stderr } = spawnSync('bash', args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE: root,
      ENV_FILE: join(root, 'env'),
      COMPOSE_FILE: join(root, 'compose.yml'),
      COMPOSE_PROJECT: 'yap-test',
      YAP_STATE_DIR: join(root, 'state'),
      YAP_WATCHDOG_CRON: join(root, 'cron'),
      TELEGRAM_BOT_TOKEN: '',
      ...extra,
    },
  });
  return `${stdout}${stderr}`;
}

const status = (extra: Record<string, string> = {}) => bash([join(INFRA, 'status.sh')], extra);

/** A shell function or block of a script, as written there, to run without the rest of the script. */
const part = (script: string, from: RegExp, to: RegExp) => {
  const lines = readFileSync(join(INFRA, script), 'utf8').split('\n');
  const start = lines.findIndex((line) => from.test(line));
  return lines.slice(start, lines.findIndex((line, i) => i > start && to.test(line))).join('\n');
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'yap-status-'));
  bin = join(root, 'bin');
  mkdirSync(bin);
  mkdirSync(join(root, 'state'));
  writeFileSync(join(root, 'env'), 'WEB_ORIGIN=https://farm.test\n');
  fake(
    'docker',
    `case "$*" in
  *" ps -q "*) service="\${*: -1}"; [[ -e "$FAKE/stopped-$service" ]] || echo "id-$service" ;;
  "inspect "*) [[ -n "\${*: -1}" ]] || { echo; exit 1; }; echo healthy ;;
  *" exec -T api node -e "*) echo ok ;;
  "info "*) echo /var/lib/docker ;;
esac`,
  );
  fake('curl', 'printf 200');
  fake('timeout', 'shift; exec "$@"');
  fake('df', `[[ -e "$FAKE/disk" ]] || exit 1\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/sda1 100 40 60 %s%% /\\n' "$(cat "$FAKE/disk")"`);
  writeFileSync(join(root, 'disk'), '40');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('status.sh on Telegram', () => {
  it('with no token it says no alert can leave the app, and does not vouch for Telegram', () => {
    const said = status();

    expect(said).toMatch(/^ {2}LOOK {2}TELEGRAM_BOT_TOKEN is empty, so no alert can leave the app/m);
    expect(said).toContain('ok    Deep health check: database, Redis, background worker and disk');
    expect(said).not.toContain('urgent alerts, Telegram');
  });

  it('with a token it names them as before', () => {
    const said = status({ TELEGRAM_BOT_TOKEN: TOKEN });

    expect(said).toContain('ok    Deep health check: database, Redis, background worker, urgent alerts, Telegram and disk');
    expect(said).not.toContain('no alert can leave the app');
  });
});

describe('status.sh on what it cannot read', () => {
  it('a stopped service is one whole line', () => {
    writeFileSync(join(root, 'stopped-redis'), '');

    const said = status();

    expect(said).toMatch(/^ {2}LOOK {2}redis is not running\. See its log: docker compose/m);
    expect(said).toMatch(/^ {2}ok {4}api$/m);
  });

  it.each([
    ['no reading', null, /LOOK {2}The disk could not be read/],
    ['a dash, as df gives for a pseudo file system', '-', /LOOK {2}The disk could not be read/],
    ['84%', '84', /ok {4}Disk 84% full/],
    ['85%', '85', /LOOK {2}The disk is 85% full/],
  ])('disk: %s', (_label, reading, line) => {
    if (reading === null) rmSync(join(root, 'disk'));
    else writeFileSync(join(root, 'disk'), reading);

    const said = status();

    expect(said).toMatch(line);
    expect(said).not.toContain('Disk ?%');
  });
});

describe('preflight.sh on Telegram', () => {
  const block = () => part('preflight.sh', /^telegram_token=/, /^storage=/);
  const run = (extra: Record<string, string> = {}) =>
    bash(['-c', `source '${join(INFRA, 'lib.sh')}'; warn() { echo "WARN $*"; }; fail() { echo "FAIL $*"; }; pass() { echo "ok $*"; }; telegram_check_here() { echo ok; }; telegram_words() { echo fine; }; first_deploy=no\n${block()}`], extra);

  it('warns in plain words when the token is empty', () => {
    expect(run()).toContain('WARN TELEGRAM_BOT_TOKEN is empty, so no alert can leave the app.');
  });

  it('says nothing of the kind when there is a token', () => {
    expect(run({ TELEGRAM_BOT_TOKEN: TOKEN })).not.toContain('no alert can leave the app');
  });
});

describe('deploy.sh --rollback', () => {
  const list = () => join(root, 'state', 'images-1.list');
  const lastDeploy = () => join(root, 'state', 'last-deploy');
  const forgetAfterRollback = () =>
    bash(['-c', `source '${join(INFRA, 'lib.sh')}'\n${part('deploy.sh', /^forget_images\(\)/, /^restore_images\(\)/)}\nnote_rollback '${list()}'\nforget_images '${list()}'`]);

  beforeEach(() => {
    fake('date', 'echo 2026-11-06T04:35:55+00:00');
    writeFileSync(list(), '');
    writeFileSync(lastDeploy(), 'commit=new1234\ndeployed_at=2026-11-05T23:35:27+00:00\n');
  });

  it('leaves the commit it went back to, and says it was a rollback, with status.sh showing it', () => {
    writeFileSync(join(root, 'state', 'images-1.deploy'), 'commit=old5678\ndeployed_at=2026-11-01T10:00:00+00:00\n');

    forgetAfterRollback();

    expect(readFileSync(lastDeploy(), 'utf8')).toBe('commit=old5678\nrolled_back_at=2026-11-06T04:35:55+00:00\nundoing=new1234\n');
    expect(existsSync(join(root, 'state', 'images-1.deploy'))).toBe(false);
    expect(status()).toContain('ok    Last deploy: commit=old5678 rolled_back_at=2026-11-06T04:35:55+00:00 undoing=new1234');
  });

  it('images remembered before this was added name no commit, rather than a wrong one', () => {
    forgetAfterRollback();

    expect(readFileSync(lastDeploy(), 'utf8')).toBe('commit=unknown\nrolled_back_at=2026-11-06T04:35:55+00:00\nundoing=new1234\n');
  });

  it('the rollback writes it before it forgets the images, and each deploy keeps what it replaced', () => {
    const rollback = part('deploy.sh', /^if \[\[ "\$mode" == "rollback" \]\]; then/, /^fi$/);
    expect(rollback.indexOf('note_rollback "$list"')).toBeGreaterThan(-1);
    expect(rollback.indexOf('note_rollback "$list"')).toBeLessThan(rollback.indexOf('forget_images "$list"'));
    expect(part('deploy.sh', /^remember_images\(\)/, /^}/)).toContain('cp "$STATE_DIR/last-deploy" "${images_list%.list}.deploy"');
  });
});
