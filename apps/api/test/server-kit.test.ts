import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The scripts that look after a running server, run for real. Docker and anything else a laptop lacks
 * are replaced by small fakes in a bin folder. Nothing here reaches the real Telegram.
 */
const INFRA = resolve(__dirname, '../../../infra');
const read = (name: string) => readFileSync(join(INFRA, name), 'utf8');

let root: string;
let bin: string;

function fake(name: string, script: string) {
  writeFileSync(join(bin, name), `#!/bin/bash\n${script}\n`);
  chmodSync(join(bin, name), 0o755);
}

function env(extra: Record<string, string> = {}) {
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE: root,
    ENV_FILE: join(root, 'env'),
    COMPOSE_FILE: join(root, 'compose.yml'),
    COMPOSE_PROJECT: 'yap-test',
    YAP_STATE_DIR: join(root, 'state'),
    ...extra,
  };
}

/** Not spawnSync: the fake Telegram lives in this process, so the event loop has to keep turning. */
function run(command: string, args: string[], extra: Record<string, string> = {}, input = '') {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(command, args, { env: env(extra) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => done({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

/** One line of bash with infra/lib.sh loaded. */
const lib = (line: string, extra: Record<string, string> = {}) => run('bash', ['-c', `source '${join(INFRA, 'lib.sh')}'; ${line}`], extra);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'yap-kit-'));
  bin = join(root, 'bin');
  mkdirSync(bin);
  mkdirSync(join(root, 'state'));
  writeFileSync(join(root, 'env'), 'FOO=bar\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('asking Telegram about the bot', () => {
  const TOKEN = '123456789:this-token-must-stay-out-of-every-log';
  let telegram: Server;
  let answer: (res: import('node:http').ServerResponse) => void;
  let asked: string[];

  beforeEach(async () => {
    asked = [];
    telegram = createServer((req, res) => {
      asked.push(req.url ?? '');
      answer(res);
    });
    await new Promise<void>((listening) => telegram.listen(0, '127.0.0.1', () => listening()));
    // docker compose -p x -f y --env-file z exec -T api node -
    fake(
      'docker',
      `[[ ! -e "$FAKE/api-down" ]] || exit 1
while [[ "$1" != "exec" ]]; do shift; done
shift 3
exec "$@"`,
    );
  });

  afterEach(async () => {
    telegram.closeAllConnections();
    await new Promise((closed) => telegram.close(closed));
  });

  const address = () => `http://127.0.0.1:${(telegram.address() as AddressInfo).port}`;
  const settings = () => ({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_API: address() });
  const json = (status: number, body: unknown) => (res: import('node:http').ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  /** The same question both ways: from inside the API container, and from this server for preflight. */
  const both = [
    ['from inside the API container', 'telegram_check_api'],
    ['from the server itself', 'telegram_check_here'],
  ] as const;

  describe.each(both)('%s', (_where, check) => {
    const ask = async (extra: Record<string, string> = {}) => {
      const result = await lib(`answer="$(${check})"; echo "$answer"; telegram_words "$answer"; echo "exit=$?"`, { ...settings(), ...extra });
      expect(result.stdout + result.stderr).not.toContain(TOKEN);
      expect(result.stdout + result.stderr).not.toContain('must-stay-out');
      return result.stdout;
    };

    it('names the bot when Telegram accepts the token, and asks with getMe', async () => {
      answer = json(200, { ok: true, result: { id: 1, is_bot: true, username: 'agropanel_bot' } });
      const said = await ask();
      expect(said).toContain('ok agropanel_bot\n');
      expect(said).toContain('@agropanel_bot');
      expect(said).toContain('exit=0');
      expect(asked).toEqual([`/bot${TOKEN}/getMe`]);
    });

    it('says a revoked token is revoked, and what to do', async () => {
      answer = json(401, { ok: false, error_code: 401, description: 'Unauthorized' });
      const said = await ask();
      expect(said).toContain('refused 401');
      expect(said).toContain('@BotFather');
      expect(said).toContain('no alert');
      expect(said).toContain('exit=1');
    });

    it('treats a token Telegram cannot even parse the same way', async () => {
      answer = json(404, { ok: false, error_code: 404, description: 'Not Found' });
      expect(await ask()).toContain('refused 404');
    });

    it('says a blocked route is a blocked route when nothing answers', async () => {
      answer = (res) => res.destroy();
      const said = await ask();
      expect(said).toContain('unreachable ');
      expect(said).toContain('route out of the country');
      expect(said).toContain('api.telegram.org');
      expect(said).toContain('exit=1');
    });

    it('says the same when the port is closed', async () => {
      const said = await ask({ TELEGRAM_API: 'http://127.0.0.1:1' });
      expect(said).toContain('unreachable ');
      expect(said).toContain('route out of the country');
    });

    it('does not mistake a filter\'s page for Telegram', async () => {
      answer = (res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html>This site is blocked</html>');
      };
      const said = await ask();
      expect(said).toContain('odd 200');
      expect(said).toContain('filter');
      expect(said).toContain('exit=1');
    });

    it('calls a Telegram outage trouble, not a bad token', async () => {
      answer = json(502, { ok: false });
      const said = await ask();
      expect(said).toContain('odd 502');
      expect(said).not.toContain('@BotFather');
    });
  });

  it('says plainly when the API is not there to ask', async () => {
    writeFileSync(join(root, 'api-down'), '');
    const result = await lib('answer="$(telegram_check_api)"; telegram_words "$answer"; echo "exit=$?"', settings());
    expect(result.stdout).toContain('The API is not running');
    expect(result.stdout).toContain('exit=1');
  });

  it('never lets a program under timeout read the terminal, where it would be stopped and wait for nothing', () => {
    const scripts = readdirSync(INFRA).filter((file) => file.endsWith('.sh'));
    const lines = scripts.flatMap((file) => read(file).split('\n')).filter((line) => /timeout \d+ [^\n]* exec /.test(line));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((line) => !/exec [^\n]*< /.test(line))).toEqual([]);
  });

  it('keeps the token off the command line, in the container and on the server', () => {
    // Anyone on a server can read the process list, and `compose exec -e` would put the token there.
    expect(read('lib.sh')).not.toMatch(/exec[^\n]*-e [^\n]*TOKEN/);
    expect(read('lib.sh')).toMatch(/exec -T api node - < "\$YAP_ROOT\/infra\/telegram-check\.js"/);
    expect(read('lib.sh')).toMatch(/printf 'url = "%s\/bot%s\/getMe"\\n'[^\n]*\|\n\s*curl [^\n]*-K -/);
  });

  it('deploy, status and preflight ask Telegram, and do not settle for reading a log', () => {
    expect(read('deploy.sh')).toMatch(/check_telegram\(\) \{[\s\S]*telegram_check_api[\s\S]*terminated by other getUpdates/);
    expect(read('status.sh')).toMatch(/telegram_words "\$\(telegram_check_api\)"[\s\S]*terminated by other getUpdates/);
    expect(read('preflight.sh')).toContain('telegram_check_here');
    expect(read('deploy.sh')).not.toContain('No conflict: this is the only poller');
  });
});

describe('the watchdog', () => {
  const TOKEN = '123456789:this-token-must-stay-out-of-every-log';
  const count = (file: string) => (existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8').split('\n').filter(Boolean).length : 0);
  const restarts = () => count('restarts');
  const messages = () => (existsSync(join(root, 'messages')) ? readFileSync(join(root, 'messages'), 'utf8') : '');
  const state = () => readFileSync(join(root, 'state', 'watchdog'), 'utf8').trim().split(' ').map(Number);
  const now = () => Math.floor(Date.now() / 1000);

  const healthy = () => writeFileSync(join(root, 'health'), '0');
  /** curl's code for a timeout, which is what a frozen API gives. */
  const failing = () => writeFileSync(join(root, 'health'), '28');

  const tick = (extra: Record<string, string> = {}) => run('bash', [join(INFRA, 'watchdog.sh')], { TELEGRAM_BOT_TOKEN: TOKEN, BACKUP_ALERT_CHAT_ID: '-100123', ...extra });
  async function ticks(times: number) {
    let said = '';
    for (let i = 0; i < times; i += 1) said += (await tick()).stdout;
    return said;
  }

  beforeEach(() => {
    healthy();
    fake(
      'docker',
      `case "$*" in
  "volume inspect"*) [[ ! -e "$FAKE/nothing-deployed" ]] ;;
  *" ps -q api") [[ -e "$FAKE/api-stopped" ]] || echo abc123 ;;
  inspect*) echo 172.20.0.5 ;;
  *" restart api") echo restart >> "$FAKE/restarts"; exit "$(cat "$FAKE/restart-status" 2> /dev/null || echo 0)" ;;
esac`,
    );
    fake(
      'curl',
      `if [[ "$*" == *"-K -"* ]]; then
  cat > /dev/null
  printf '%s\\n' "$*" >> "$FAKE/messages"
  exit 0
fi
printf '%s\\n' "$*" >> "$FAKE/asked"
exit "$(cat "$FAKE/health")"`,
    );
    // A laptop has no flock. The deploy's lock is the only one taken with -s.
    fake('flock', `[[ "$*" != *-s* || ! -e "$FAKE/deploying" ]]`);
  });

  it('asks the API itself, not nginx in front of it', async () => {
    await tick();
    expect(readFileSync(join(root, 'asked'), 'utf8')).toContain('http://172.20.0.5:4000/api/health');
  });

  it('restarts on the third failure in a row, not before, and logs it', async () => {
    failing();
    await ticks(2);
    expect(restarts()).toBe(0);
    const said = (await tick()).stdout;
    expect(restarts()).toBe(1);
    expect(said).toContain('restarting the api service, restart 1 of 3');
    expect(said).toContain('the api service has restarted');
    expect(messages()).toContain('restarted it');
  });

  it('starts counting again after one good answer', async () => {
    failing();
    await ticks(2);
    healthy();
    expect((await tick()).stdout).toContain('the API answers again');
    failing();
    await ticks(2);
    expect(restarts()).toBe(0);
  });

  it('says nothing at all while the API answers', async () => {
    expect(await ticks(3)).toBe('');
    expect(messages()).toBe('');
  });

  it('stops after three restarts that did not cure it, says so once, and then stays quiet', async () => {
    failing();
    const said = await ticks(12);
    expect(restarts()).toBe(3);
    expect(said).toContain('It needs a person');
    expect(messages().match(/text=[^\n]*stopped trying/g)).toHaveLength(1);

    expect(await ticks(20)).toBe('');
    expect(restarts()).toBe(3);
    expect(messages().match(/stopped trying/g)).toHaveLength(1);
  });

  it('does not count an hour of good answers against the next freeze', async () => {
    writeFileSync(join(root, 'state', 'watchdog'), `0 3 ${now() - 3_700} 0\n`);
    await tick();
    failing();
    await ticks(3);
    expect(restarts()).toBe(1);
  });

  it('still counts a restart that lasted minutes, so an API that keeps freezing ends up with a person', async () => {
    writeFileSync(join(root, 'state', 'watchdog'), `0 3 ${now() - 600} 0\n`);
    await tick();
    failing();
    await ticks(3);
    expect(restarts()).toBe(0);
    expect(messages()).toContain('stopped trying');
  });

  it('restarts again once the API has come back and an hour has passed since it gave up', async () => {
    writeFileSync(join(root, 'state', 'watchdog'), `0 3 ${now() - 3_700} 1\n`);
    expect((await tick()).stdout).toContain('the API answers again');
    expect(state().slice(0, 2)).toEqual([0, 0]);
    expect(state()[3]).toBe(0);
  });

  it('leaves alone an API that is not running: Docker looks after a crash, and a restore stops it on purpose', async () => {
    writeFileSync(join(root, 'api-stopped'), '');
    failing();
    await ticks(5);
    expect(restarts()).toBe(0);
    expect(existsSync(join(root, 'asked'))).toBe(false);
  });

  it('leaves the API to a deploy that is replacing it, and does not hold that against it afterwards', async () => {
    writeFileSync(join(root, 'deploying'), '');
    failing();
    await ticks(5);
    expect(restarts()).toBe(0);
    expect(state()[0]).toBe(0);
  });

  it('never takes the deploy lock for a healthy API, so it cannot refuse a deploy', () => {
    const script = read('watchdog.sh');
    expect(script.indexOf('deploy.lock')).toBeGreaterThan(script.indexOf('/api/health" 2> /dev/null'));
  });

  it('does nothing before the first deploy, without a word', async () => {
    writeFileSync(join(root, 'nothing-deployed'), '');
    failing();
    expect(await ticks(4)).toBe('');
    expect(existsSync(join(root, 'state', 'watchdog'))).toBe(false);
  });

  it('counts a restart that failed, so a broken Docker cannot make it try for ever', async () => {
    writeFileSync(join(root, 'restart-status'), '1');
    failing();
    const said = await ticks(12);
    expect(said).toContain('the restart failed');
    expect(restarts()).toBe(3);
    await ticks(6);
    expect(restarts()).toBe(3);
  });

  it('keeps the bot token off the command line', async () => {
    failing();
    await ticks(3);
    expect(messages()).not.toBe('');
    expect(messages()).not.toContain(TOKEN);
  });

  it('is installed by server-setup.sh, once a minute, where its log can be written', () => {
    const setup = read('server-setup.sh');
    expect(setup).toContain('* * * * * root $REPO_ROOT/infra/watchdog.sh >> /var/log/yap/watchdog.log 2>&1');
    expect(setup.lastIndexOf('configure_watchdog')).toBeGreaterThan(setup.lastIndexOf('configure_backups'));
    expect(setup).toContain("install -d -m 755 /var/log/yap /var/lib/yap");
  });

  it('every script cron or a person runs is executable', () => {
    const scripts = readdirSync(INFRA).filter((file) => file.endsWith('.sh') && file !== 'lib.sh');
    expect(scripts.filter((file) => (statSync(join(INFRA, file)).mode & 0o100) === 0)).toEqual([]);
  });
});

describe('the backup key', () => {
  const KEY = 'c0ffee'.repeat(10) + 'abcd';
  let keyFile: string;

  const key = (what: string, input = '', extra: Record<string, string> = {}) => run('bash', [join(INFRA, 'backup-key.sh'), what], { BACKUP_PASSPHRASE_FILE: keyFile, BACKUP_DIR: join(root, 'backups'), ...extra }, input);
  const fingerprint = () => readFileSync(`${keyFile}.fingerprint`, 'utf8').trim();
  const state = () => lib('backup_key_state', { BACKUP_PASSPHRASE_FILE: keyFile }).then((result) => result.stdout.trim());

  function encrypt(passphraseFile: string, text: string) {
    return spawnSync('openssl', ['enc', '-aes-256-cbc', '-pbkdf2', '-salt', '-pass', `file:${passphraseFile}`], { input: text }).stdout;
  }
  function decrypt(passphraseFile: string, sealed: Buffer) {
    return spawnSync('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-pass', `file:${passphraseFile}`], { input: sealed, encoding: 'utf8' });
  }

  beforeEach(() => {
    keyFile = join(root, 'backup.key');
    mkdirSync(join(root, 'backups'));
  });

  describe('when it is created', () => {
    it('shows a short fingerprint, saves it beside the key, and keeps the key off the screen', async () => {
      const made = await key('create');
      const secret = readFileSync(keyFile, 'utf8').trim();
      expect(secret).toMatch(/^[0-9a-f]{64}$/);
      expect(fingerprint()).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
      expect(made.stdout).toContain(fingerprint());
      expect(made.stdout + made.stderr).not.toContain(secret);
      expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    });

    it('is the sha256 of the key, checked by hand', async () => {
      writeFileSync(keyFile, 'abc\n');
      await key('create');
      // sha256("abc") = ba7816bf 8f01cfea ...
      expect(fingerprint()).toBe('ba78-16bf-8f01');
    });

    it('never replaces a key that is there, and gives an older one its fingerprint', async () => {
      writeFileSync(keyFile, `${KEY}\n`);
      const made = await key('create');
      expect(readFileSync(keyFile, 'utf8')).toBe(`${KEY}\n`);
      expect(made.stdout).toContain('left as it is');
      expect(made.stdout).toContain(fingerprint());
    });
  });

  describe('proving the saved copy', () => {
    beforeEach(async () => {
      writeFileSync(keyFile, `${KEY}\n`);
      await key('create');
    });

    it('confirms a right copy without printing it, and remembers that it did', async () => {
      expect(await state()).toBe('unproved');
      const proof = await key('check', `${KEY}\n`);
      expect(proof.status).toBe(0);
      expect(proof.stdout).toContain('It matches');
      expect(proof.stdout + proof.stderr).not.toContain(KEY);
      expect(await state()).toMatch(/^proven \d{4}-\d{2}-\d{2}$/);
    });

    it('forgives the spaces and line endings that come with a paste', async () => {
      expect((await key('check', `  ${KEY} \r\n`)).status).toBe(0);
    });

    it('refuses a copy that lost its last character, and says how, without showing either key', async () => {
      const proof = await key('check', `${KEY.slice(0, -1)}\n`);
      expect(proof.status).toBe(1);
      expect(proof.stderr).toContain('does NOT match');
      expect(proof.stderr).toContain('63 characters');
      expect(proof.stderr).toContain('has 64');
      expect(proof.stdout + proof.stderr).not.toContain(KEY.slice(0, 20));
      expect(await state()).toBe('unproved');
    });

    it('refuses one wrong digit, and capital letters, because openssl would too', async () => {
      expect((await key('check', `${KEY.slice(0, -1)}e\n`)).status).toBe(1);
      expect((await key('check', `${KEY.toUpperCase()}\n`)).status).toBe(1);
    });

    it('proves nothing when nothing is entered', async () => {
      const proof = await key('check', '\n');
      expect(proof.status).toBe(1);
      expect(proof.stderr).toContain('Nothing was entered');
      expect(await state()).toBe('unproved');
    });

    it('does not let a proof of the old key stand for a new one', async () => {
      await key('check', `${KEY}\n`);
      writeFileSync(keyFile, `${'1234'.repeat(16)}\n`);
      expect(await state()).toBe('changed');
      expect((await key('show')).stdout).toContain('has been changed');
      writeFileSync(`${keyFile}.fingerprint`, '');
      expect(await state()).toBe('unproved');
    });

    it('show gives the fingerprint and the state, and never the key', async () => {
      const shown = await key('show');
      expect(shown.stdout).toContain(fingerprint());
      expect(shown.stdout).toContain('Nobody has proved');
      expect(shown.stdout + shown.stderr).not.toContain(KEY);
    });
  });

  describe('on a new server', () => {
    beforeEach(async () => {
      await key('create');
    });

    it('a backup made with the old key opens with the key entered from the saved copy', async () => {
      const oldKey = join(root, 'old.key');
      writeFileSync(oldKey, `${KEY}\n`);
      const sealed = encrypt(oldKey, 'the farm');

      const restored = await key('restore', `${KEY}\n`);

      expect(restored.status).toBe(0);
      expect(restored.stdout + restored.stderr).not.toContain(KEY);
      expect(restored.stdout).toContain(fingerprint());
      expect(decrypt(keyFile, sealed).stdout).toBe('the farm');
      expect(statSync(keyFile).mode & 0o777).toBe(0o600);
      expect(await state()).toBe('unproved');
    });

    it('gives the fingerprint the old server gave, so a mistyped key shows before any restore', async () => {
      writeFileSync(join(root, 'other.key'), `${KEY}\n`);
      const original = (await run('bash', [join(INFRA, 'backup-key.sh'), 'show'], { BACKUP_PASSPHRASE_FILE: join(root, 'other.key') })).stdout;
      await key('restore', `${KEY}\n`);
      expect(original).toContain(fingerprint());
      await key('restore', `${KEY.slice(0, -1)}0\n`);
      expect(original).not.toContain(fingerprint());
    });

    it('refuses a key too short to be one, and changes nothing', async () => {
      const before = readFileSync(keyFile, 'utf8');
      const restored = await key('restore', 'c0ffee\n');
      expect(restored.status).toBe(1);
      expect(restored.stderr).toContain('6 characters');
      expect(readFileSync(keyFile, 'utf8')).toBe(before);
    });

    it('will not swap the key under existing backups without being told to', async () => {
      const before = readFileSync(keyFile, 'utf8');
      writeFileSync(join(root, 'backups', 'yap-db-20261105T000000Z.dump.enc'), 'x');
      const refused = await key('restore', `${KEY}\n`);
      expect(refused.status).toBe(2);
      expect(readFileSync(keyFile, 'utf8')).toBe(before);
      expect((await key('restore', `${KEY}\n`, { RESTORE_CONFIRM: 'yes' })).status).toBe(0);
      expect(readFileSync(keyFile, 'utf8')).toBe(`${KEY}\n`);
    });
  });

  it('server-setup.sh makes the key through it, and tells the owner to prove the copy', () => {
    const setup = read('server-setup.sh');
    expect(setup).toContain('infra/backup-key.sh" create');
    expect(setup).not.toContain('openssl rand -hex 32 > /etc/yap/backup.key');
    expect(setup).toContain('infra/backup-key.sh check');
  });
});

describe('the runbook', () => {
  const runbook = readFileSync(join(INFRA, '../docs/deployment.md'), 'utf8');
  const readme = readFileSync(join(INFRA, '../README.md'), 'utf8');

  it('names every script a person or cron runs, and so does the README', () => {
    const scripts = readdirSync(INFRA).filter((file) => file.endsWith('.sh') && file !== 'lib.sh');
    expect(scripts.filter((file) => !runbook.includes(`infra/${file}`) && !runbook.includes(file))).toEqual([]);
    expect(scripts.filter((file) => !readme.includes(`infra/${file}`))).toEqual([]);
  });

  it('explains every setting that env.production.example offers', () => {
    const offered = [...read('env.production.example').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);
    // One line of the table covers these: `STORAGE_DRIVER=s3` with `S3_*`.
    const covered = offered.filter((name) => !name.startsWith('S3_'));
    expect(covered.filter((name) => !runbook.includes(name))).toEqual([]);
  });

  it('explains every setting the backup scripts read, with the default they really use', () => {
    const scripts = ['backup.sh', 'backup-prune.sh', 'backup-cron.sh', 'restore.sh'].map(read).join('\n');
    const read_ = [...scripts.matchAll(/setting ((?:BACKUP|RETENTION|FILES)_[A-Z_]+)/g)].map((m) => m[1]!);
    expect([...new Set(read_)].filter((name) => !runbook.includes(name))).toEqual([]);
    const defaults = /Defaults: (\d+), (\d+), (\d+), (\d+) and (\d+)/.exec(runbook)!.slice(1);
    const prune = read('backup-prune.sh');
    const inScript = ['RETENTION_KEEP_LAST', 'RETENTION_DAILY', 'RETENTION_WEEKLY', 'RETENTION_MONTHLY', 'RETENTION_FILE_SETS'].map((name) => new RegExp(`setting ${name} (\\d+)`).exec(prune)![1]);
    expect(defaults).toEqual(inScript);
  });

  it('restores files from the folder: one archive of a set holds only part of them', () => {
    expect(runbook).not.toMatch(/restore\.sh files \S*yap-files-/);
    expect(runbook).toContain('infra/restore.sh files /var/backups/yap\n');
  });

  it('prunes the backup machine by the same rules, not by age', () => {
    expect(runbook).not.toMatch(/-mtime/);
    expect(runbook).toContain('install -m 755 /srv/yap-backups/yap-backup-prune.sh /usr/local/bin/yap-backup-prune.sh');
    expect(read('backup-cron.sh')).toContain('"$backup_dir/yap-backup-prune.sh"');
  });

  it('never has a machine run the copy the main server can overwrite, or a break-in there reaches the backups', () => {
    const commands = runbook.split('\n').filter((line) => /^\s*(bash |\d+ \d+ \* \* \* )/.test(line) && line.includes('yap-backup-prune.sh'));
    expect(commands.length).toBeGreaterThanOrEqual(2);
    expect(commands.filter((line) => /(srv\/yap-backups|~\/yap-backups)\/yap-backup-prune\.sh/.test(line))).toEqual([]);
  });

  it('gives the rsync filters in the order that keeps a half-written file out', () => {
    const line = /rsync -rt -e 'ssh -i ~\/\.ssh\/yap_backup' [^\n]*/.exec(runbook)![0];
    expect(line.indexOf("--exclude='*.tmp'")).toBeLessThan(line.indexOf("--include='yap-*'"));
  });

  it('never lets a paper copy of the key go unproved', () => {
    const paper = runbook.split('\n').filter((line) => /paper/.test(line) && /key/.test(line));
    expect(paper.length).toBeGreaterThan(0);
    expect(runbook).toContain('paper will do only if this check has accepted the key');
    expect(runbook).toContain('### 5. Save the backup key');
    const dayOne = runbook.slice(runbook.indexOf('## Check on day one'), runbook.indexOf('## Everyday work'));
    expect(dayOne).toContain('infra/backup-key.sh check');
    const rebuild = runbook.slice(runbook.indexOf('### The server is gone'), runbook.indexOf('## Settings'));
    expect(rebuild).toContain('infra/backup-key.sh restore');
    expect(rebuild).not.toContain('nano /etc/yap/backup.key');
  });

  it('says there is no fire detection, near the top, and in a demo', () => {
    const top = runbook.slice(0, runbook.indexOf('## Before you start'));
    expect(top).toContain('The platform has no fire detection until a detector is connected.');
    expect(top).toContain('fire warning');
  });

  it('stops the laptop first on the demo path, and keeps the demo data command that was proved', () => {
    const demo = runbook.slice(runbook.indexOf('## First deploy for a demo'), runbook.indexOf('## Before you start'));
    expect(demo.indexOf('Stop the laptop')).toBeLessThan(demo.indexOf('infra/deploy.sh'));
    expect(demo.indexOf('infra/deploy.sh')).toBeLessThan(demo.indexOf('Demo data on a server'));
    expect(runbook).toContain(`docker compose -f docker-compose.prod.yml --env-file .env.production run --rm --no-deps \\
  -e NODE_ENV=development \\
  -e SEED_PASSWORD='your-own-long-password' \\
  -e DATABASE_OWNER_URL="postgres://yap:$(grep '^POSTGRES_PASSWORD=' .env.production | cut -d= -f2)@db:5432/yap" \\
  api tsx src/seed/index.ts`);
    expect(runbook).toContain('sslip.io');
  });

  it('links only to headings that exist', () => {
    const slug = (heading: string) => heading.toLowerCase().replace(/[^\p{L}\p{N} -]/gu, '').replaceAll(' ', '-');
    const headings = [...runbook.matchAll(/^#{1,4} (.+)$/gm)].map((m) => slug(m[1]!));
    const links = [...new Set([...runbook.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]!))];
    expect(links.filter((link) => !headings.includes(link))).toEqual([]);
  });

  it('gives the admin reset command, and the health and alert addresses the code has', () => {
    expect(runbook).toContain('run --rm --no-deps migrate tsx src/db/reset-admin.ts');
    expect(runbook).toContain('`/api/health/deep`');
    expect(runbook).toContain('POST /api/v1/alerts/test');
    expect(readFileSync(join(INFRA, '../apps/api/src/app.ts'), 'utf8')).toContain("'/api/health/deep'");
    expect(readFileSync(join(INFRA, '../apps/api/src/modules/alerts/index.ts'), 'utf8')).toContain("r.post('/test'");
  });
});
