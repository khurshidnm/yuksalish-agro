import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The rules of infra/backup.sh and infra/backup-prune.sh, run for real against a folder. Only Docker is
 * replaced: fake bin/docker stands in for the containers, so openssl, tar and the scripts themselves all run.
 */
const INFRA = resolve(__dirname, '../../../infra');

const STAMP = (day: string, time = '000000') => `${day}T${time}Z`;

let root: string;
let folder: string;
let store: string;

function touch(...names: string[]) {
  for (const name of names) writeFileSync(join(folder, name), 'x');
}

function dump(stamp: string) {
  const name = `yap-db-${stamp}.dump.enc`;
  touch(name, `${name}.sha256`);
  return name;
}

function config(stamp: string) {
  const name = `yap-config-${stamp}.env.enc`;
  touch(name, `${name}.sha256`);
  return name;
}

function files(stamp: string, kind: 'full' | 'changes') {
  const name = `yap-files-${stamp}-${kind}.tar.gz.enc`;
  touch(name, `${name}.sha256`);
  return name;
}

function ls(pattern = /^yap-.*\.enc$/) {
  return readdirSync(folder)
    .filter((name) => pattern.test(name))
    .sort();
}

function prune(env: Record<string, string> = {}, ...types: string[]) {
  return spawnSync('bash', [join(INFRA, 'backup-prune.sh'), folder, ...types], {
    // ENV_FILE points nowhere, so a developer's own .env.production cannot decide a test.
    env: { ...process.env, ENV_FILE: join(root, 'no-such-env'), ...env },
    encoding: 'utf8',
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'yap-backup-'));
  folder = join(root, 'backups');
  store = join(root, 'store');
  mkdirSync(folder);
  mkdirSync(join(store, 'tenant'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('retention of dumps', () => {
  it('keeps the newest, then one per day, week and month, checked by hand', () => {
    // 2026-11-02 is a Monday, and 2026-11-01 a Sunday.
    const newest = dump(STAMP('20261105', '120000'));
    const sameDay = dump(STAMP('20261105', '060000'));
    const yesterday = dump(STAMP('20261104', '180000'));
    const yesterdayEarlier = dump(STAMP('20261104', '120000'));
    const monday = dump(STAMP('20261102', '000000'));
    const sunday = dump(STAMP('20261101', '180000'));
    const sundayEarlier = dump(STAMP('20261101', '120000'));
    const october = dump(STAMP('20261015', '000000'));
    const september = dump(STAMP('20260920', '000000'));

    const result = prune({ RETENTION_KEEP_LAST: '2', RETENTION_DAILY: '2', RETENTION_WEEKLY: '2', RETENTION_MONTHLY: '3' });

    expect(result.status).toBe(0);
    // Last 2: 05 at 12:00 and 06:00. Days: 05, 04. Weeks: the one of 05, the one ending 01.
    // Months: 11, 10, 09.
    expect(ls()).toEqual(
      [newest, sameDay, yesterday, sunday, october, september].sort(),
    );
    expect(ls()).not.toContain(yesterdayEarlier);
    expect(ls()).not.toContain(monday);
    expect(ls()).not.toContain(sundayEarlier);
    expect(existsSync(join(folder, `${monday}.sha256`))).toBe(false);
  });

  it('holds under 50 dumps after a year of four a day, with no gap over a week across the 90 days of the spec', () => {
    const day = (offset: number) => new Date(Date.UTC(2025, 10, 6 + offset));
    for (let offset = 0; offset < 365; offset += 1) {
      const date = day(offset).toISOString().slice(0, 10).replaceAll('-', '');
      for (const time of ['000000', '060000', '120000', '180000']) dump(STAMP(date, time));
    }

    expect(prune().status).toBe(0);

    const kept = ls();
    expect(kept.length).toBeLessThan(50);
    expect(kept[kept.length - 1]).toContain('20261105T180000Z');

    const times = kept.map((name) => {
      const stamp = name.slice('yap-db-'.length);
      return Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8));
    });
    const DAY = 86_400_000;
    const newest = times[times.length - 1]!;
    const weekly = times.filter((time) => newest - time <= 100 * DAY);
    expect((newest - weekly[0]!) / DAY).toBeGreaterThanOrEqual(90);
    for (let i = 1; i < weekly.length; i += 1) {
      expect((weekly[i]! - weekly[i - 1]!) / DAY).toBeLessThanOrEqual(7);
    }
    // The monthly ones go on for the rest of the year.
    expect(kept[0]!.slice('yap-db-'.length, 'yap-db-'.length + 6)).toBe('202512');
  });

  it('removes nothing more when backups have stopped, however old they get', () => {
    const old = [dump(STAMP('20240101')), dump(STAMP('20240102')), dump(STAMP('20240103'))];
    prune();
    prune();
    expect(ls()).toEqual(old);
  });

  it('never lets one type push out another: a healthy files backup leaves failing dumps alone', () => {
    const dumps = [dump(STAMP('20260801')), dump(STAMP('20260805')), dump(STAMP('20260809'))];
    for (let day = 1; day <= 30; day += 1) {
      files(STAMP(`202611${String(day).padStart(2, '0')}`), day % 10 === 1 ? 'full' : 'changes');
    }

    prune({}, 'files');

    expect(ls(/^yap-db-/).filter((name) => name.endsWith('.enc'))).toEqual(dumps);
  });

  it('keeps the newest dump that a restore proved, when every later one would push it out', () => {
    const proven = dump(STAMP('20260101'));
    touch(`${proven}.proven`);
    for (let day = 10; day < 30; day += 1) dump(STAMP(`202611${day}`));

    prune({ RETENTION_KEEP_LAST: '1', RETENTION_DAILY: '1', RETENTION_WEEKLY: '1', RETENTION_MONTHLY: '1' });

    expect(ls()).toEqual([proven, `yap-db-${STAMP('20261129')}.dump.enc`]);
  });

  it('handles settings the same on config backups', () => {
    const kept = config(STAMP('20261105'));
    const dropped = config(STAMP('20261104'));

    prune({ RETENTION_KEEP_LAST: '1', RETENTION_DAILY: '0', RETENTION_WEEKLY: '0', RETENTION_MONTHLY: '0' });

    expect(ls()).toEqual([kept]);
    expect(ls()).not.toContain(dropped);
  });

  it('refuses a setting that would keep nothing, and removes nothing', () => {
    const names = [dump(STAMP('20261101')), dump(STAMP('20261102'))];
    for (const [key, value] of [
      ['RETENTION_KEEP_LAST', '0'],
      ['RETENTION_FILE_SETS', '0'],
      ['RETENTION_DAILY', 'many'],
    ] as const) {
      const result = prune({ RETENTION_KEEP_LAST: '1', RETENTION_DAILY: '0', RETENTION_WEEKLY: '0', RETENTION_MONTHLY: '0', [key]: value });
      expect(result.status).toBe(2);
      expect(ls()).toEqual(names);
    }
  });

  it('leaves alone what it does not recognise', () => {
    touch('yap-files-20200101T000000Z.tar.gz.enc', 'notes.txt', 'yap-db-unknown.dump.enc');
    prune({ RETENTION_KEEP_LAST: '1', RETENTION_DAILY: '0', RETENTION_WEEKLY: '0', RETENTION_MONTHLY: '0' });
    expect(readdirSync(folder).sort()).toEqual(['notes.txt', 'yap-db-unknown.dump.enc', 'yap-files-20200101T000000Z.tar.gz.enc']);
  });
});

describe('retention of files', () => {
  it('removes a set only as a whole, and only when two newer sets exist', () => {
    const oldFull = files(STAMP('20260101'), 'full');
    const oldChanges = files(STAMP('20260102'), 'changes');
    const middleFull = files(STAMP('20260401'), 'full');
    const middleChanges = files(STAMP('20260402'), 'changes');
    const newFull = files(STAMP('20260701'), 'full');
    const newChanges = files(STAMP('20260702'), 'changes');
    touch(`files-manifest-${STAMP('20260101')}`, `files-manifest-${STAMP('20260701')}`);

    prune({}, 'files');

    expect(ls()).toEqual([middleFull, middleChanges, newFull, newChanges]);
    expect(ls()).not.toContain(oldFull);
    expect(ls()).not.toContain(oldChanges);
    expect(existsSync(join(folder, `${oldChanges}.sha256`))).toBe(false);
    expect(ls(/^files-manifest-/)).toEqual([`files-manifest-${STAMP('20260701')}`]);
  });

  it('keeps every change after the second newest full archive, however many there are', () => {
    const names = [files(STAMP('20260101'), 'full')];
    for (let day = 10; day < 29; day += 1) names.push(files(STAMP(`202601${day}`), 'changes'));
    names.push(files(STAMP('20260201'), 'full'));
    for (let day = 10; day < 29; day += 1) names.push(files(STAMP(`202602${day}`), 'changes'));

    prune({}, 'files');

    expect(ls()).toEqual(names.sort());
  });
});

describe('leftovers', () => {
  it('clears checksums without a backup and a killed run\'s temporary files, but not a running one', () => {
    const name = dump(STAMP('20261105'));
    touch('yap-db-20261001T000000Z.dump.enc.sha256', 'yap-db-20261001T000000Z.dump.enc.proven', 'yap-db-20261105T060000Z.dump.enc.tmp');
    writeFileSync(join(folder, 'yap-db-20261101T000000Z.dump.enc.tmp'), 'x');
    spawnSync('touch', ['-t', '202601010000', join(folder, 'yap-db-20261101T000000Z.dump.enc.tmp')]);

    prune();

    expect(readdirSync(folder).sort()).toEqual([name, `${name}.sha256`, 'yap-db-20261105T060000Z.dump.enc.tmp'].sort());
  });
});

describe('a disk that is too small', () => {
  /** Stands in for df: a disk of CAPACITY bytes that holds only the backup folder. */
  function fakeDf() {
    const bin = join(root, 'df-bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'df'),
      `#!/bin/sh
used=$(cat "$DISK"/yap-* 2> /dev/null | wc -c)
echo "Filesystem 1024-blocks Used Available Capacity Mounted"
echo "fake 0 0 $(((CAPACITY - used) / 1024)) 0% /"
`,
    );
    chmodSync(join(bin, 'df'), 0o755);
    return { DISK: folder, PATH: `${bin}:${process.env.PATH}` };
  }

  const MB = 1024 * 1024;

  function bigDump(stamp: string) {
    const name = `yap-db-${stamp}.dump.enc`;
    writeFileSync(join(folder, name), Buffer.alloc(MB));
    return name;
  }

  it('lets the oldest dumps go to make room, and no more than it takes', () => {
    const names = Array.from({ length: 9 }, (_, i) => bigDump(STAMP(`2026070${i + 1}`)));

    const result = prune({ ...fakeDf(), CAPACITY: String(10 * MB), NEED_MB: '3' }, 'db');

    expect(result.status).toBe(0);
    expect(ls()).toEqual(names.slice(2));
  });

  it('takes a whole older set of files before it touches a dump', () => {
    const dumps = Array.from({ length: 5 }, (_, i) => bigDump(STAMP(`2026070${i + 1}`)));
    const oldFull = `yap-files-${STAMP('20260101')}-full.tar.gz.enc`;
    writeFileSync(join(folder, oldFull), Buffer.alloc(3 * MB));
    const oldChanges = files(STAMP('20260102'), 'changes');
    const newFull = files(STAMP('20260601'), 'full');

    prune({ ...fakeDf(), CAPACITY: String(9 * MB), NEED_MB: '2' }, 'db');

    expect(ls()).toEqual([...dumps, newFull].sort());
    expect(ls()).not.toContain(oldChanges);
  });

  it('never goes below the newest three dumps and the newest set, and says so', () => {
    const proven = bigDump(STAMP('20260101'));
    touch(`${proven}.proven`);
    const dumps = Array.from({ length: 6 }, (_, i) => bigDump(STAMP(`2026070${i + 1}`)));
    const full = `yap-files-${STAMP('20260601')}-full.tar.gz.enc`;
    writeFileSync(join(folder, full), Buffer.alloc(MB));

    const result = prune({ ...fakeDf(), CAPACITY: String(9 * MB), NEED_MB: '100' }, 'db');

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('only the backups that must stay are left');
    expect(ls()).toEqual([proven, ...dumps.slice(3), full].sort());
  });
});

describe('infra/backup.sh', () => {
  /** What the fake docker should do, written to files the fake reads. */
  function arrange(behaviour: { tar?: number; pgDump?: number; pgRestore?: number } = {}) {
    writeFileSync(join(root, 'tar-status'), String(behaviour.tar ?? 0));
    writeFileSync(join(root, 'pg-dump-status'), String(behaviour.pgDump ?? 0));
    writeFileSync(join(root, 'pg-restore-status'), String(behaviour.pgRestore ?? 0));
  }

  function fakeDocker() {
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, 'docker'),
      `#!/bin/bash
# docker compose -p x -f y --env-file z <command> ...
while [[ "$1" != "exec" && "$1" != "ps" ]]; do shift; done
if [[ "$1" == "ps" ]]; then
  echo db; echo api
  exit 0
fi
shift 3 # exec -T <service>
case "$1" in
  pg_dump)
    printf 'a dump of the database'
    exit "$(cat "$FAKE/pg-dump-status")"
    ;;
  pg_restore)
    # Reads it all, as the real one does.
    cat > /dev/null
    exit "$(cat "$FAKE/pg-restore-status")"
    ;;
  find)
    cd "$FAKE/store" && find . -type f | sed 's|^\\./||' | while read -r name; do
      printf '%s\\t%s\\t%s\\n' "$name" "$(wc -c < "$name" | tr -d ' ')" "$(cat "$FAKE/mtime" 2> /dev/null || echo 1)"
    done
    ;;
  tar)
    tar -C "$FAKE/store" -czf - -T -
    exit "$(cat "$FAKE/tar-status")"
    ;;
esac
`,
    );
    chmodSync(join(bin, 'docker'), 0o755);
    writeFileSync(join(root, 'passphrase'), 'a passphrase for this test only');
    writeFileSync(join(root, 'env'), 'FOO=bar\n');
    return {
      PATH: `${bin}:${process.env.PATH}`,
      FAKE: root,
      ENV_FILE: join(root, 'env'),
      COMPOSE_FILE: join(root, 'compose.yml'),
      BACKUP_DIR: folder,
      BACKUP_PASSPHRASE_FILE: join(root, 'passphrase'),
      BACKUP_RESERVE_MB: '0',
    };
  }

  function backup(what: string, env: Record<string, string> = {}) {
    return spawnSync('bash', [join(INFRA, 'backup.sh'), what], { env: { ...process.env, ...fakeDocker(), ...env }, encoding: 'utf8' });
  }

  function upload(name: string, body = name) {
    writeFileSync(join(store, 'tenant', name), body);
  }

  function archiveList(name: string) {
    const decrypted = spawnSync(
      'openssl',
      ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-pass', `file:${join(root, 'passphrase')}`, '-in', join(folder, name)],
      { maxBuffer: 1 << 24 },
    );
    expect(decrypted.status).toBe(0);
    const listed = spawnSync('tar', ['-tzf', '-'], { input: decrypted.stdout, encoding: 'utf8' });
    return listed.stdout.split('\n').filter(Boolean).sort();
  }

  function pause() {
    // File names hold the second, so two runs in one second would be one backup.
    spawnSync('sleep', ['1.1']);
  }

  beforeEach(() => arrange());

  it('writes a full archive first, then only what is new, and something to show for a quiet day', () => {
    upload('a.jpg');
    upload('b.jpg');
    expect(backup('files').status).toBe(0);
    pause();
    upload('c.jpg');
    expect(backup('files').status).toBe(0);
    pause();
    expect(backup('files').status).toBe(0);

    const [full, firstChanges, secondChanges] = ls();
    expect(full).toMatch(/-full\.tar\.gz\.enc$/);
    expect(firstChanges).toMatch(/-changes\.tar\.gz\.enc$/);
    expect(secondChanges).toMatch(/-changes\.tar\.gz\.enc$/);
    expect(archiveList(full!)).toEqual(['tenant/a.jpg', 'tenant/b.jpg']);
    expect(archiveList(firstChanges!)).toEqual(['tenant/c.jpg']);
    expect(archiveList(secondChanges!)).toEqual([]);
  });

  it('saves a file again when it changed, so an upload caught halfway is complete in the next archive', () => {
    upload('a.jpg', 'the first half');
    expect(backup('files').status).toBe(0);
    pause();
    upload('a.jpg', 'the first half and the second half');
    expect(backup('files').status).toBe(0);

    expect(archiveList(ls()[1]!)).toEqual(['tenant/a.jpg']);
  });

  it('does not fail when a file changes while tar reads it', () => {
    upload('a.jpg');
    arrange({ tar: 1 });

    const result = backup('files');

    expect(result.status).toBe(0);
    expect(ls()).toHaveLength(1);
  });

  it('leaves nothing that looks like a backup when tar really fails, and the next run still has all the files', () => {
    upload('a.jpg');
    expect(backup('files').status).toBe(0);
    pause();
    upload('b.jpg');
    arrange({ tar: 2 });

    expect(backup('files').status).not.toBe(0);
    expect(ls()).toHaveLength(1);
    expect(readdirSync(folder).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    pause();
    arrange();
    expect(backup('files').status).toBe(0);
    expect(archiveList(ls()[1]!)).toEqual(['tenant/b.jpg']);
  });

  it('starts a new set when the list of what the set holds is gone', () => {
    upload('a.jpg');
    expect(backup('files').status).toBe(0);
    const [manifest] = ls(/^files-manifest-/);
    rmSync(join(folder, manifest!));
    pause();

    expect(backup('files').status).toBe(0);

    expect(ls().filter((name) => name.includes('-full.'))).toHaveLength(2);
    expect(ls(/^files-manifest-/)).toHaveLength(1);
  });

  it('starts a new set when the full archive is due, and only then', () => {
    upload('a.jpg');
    expect(backup('files').status).toBe(0);
    const [full] = ls();
    pause();
    expect(backup('files', { FILES_FULL_EVERY_DAYS: '90' }).status).toBe(0);
    expect(ls().filter((name) => name.includes('-full.'))).toHaveLength(1);

    spawnSync('touch', ['-t', '202601010000', join(folder, full!)]);
    pause();
    expect(backup('files', { FILES_FULL_EVERY_DAYS: '90' }).status).toBe(0);
    expect(ls().filter((name) => name.includes('-full.'))).toHaveLength(2);
  });

  it('stores a checksum that matches, in the format sha256sum reads', () => {
    expect(backup('db').status).toBe(0);
    const [name] = ls();
    const hash = spawnSync('openssl', ['dgst', '-sha256'], { input: readFileSync(join(folder, name!)), encoding: 'utf8' }).stdout.trim().split(' ').pop();
    expect(readFileSync(join(folder, `${name}.sha256`), 'utf8')).toBe(`${hash}  ${name}\n`);
  });

  it('prints the backup on the last line alone, for deploy.sh to read', () => {
    const result = backup('db');
    expect(result.stdout.trim()).toMatch(/^\/.*yap-db-[0-9TZ]+\.dump\.enc \(\d+ bytes\)$/);
  });

  it('leaves the temporary file of another backup of the same second alone', () => {
    upload('a.jpg');
    const stamp = STAMP('20261105', '120000');
    const bin = join(root, 'date-bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'date'), `#!/bin/sh\necho ${stamp}\n`);
    chmodSync(join(bin, 'date'), 0o755);
    const running = `yap-db-${stamp}.dump.enc.tmp`;
    touch(running);

    const docker = fakeDocker();
    const result = spawnSync('bash', [join(INFRA, 'backup.sh'), 'files'], {
      env: { ...process.env, ...docker, PATH: `${bin}:${docker.PATH}` },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(readdirSync(folder)).toContain(running);
  });

  it('gives a failed dump no final name', () => {
    arrange({ pgDump: 1 });
    expect(backup('db').status).not.toBe(0);
    expect(readdirSync(folder)).toEqual([]);
  });

  it('gives a dump that cannot be read back no final name', () => {
    arrange({ pgRestore: 1 });
    expect(backup('db').status).not.toBe(0);
    expect(readdirSync(folder)).toEqual([]);
  });

  it('still prunes when the run fails', () => {
    const newest = dump(STAMP('20261105'));
    dump(STAMP('20261104'));
    arrange({ pgDump: 1 });

    const result = backup('db', { RETENTION_KEEP_LAST: '1', RETENTION_DAILY: '0', RETENTION_WEEKLY: '0', RETENTION_MONTHLY: '0' });

    expect(result.status).not.toBe(0);
    expect(ls()).toEqual([newest]);
  });

  it('refuses to start when the disk could not spare the room, and says what it needs', () => {
    const result = backup('db', { BACKUP_RESERVE_MB: '999999999' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must stay free for the database');
    expect(readdirSync(folder)).toEqual([]);
  });

  it('keeps the settings file, encrypted', () => {
    expect(backup('config').status).toBe(0);
    const [name] = ls();
    expect(name).toMatch(/^yap-config-/);
    expect(readFileSync(join(folder, name!)).toString('latin1')).not.toContain('FOO=bar');
  });
});
