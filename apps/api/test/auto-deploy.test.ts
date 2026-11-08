import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * infra/auto-deploy.sh, run for real against git repositories in a temporary folder: a bare one stands in
 * for GitHub, and a clone of it for the server's checkout. infra/deploy.sh, GitHub's API, Telegram and the
 * lock are small fakes, steered by files the test writes.
 */
const REPO = resolve(__dirname, '../../..');
const TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOG = '/var/log/yap/deploy-20261107T101500Z.log';

let root: string;
let bin: string;
let dev: string;
let server: string;

const at = (...parts: string[]) => join(root, ...parts);
const lines = (file: string) => (existsSync(at(file)) ? readFileSync(at(file), 'utf8').split('\n').filter(Boolean) : []);

function env(extra: Record<string, string> = {}) {
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE: root,
    ENV_FILE: at('env'),
    YAP_STATE_DIR: at('state'),
    YAP_LOG_DIR: at('log'),
    YAP_AUTO_DEPLOY_CRON: at('cron', 'yap-auto-deploy'),
    AUTO_DEPLOY_REPO: 'farm/yap',
    TELEGRAM_BOT_TOKEN: TOKEN,
    BACKUP_ALERT_CHAT_ID: '42',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    ...extra,
  };
}

function git(dir: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', dir, ...args], { env: env(), encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function script(name: string, body: string) {
  writeFileSync(name, `#!/bin/bash\n${body}\n`);
  chmodSync(name, 0o755);
}

/** One look, or any other command, as cron or a person runs it. */
function auto(args: string[] = ['run'], extra: Record<string, string> = {}) {
  const { status, stdout, stderr } = spawnSync('bash', [join(server, 'infra', 'auto-deploy.sh'), ...args], {
    env: env(extra),
    encoding: 'utf8',
  });
  return { status, said: `${stdout}${stderr}` };
}

/** A new commit on main, pushed to the stand-in for GitHub. */
function push(message: string) {
  writeFileSync(join(dev, 'notes.txt'), `${message}\n`, { flag: 'a' });
  git(dev, 'commit', '-qam', message);
  git(dev, 'push', '-q', 'origin', 'main');
  return git(dev, 'rev-parse', 'HEAD');
}

/** What GitHub's API answers for the check runs of any commit, oldest run first. */
function checks(...runs: [status: string, conclusion: string | null][]) {
  const checkRuns = runs.map(([status, conclusion], i) => ({ id: i + 1, name: 'tests', status, conclusion }));
  writeFileSync(at('check-runs'), JSON.stringify({ total_count: checkRuns.length, check_runs: checkRuns }));
}

const passed = () => checks(['completed', 'success']);
const deployExits = (code: number) => writeFileSync(at('deploy-exit'), String(code));
const head = () => git(server, 'rev-parse', 'HEAD');
const state = () => Object.fromEntries(lines('state/auto-deploy').map((line) => [line.split('=')[0], line.slice(line.indexOf('=') + 1)]));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'yap-auto-'));
  bin = at('bin');
  dev = at('dev');
  server = at('server');
  for (const dir of [bin, at('state'), at('log'), at('cron')]) mkdirSync(dir);
  writeFileSync(at('env'), 'DOMAIN=farm.test\n');

  script(
    join(bin, 'curl'),
    `printf '%s\\n' "$*" >> "$FAKE/curl-args"
if [[ " $* " == *" --data-urlencode "* ]]; then
  for arg; do [[ "$arg" != text=* ]] || printf '%s\\n' "\${arg#text=}" >> "$FAKE/telegram"; done
  cat > /dev/null
  exit 0
fi
printf '%s\\n' "\${*: -1}" >> "$FAKE/asked"
[[ ! -e "$FAKE/github-down" ]] || exit 7
cat "$FAKE/check-runs" 2> /dev/null || printf '{"total_count":0,"check_runs":[]}'`,
  );
  // A laptop has no flock. The deploy lock is busy while the test says a backup runs.
  script(join(bin, 'flock'), `[[ "$*" != *deploy.lock* || ! -e "$FAKE/busy" ]]`);

  git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(root, 'clone', '-q', 'origin.git', 'dev');
  mkdirSync(join(dev, 'infra'));
  copyFileSync(join(REPO, 'infra', 'lib.sh'), join(dev, 'infra', 'lib.sh'));
  copyFileSync(join(REPO, 'infra', 'auto-deploy.sh'), join(dev, 'infra', 'auto-deploy.sh'));
  script(
    join(dev, 'infra', 'deploy.sh'),
    `# Stands in for infra/deploy.sh: does what the test asks, and remembers what was checked out.
here="$(cd "$(dirname "$0")/.." && pwd)"
git -C "$here" rev-parse HEAD >> "$FAKE/deployed"
{ true >&8; } 2> /dev/null && touch "$FAKE/lock-leaked"
code="$(cat "$FAKE/deploy-exit" 2> /dev/null || echo 0)"
echo "==> Preflight"
case "$code" in
  0) printf 'commit=%s\\ndeployed_at=now\\n' "$(git -C "$here" rev-parse --short HEAD)" > "$YAP_STATE_DIR/last-deploy"
     echo "Full log: ${LOG}" ;;
  1) echo "DEPLOY FAILED: the smoke check failed: the app answered 502 instead of its page"
     echo "Full log: ${LOG}" ;;
  2) if [[ -e "$FAKE/deploy-busy" ]]; then
       echo "Another deploy or a backup is running. Wait for it to finish, then run this again."
     else
       echo "  FAIL  Only 3 GB free for Docker in /var/lib/docker, and it needs 15 GB."
       echo "Deploy refused. Nothing was changed. Log: ${LOG}"
     fi ;;
  3) echo "DEPLOY FAILED: these services did not become healthy: api=unhealthy"
     echo "THE ROLLBACK FAILED TOO: the API did not start"
     echo "Full log: ${LOG}" ;;
esac
exit "$code"`,
  );
  script(
    join(dev, 'infra', 'preflight.sh'),
    `[[ ! -e "$FAKE/preflight-fails" ]] && { echo "Preflight passed with 0 warning(s)."; exit 0; }
echo "  FAIL  This server has 1900 MB of memory, and the stack needs at least 3500 MB."
exit 1`,
  );
  writeFileSync(join(dev, 'notes.txt'), 'first\n');
  git(dev, 'add', '-A');
  git(dev, 'commit', '-qm', 'first');
  git(dev, 'push', '-q', 'origin', 'main');
  git(root, 'clone', '-q', 'origin.git', 'server');

  // The first commit is live, deployed by hand, and the timer is installed.
  writeFileSync(at('state', 'last-deploy'), `commit=${git(server, 'rev-parse', '--short', 'HEAD')}\ndeployed_at=then\n`);
  writeFileSync(at('cron', 'yap-auto-deploy'), '*/5 * * * * root auto-deploy.sh run\n');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('an automatic deploy', () => {
  it('waits for the tests, deploys the newest commit once they pass, and only once', () => {
    const first = head();
    const tip = push('second');
    checks(['in_progress', null]);

    expect(auto().said).toMatch(/goes live once its tests pass on GitHub/);
    expect(lines('deployed')).toEqual([]);
    expect(auto().said).toBe('');

    passed();
    const deployed = auto().said;

    expect(deployed).toContain(`Deploying ${tip.slice(0, 7)} from main, over ${first.slice(0, 7)}: second`);
    expect(lines('deployed')).toEqual([tip]);
    expect(head()).toBe(tip);
    expect(git(server, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(lines('telegram')).toEqual([`YAP deploy on ${spawnSync('hostname', { encoding: 'utf8' }).stdout.trim()}: ${tip.slice(0, 7)} is live: second`]);
    expect(state()).toMatchObject({ commit: tip, outcome: 'live' });

    expect(auto().said).toBe('');
    expect(lines('deployed')).toEqual([tip]);
    expect(lines('telegram')).toHaveLength(1);
  });

  it('checks the code out readable by everyone, as the images run it as a non-root user', () => {
    // On 2026-11-08 a checkout under the script's umask 027 left apps/api/package.json readable by root
    // alone, and the migration in the API image could not open it.
    mkdirSync(join(dev, 'apps', 'api'), { recursive: true });
    writeFileSync(join(dev, 'apps', 'api', 'package.json'), '{}\n');
    git(dev, 'add', '-A');
    git(dev, 'commit', '-qm', 'a new folder');
    git(dev, 'push', '-q', 'origin', 'main');
    passed();

    auto();

    expect(statSync(join(server, 'apps', 'api', 'package.json')).mode & 0o777).toBe(0o644);
    expect(statSync(join(server, 'apps', 'api')).mode & 0o777).toBe(0o755);
  });

  it('asks GitHub for the check named in the workflow, on that very commit', () => {
    const tip = push('second');
    passed();
    auto();

    expect(lines('asked')).toEqual([`https://api.github.com/repos/farm/yap/commits/${tip}/check-runs?check_name=tests&filter=latest`]);
    // The job the server waits for is the one CI runs.
    expect(readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8')).toMatch(/^jobs:\n {2}tests:\n/m);
    expect(readFileSync(join(REPO, 'infra', 'auto-deploy.sh'), 'utf8')).toContain('setting AUTO_DEPLOY_CHECK tests');
  });

  it('deploys only the newest of several pushes', () => {
    push('second');
    const tip = push('third');
    passed();
    auto();

    expect(lines('deployed')).toEqual([tip]);
  });

  it('judges a commit by its latest run, so a re-run that passes counts', () => {
    const tip = push('second');
    checks(['completed', 'failure'], ['completed', 'success']);
    auto();

    expect(lines('deployed')).toEqual([tip]);
  });

  it('never deploys a commit whose tests failed, says so once, and deploys it once a re-run passes', () => {
    const tip = push('second');
    checks(['completed', 'failure']);

    expect(auto().said).toContain(`Not deploying ${tip.slice(0, 7)}: its tests on GitHub ended in failure`);
    auto();
    expect(lines('telegram')).toHaveLength(1);
    expect(lines('deployed')).toEqual([]);

    passed();
    auto();
    expect(lines('deployed')).toEqual([tip]);
  });

  it('leaves alone a commit that is live, or older than what is live, without asking GitHub', () => {
    const second = push('second');
    const third = push('third');
    // Deployed by hand from here, and then main was moved back.
    git(server, 'fetch', '-q');
    writeFileSync(at('state', 'last-deploy'), `commit=${third.slice(0, 7)}\n`);
    git(dev, 'reset', '-q', '--hard', second);
    git(dev, 'push', '-q', '-f', 'origin', 'main');
    passed();

    expect(auto().said).toContain(`${second.slice(0, 7)}, the newest on main, is live.`);
    expect(lines('deployed')).toEqual([]);
    expect(lines('asked')).toEqual([]);
  });

  it('keeps a rollback by hand until the next push', () => {
    const tip = push('second');
    passed();
    auto();
    // infra/deploy.sh --rollback names the commit it went back to.
    writeFileSync(at('state', 'last-deploy'), `commit=unknown\nrolled_back_at=now\n`);

    auto();
    expect(lines('deployed')).toEqual([tip]);

    const next = push('third');
    auto();
    expect(lines('deployed')).toEqual([tip, next]);
  });

  it('keeps its own lock out of the deploy, so nothing the deploy starts can hold it', () => {
    push('second');
    passed();
    auto();

    expect(lines('deployed')).toHaveLength(1);
    expect(existsSync(at('lock-leaked'))).toBe(false);
  });
});

describe('when a deploy fails', () => {
  it('puts the checkout back on what runs, says why with the log, and does not try again by itself', () => {
    const first = head();
    const tip = push('second');
    passed();
    deployExits(1);

    auto();
    expect(head()).toBe(first);
    expect(lines('telegram').at(-1)).toContain(
      `The deploy of ${tip.slice(0, 7)} failed: the smoke check failed: the app answered 502 instead of its page. The site runs ${first.slice(0, 7)}, as before. Log: ${LOG}`,
    );
    expect(state()).toMatchObject({ commit: tip, outcome: 'deploy-failed' });

    deployExits(0);
    expect(auto().said).toBe('');
    expect(lines('deployed')).toEqual([tip]);
  });

  it('tries it again on retry', () => {
    const tip = push('second');
    passed();
    deployExits(1);
    auto();
    deployExits(0);

    const retried = auto(['retry']);
    expect(lines('deployed')).toEqual([tip, tip]);
    expect(retried.said).toContain(`Its newest commit, ${tip.slice(0, 7)}, is live.`);
    expect(retried.status).toBe(0);
  });

  it('gives the next push its own try', () => {
    push('second');
    passed();
    deployExits(1);
    auto();
    deployExits(0);
    const fix = push('third');

    auto();
    expect(lines('deployed').at(-1)).toBe(fix);
    expect(head()).toBe(fix);
  });

  it('says why when preflight refused, and waits for retry', () => {
    const first = head();
    const tip = push('second');
    passed();
    deployExits(2);

    auto();
    expect(head()).toBe(first);
    expect(lines('telegram').at(-1)).toContain(
      `Did not deploy ${tip.slice(0, 7)}: Only 3 GB free for Docker in /var/lib/docker, and it needs 15 GB. Nothing was changed`,
    );
    auto();
    expect(lines('deployed')).toEqual([tip]);
  });

  it('tries again at the next look when a backup took the deploy lock first, without a word to Telegram', () => {
    const first = head();
    const tip = push('second');
    passed();
    deployExits(2);
    writeFileSync(at('deploy-busy'), '');

    auto();
    expect(head()).toBe(first);
    expect(lines('telegram')).toEqual([]);

    deployExits(0);
    auto();
    expect(lines('deployed')).toEqual([tip, tip]);
    expect(head()).toBe(tip);
  });

  it('pauses itself when going back failed too, and leaves the checkout for a person', () => {
    const tip = push('second');
    passed();
    deployExits(3);

    auto();
    expect(head()).toBe(tip);
    expect(lines('telegram').at(-1)).toMatch(/^YAP deploy on .*: THE SITE IS PROBABLY DOWN\. The deploy of \w{7} failed \(these services did not become healthy: api=unhealthy\)/);
    expect(existsSync(at('state', 'auto-deploy.paused'))).toBe(true);

    deployExits(0);
    push('third');
    auto();
    expect(lines('deployed')).toEqual([tip]);
    expect(auto(['retry']).said).toMatch(/paused.*Run infra\/auto-deploy\.sh resume first/);
  });

  it('reports a deploy that stopped halfway, and does not start it again', () => {
    const tip = push('second');
    passed();
    writeFileSync(at('state', 'auto-deploy'), `commit=${tip}\noutcome=deploying\nsince=0\nnote=\n`);

    expect(auto().said).toContain(`The deploy of ${tip.slice(0, 7)} stopped halfway`);
    auto();
    expect(lines('deployed')).toEqual([]);
    expect(lines('telegram')).toHaveLength(1);
  });
});

describe('what it waits for', () => {
  it('waits while a backup holds the deploy lock, and deploys at the next look', () => {
    const tip = push('second');
    passed();
    writeFileSync(at('busy'), '');

    expect(auto().said).toBe('');
    expect(lines('deployed')).toEqual([]);

    rmSync(at('busy'));
    auto();
    expect(lines('deployed')).toEqual([tip]);
  });

  it('never deploys over files changed by hand, says so once, and deploys once they are undone', () => {
    const tip = push('second');
    passed();
    writeFileSync(join(server, 'infra', 'deploy.sh'), '#!/bin/bash\necho edited on the server\n');

    expect(auto().said).toContain('someone changed these by hand');
    auto();
    expect(lines('telegram')).toHaveLength(1);
    expect(lines('deployed')).toEqual([]);

    git(server, 'checkout', '--', 'infra/deploy.sh');
    auto();
    expect(lines('deployed')).toEqual([tip]);
  });

  it('never deploys over a commit made on the server', () => {
    push('second');
    passed();
    writeFileSync(join(server, 'notes.txt'), 'fixed here\n');
    git(server, 'commit', '-qam', 'a fix made on the server');

    expect(auto().said).toContain('a fix made on the server');
    expect(lines('deployed')).toEqual([]);
  });

  it('does nothing while paused, and goes on after resume', () => {
    const tip = push('second');
    passed();
    auto(['pause']);

    expect(auto().said).toBe('');
    expect(lines('deployed')).toEqual([]);

    auto(['resume']);
    auto();
    expect(lines('deployed')).toEqual([tip]);
  });

  it('says nothing while GitHub cannot be reached, and remembers when it last could', () => {
    git(server, 'remote', 'set-url', 'origin', at('nowhere.git'));
    push('second');
    passed();

    expect(auto().said).toBe('');
    expect(existsSync(at('state', 'auto-deploy.looked'))).toBe(false);

    writeFileSync(at('state', 'auto-deploy.looked'), String(Math.floor(Date.now() / 1000) - 3 * 3600));
    const status = auto(['status']);
    expect(status.said).toContain('LOOK  It has not reached GitHub for 3 hour(s)');
    expect(status.status).toBe(1);
  });

  it('waits when the API cannot be reached, and deploys once it answers', () => {
    const tip = push('second');
    passed();
    writeFileSync(at('github-down'), '');

    auto();
    expect(lines('deployed')).toEqual([]);
    expect(state()).toMatchObject({ commit: tip, outcome: 'waiting', note: 'unreachable' });

    rmSync(at('github-down'));
    auto();
    expect(lines('deployed')).toEqual([tip]);
  });

  it('keeps the bot token off the command line', () => {
    push('second');
    passed();
    auto();

    expect(lines('telegram')).toHaveLength(1);
    expect(lines('curl-args').join('\n')).not.toContain(TOKEN);
  });
});

describe('turning it on', () => {
  beforeEach(() => rmSync(at('cron', 'yap-auto-deploy')));

  it('refuses an origin that is not on GitHub, and says how to point it there', () => {
    const { status, said } = auto(['install'], { AUTO_DEPLOY_REPO: '' });

    expect(status).toBe(2);
    expect(said).toContain('which is not on GitHub');
    expect(said).toContain('remote set-url origin https://github.com/');
    expect(existsSync(at('cron', 'yap-auto-deploy'))).toBe(false);
  });

  it('refuses when preflight refuses, since every deploy would be refused too', () => {
    writeFileSync(at('preflight-fails'), '');
    const { status, said } = auto(['install']);

    expect(status).toBe(2);
    expect(said).toContain('FAIL  This server has 1900 MB of memory');
    expect(said).toContain('put MIN_RAM_MB in');
    expect(existsSync(at('cron', 'yap-auto-deploy'))).toBe(false);
  });

  it('refuses over files changed by hand', () => {
    writeFileSync(join(server, 'notes.txt'), 'edited\n');
    const { status, said } = auto(['install']);

    expect(status).toBe(2);
    expect(said).toContain(' M notes.txt');
    expect(existsSync(at('cron', 'yap-auto-deploy'))).toBe(false);
  });

  it('runs a look every five minutes as root, into its log, and says what happens next', () => {
    const tip = push('second');
    passed();
    const { status, said } = auto(['install']);

    expect(status).toBe(0);
    expect(readFileSync(at('cron', 'yap-auto-deploy'), 'utf8')).toContain(
      `*/5 * * * * root ${server}/infra/auto-deploy.sh run >> ${at('log')}/auto-deploy.log 2>&1`,
    );
    expect(said).toContain(`The newest commit on main, ${tip.slice(0, 7)}, passed its tests and is not live: it deploys within 5 minutes.`);
    expect(lines('deployed')).toEqual([]);
    expect(auto(['status']).said).toContain('ok    On for main');
  });

  it('says so when it is off, and that is not a problem', () => {
    rmSync(at('cron'), { recursive: true });
    const { status, said } = auto(['status']);

    expect(status).toBe(0);
    expect(said).toContain('ok    Off. Updates go live by hand');
  });

  it('is shown by status.sh, which counts what it asks to look at', () => {
    const statusScript = readFileSync(join(REPO, 'infra', 'status.sh'), 'utf8');
    expect(statusScript).toContain('"$YAP_ROOT/infra/auto-deploy.sh" status');
  });

  it('reads the GitHub repository from the usual ways of writing its address', () => {
    const of = (url: string) =>
      spawnSync('bash', ['-c', `source '${join(REPO, 'infra', 'auto-deploy.sh')}'; github_repo_of '${url}'`], { env: env(), encoding: 'utf8' }).stdout;

    expect(of('https://github.com/khurshidnm/yuksalish-agro.git')).toBe('khurshidnm/yuksalish-agro');
    expect(of('https://github.com/khurshidnm/yuksalish-agro')).toBe('khurshidnm/yuksalish-agro');
    expect(of('git@github.com:khurshidnm/yuksalish-agro.git')).toBe('khurshidnm/yuksalish-agro');
    expect(of('ssh://git@github.com/khurshidnm/yuksalish-agro.git')).toBe('khurshidnm/yuksalish-agro');
    expect(of('/root/yap.bundle')).toBe('');
    expect(of('https://gitlab.com/khurshidnm/yuksalish-agro.git')).toBe('');
  });
});
