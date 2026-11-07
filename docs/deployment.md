# Going live and running the server

This is the runbook for one server that runs the whole platform. You do not need to be a system
administrator. Work from the top down and copy the commands. If a script stops, read what it says: each one
tells you what went wrong and what to do.

- [No fire detection yet](#no-fire-detection-yet)
- [First deploy for a demo](#first-deploy-for-a-demo): the short path, for showing the platform today
- [Before you start](#before-you-start)
- [Go live, step by step](#go-live-step-by-step)
- [Check on day one](#check-on-day-one)
- [Everyday work](#everyday-work): looking, the watchdog, updating, going back, fixing problems
- [Backups](#backups)
- [Restore](#restore)
- [Settings](#settings)
- [How it fits together](#how-it-fits-together)
- [For developers](#for-developers)
- [What has been tested](#what-has-been-tested)

Three rules protect the farm's data:

1. Never run `docker compose down -v` on the server. The `-v` deletes the database, the files and the certificates.
2. Keep a copy of `/etc/yap/backup.key` away from the server, and prove it with `infra/backup-key.sh check`. Without
   the key, no backup can ever be read.
3. Update with `infra/deploy.sh`, not by hand. It takes a backup first, and goes back if the new version fails.

## No fire detection yet

**The platform has no fire detection until a detector is connected.** It can raise an urgent alert for fire or smoke,
but only when a device sends it that event, and nothing on the farm does yet: no smoke detector, sensor or camera is
wired in. Until one is, the farm has no fire cover from this system, however green everything looks, so keep whatever
fire precautions you have. When a detector is connected, put real smoke in front of it and follow the alert all the way
to a phone. [Device events](device-events.md) explains what a device must send.

## First deploy for a demo

This is the short path for putting the platform on one server today to show people, with demo data and no real
records. Allow about an hour, most of it the first build. Do these in order. Each step links to the full version.

1. **Stop the laptop's development server, first.** Two programs reading one bot token take each other's messages, so
   a demo with the laptop still running would seem to lose them. Press Ctrl-C in the terminal running `pnpm dev`, then
   follow [step 2](#2-stop-the-laptops-development-server) to the end.
2. **Get a server and a name.** Ubuntu 24.04, 4 GB of memory or more, with SSH as root. With no domain yet, use the
   server's address with dashes: `203-0-113-10.sslip.io` points at `203.0.113.10` and can get a real certificate.
3. **Get the code and prepare the server.** Follow [step 3](#3-sign-in-to-the-server-and-get-the-code), then:
   ```sh
   bash infra/server-setup.sh
   ```
   This also installs the backups and the [watchdog](#the-watchdog). If it says a reboot is needed, run `reboot`,
   wait a minute, and sign in again.
4. **Save the backup key and prove the copy,** as in [step 5](#5-save-the-backup-key). Do not skip this because it is
   a demo: the same key stays on this server.
5. **Create the settings file.**
   ```sh
   infra/init-env.sh 203-0-113-10.sslip.io
   nano .env.production
   ```
   Fill in `PLATFORM_ADMIN_PHONE` and `PLATFORM_ADMIN_PASSWORD`, set `BACKUP_OFFSITE=pull`, and add `TELEGRAM_BOT_TOKEN`
   if the demo uses the bot. `pull` is fine for a demo, which holds nothing worth keeping. It is not enough for
   real records: those need [a second machine](#6-prepare-the-backup-machine).
6. **Deploy.**
   ```sh
   infra/deploy.sh
   ```
   It takes up to 30 minutes the first time, and ends with `Commit ... is live at https://...`. If it warns about
   Telegram, read [what the message means](#when-a-deploy-fails).
7. **Load the demo data,** once, with the command in [Demo data on a server](#demo-data-on-a-server), from `/opt/yap`.
8. **Look at it.**
   ```sh
   infra/status.sh
   ```
   The containers and the site must say `ok`. Backup lines say `LOOK` until the first backups have run, and `pull`
   always does. Then open the site on your phone, on mobile data, and sign in with a demo phone from the
   [README](../README.md#demo-logins) and your `SEED_PASSWORD`.
9. **If the bot is on,** connect your account under **Bildirishnomalar** and send a test alert, as in
   [Check on day one](#check-on-day-one).

Show people the [fire warning](#no-fire-detection-yet) above as well: a demo must not leave them thinking
the farm is protected. Do not put real records on a demo server. For the real farm, start again from
[Before you start](#before-you-start), on a fresh server.

## Before you start

### A server in Uzbekistan

Personal data must be stored on servers in Uzbekistan, under the law on personal data (spec 20.1). That covers
the server, the object store and the backups, even though backups are encrypted.

Get a server running **Ubuntu 24.04** with SSH access as root. The pilot sizing from spec 21.1 is:

| Component | Size |
| --- | --- |
| Application | 8 vCPU, 16 GB RAM |
| Database | 4 vCPU, 16 GB RAM, 500 GB SSD |
| Object storage | 1 TB |

This stack puts everything on one server, so one machine with 12 vCPU, 32 GB of RAM and a 500 GB SSD covers
all of it. It also starts on far less, and the memory settings adapt to what the server has:

| Memory | What to expect |
| --- | --- |
| 4 GB | The smallest that should work. Preflight warns, and an update's build is slow. |
| 8 GB | Comfortable for one farm. |
| 16 GB or more | Room for the spec's load of 100 people at once. |

Below about 3.5 GB, preflight refuses. A running stack uses about 350 MB when quiet, and a build with the stack
running stayed under 3 GB, disk cache included. Keep at least 15 GB of disk free for Docker. Move up as data grows:
[Moving to a bigger server](#moving-to-a-bigger-server) is one command.

### A domain name

Choose the name people will type, for example `agropanel.uz`. You will point it at the server in step 1.

No domain yet? `<server-ip-with-dashes>.sslip.io` points at the server and can get a certificate, for example
`203-0-113-10.sslip.io`. Use it until the real name is ready, then change `DOMAIN` and deploy again. Plain `http://`
is not an option: the browser refuses the sign-in cookie, so every reload signs the person out.

### A second machine for backups

A backup on the server's own disk does not survive losing that disk, so backups must also go somewhere else,
**also in Uzbekistan**. Preflight refuses to deploy until this is set. Any of these will do, best first:

| Where | Notes |
| --- | --- |
| A small second server, with a different provider | Best. Backups arrive by themselves. |
| A computer or NAS at the farm or office that stays on | It fetches backups from the server. Needs no fixed address of its own. |
| A disk mounted on the server, from your provider | Survives a failed disk, but not losing the whole account. |

### What else

- About an hour, plus the first build, which took 14 minutes in testing on a fast machine. Allow 30.
- A phone with an authenticator app, such as Google Authenticator. The platform admin, owners, directors and
  accountants must use one.
- A password manager, for the backup key.
- Somewhere safe for the recovery codes each of those people gets: a password manager, or paper in a locked drawer.
- The AI keys stay empty for now. The assistant sends the data a question needs to Google or Anthropic, outside
  the country, so review that first. [Settings](#settings) has the details.

## Go live, step by step

### 1. Point the domain at the server

At your domain registrar, add an **A record** for your name with the server's IP address.

- Do not add an AAAA (IPv6) record: this stack answers on IPv4 only.
- Do not turn on any proxy or CDN for it. Caddy must answer directly, and personal data must not pass through
  a foreign service.

A new record can take from a few minutes to a few hours. You can carry on meanwhile: preflight will tell you
if it has not arrived yet.

### 2. Stop the laptop's development server

**Do this before step 8 if the laptop uses the same Telegram bot.** Telegram lets only one program at a time
read a bot's messages. With two, they keep interrupting each other, and each takes some of the messages. A
receipt, a voice note or a button press can land on the laptop and be lost, and people get answers from demo data.

On the laptop, in the project folder:

1. Press Ctrl-C in the terminal running `pnpm dev`.
2. Check that nothing is left. This must print nothing:
   ```sh
   lsof -nP -iTCP:4000 -sTCP:LISTEN
   ```
3. Open `.env` and empty the line `TELEGRAM_BOT_TOKEN=`, so it cannot start polling again by accident.

To keep developing with a bot, create a second one with @BotFather and put that token in the laptop's `.env`.
That is the lasting fix: production and development then never share a bot.

### 3. Sign in to the server and get the code

```sh
ssh root@YOUR_SERVER_IP
apt-get update && apt-get install -y git
git clone https://github.com/khurshidnm/yuksalish-agro.git /opt/yap
cd /opt/yap
```

The repository is private, so GitHub asks you to sign in. Use a
[fine-grained token](https://github.com/settings/personal-access-tokens) with read-only access to this
repository as the password. If the release is on a branch other than `main`, also run `git checkout` with its name.

### 4. Prepare the server

```sh
bash infra/server-setup.sh
```

This takes a few minutes, and it is safe to run again at any time. It installs Docker from Docker's own
repository and turns on a firewall that allows only SSH, 80 and 443. It also sets up automatic security updates,
fail2ban for SSH, swap if memory is small, the backup schedule, and the [watchdog](#the-watchdog) that restarts a
frozen API. It finds out which port SSH uses, so it cannot lock you out.

Security updates that need a restart reboot the server at 04:30 Tashkent time, which takes a minute or two.
Everything comes back by itself. To decide on reboots yourself, run it as `YAP_AUTO_REBOOT=no bash infra/server-setup.sh`.

If your provider has its own firewall in its control panel, open TCP 22, 80 and 443 there too. If the script
says a reboot is needed, run `reboot`, wait a minute, and sign in again.

### 5. Save the backup key

Every backup is encrypted with this key. **If the server dies, your saved copy is the only way to read any backup**,
and a copy with one wrong character is as useless as none. So save it, then prove the copy.

```sh
cat /etc/yap/backup.key
infra/backup-key.sh show
```

The first line prints the key, and the second its fingerprint: a short name like `3fa9-07bc-11de`, which is no secret.
`server-setup.sh` showed it too. Copy both into one entry in a password manager. Then enter the key from the password
manager, not from this screen. What you enter stays hidden:

```sh
infra/backup-key.sh check
```

It must say `It matches`. If it does not, it says how the two differ. Save the key again and repeat.

With no password manager, paper will do only if this check has accepted the key typed back from that very paper. The
key is 64 characters, and one misread letter loses every backup. Lock the paper away afterwards.

### 6. Prepare the backup machine

If the second machine is a server, run this on it, as root:

```sh
apt-get update && apt-get install -y rsync python3
adduser --disabled-password --gecos '' yapbackup
install -d -o yapbackup -g yapbackup -m 700 /srv/yap-backups /home/yapbackup/.ssh
```

On the main server, show its public key:

```sh
cat /etc/yap/backup_ssh_key.pub
```

Back on the second machine, put that whole line in place of `PUBLIC_KEY`:

```sh
echo 'command="/usr/bin/rrsync -wo -no-del /srv/yap-backups",restrict PUBLIC_KEY' > /home/yapbackup/.ssh/authorized_keys
chown yapbackup:yapbackup /home/yapbackup/.ssh/authorized_keys
chmod 600 /home/yapbackup/.ssh/authorized_keys
```

This key can only write into that one folder. It cannot sign in, read anything or delete anything, so someone who
breaks into the main server cannot simply wipe the backups. It could still write over a file by name, so this guards
against a wipe, not against a careful attacker.

That also means the main server cannot tidy this folder, so the second machine does it, with the same rules. Every copy
brings them along, as `yap-backup-prune.sh`. Once the first backups have arrived ([day one](#check-on-day-one), step 2),
install that file on the second machine, as root:

```sh
install -m 755 /srv/yap-backups/yap-backup-prune.sh /usr/local/bin/yap-backup-prune.sh
```

Then add this line to root's crontab there (`crontab -e`):

```cron
0 5 * * * bash /usr/local/bin/yap-backup-prune.sh /srv/yap-backups
```

Always run the installed copy, never the one in the folder: whoever breaks into the main server can replace that one,
and root would run it. If an update changes the rules, repeat the `install` line.

It keeps what the main server keeps: see [how long backups are kept](#how-long-backups-are-kept). Do not swap it for a
rule that goes by age. If backups stopped for three months, such a rule would delete the last good ones.

If the backup machine is a computer at the office instead, follow
[a machine that fetches the backups](#a-machine-that-fetches-the-backups).

### 7. Create the settings file

```sh
infra/init-env.sh agropanel.uz
nano .env.production
```

The first command writes `.env.production` with strong random passwords and memory settings for this server.
Do not change the passwords afterwards: the database is created with them. Then fill in these three:

| Setting | What to write |
| --- | --- |
| `PLATFORM_ADMIN_PHONE` | Your phone, exactly like `+998901234567`, with no spaces. You sign in with it. |
| `PLATFORM_ADMIN_PASSWORD` | At least 12 characters, inside the single quotes that are there. Common passwords are refused. |
| `BACKUP_OFFSITE` | Where backups go. With step 6: `yapbackup@BACKUP_MACHINE_IP:/` |

Optionally, for the public website, add `VITE_CONTACT_PHONE` and `VITE_CONTACT_TELEGRAM`. To turn on the bot,
add `TELEGRAM_BOT_TOKEN`, and put a Telegram chat in `BACKUP_ALERT_CHAT_ID` to hear about failed backups and a frozen
API. Save with Ctrl-O, Enter, then Ctrl-X.

### 8. Deploy

```sh
infra/deploy.sh
```

Preflight runs first and checks everything: secrets, the domain, ports, disk, memory and the backup location.
If it refuses, it lists what to fix, and nothing has changed. Fix those and run the same command again.

The first build took 14 minutes in testing. Allow 30 on a smaller server or a slower connection. If your SSH
connection drops, the deploy keeps going. Sign in again and read the newest log in `/var/log/yap/`.

At the end you see `Commit ... is live at https://...`. The certificate is requested by itself the first time,
which takes under a minute.

With a bot token set, preflight asks Telegram whether it accepts the token, and the deploy asks again at the end, from
inside the API container, then watches 35 seconds for a second poller. The token is never shown. A `WARNING` about
Telegram does not fail the deploy, because the site works without it, but no alert reaches anyone until it is fixed:
see [what the message means](#when-a-deploy-fails).

### 9. Create the real farm

1. Open `https://agropanel.uz/login` and sign in with the admin phone and password. The admin must use
   two-factor sign-in, so the app stops here until it is on: scan the QR code with the authenticator app, enter the
   6-digit code, and press **Yoqish**. Save the ten recovery codes it shows, tick the box, and continue. You land on
   **Platforma**. If you lose the phone and the codes, see [Someone cannot sign in](#someone-cannot-sign-in).
2. Press **Xo'jalik qo'shish**. Fill in the required fields: **Nomi** (the business), **Birinchi ferma nomi** (the
   first farm), **Ega telefoni** and **Ega ism-sharifi** (the owner). Leave **Tarif** empty to turn on every module.
3. Press **Saqlash**. The next window shows **Ega paroli**, the owner's one-time password. It is shown only once,
   so copy it now, then press **Saqlab oldim**.
4. Sign out. Sign in as the owner, with the owner's phone and that password.
5. That password opens one screen only: choose a new one. It must be at least 10 characters and not easy to guess.
6. The app now requires two-factor sign-in. Scan the QR code with the authenticator app, enter the 6-digit code,
   and press **Yoqish**. Save the ten recovery codes, tick the box, and continue.
7. Open **Moliya**, then **Kassa va bank**, and add the farm's cash and bank accounts. A new farm has none, and
   no money can be recorded until one exists. You can do this by hand or through the assistant.

Then add your staff under **Boshqaruv**, **Foydalanuvchilar**, each with their role. A new phone gets a one-time
password to pass on, and that person chooses their own at first sign-in. A phone that already has an account on the
platform gets an invitation instead: nothing is shared with the farm until that person signs in and accepts.

If the owner's phone already has an account, step 3 shows no password. The owner sees the invitation when they sign
in, and the new farm has no owner until they accept.

### 10. Tidy up

Remove the admin's password from the settings file. The account exists now, and a later password change is
never overwritten:

```sh
nano .env.production    # delete the PLATFORM_ADMIN_PHONE and PLATFORM_ADMIN_PASSWORD lines
```

Take the admin's recovery codes off the laptop you saved them on, and put them with the backup key.

## Check on day one

Do these on the first day. Each one proves something that you must not find out is broken on a bad day.

1. **Is everything up?**
   ```sh
   cd /opt/yap && infra/status.sh
   ```
   Every line should say `ok`. A `LOOK` line tells you what to look at. The backup lines say `LOOK` until the next
   three steps have run.

2. **Do backups leave the server?** Run the whole chain by hand, then look on the other machine:
   ```sh
   infra/backup-cron.sh db
   infra/backup-cron.sh files
   ```
   On the backup machine, `ls -l /srv/yap-backups` must show today's `yap-db-`, `yap-files-` and `yap-config-` files.
   Then, in that folder, `sha256sum --quiet -c yap-*.sha256` must print nothing: each copy arrived whole. Now install
   the tidying rules on that machine, as [step 6](#6-prepare-the-backup-machine) says.

3. **Can a backup be restored?** This restores the newest database backup into a throwaway database and removes it
   again, then checks the newest set of files. It touches nothing live, and it runs by itself every night at 03:15:
   ```sh
   infra/backup-cron.sh check
   ```
   It must end with `backup check passed`.

4. **Is your saved backup key right?** Open the saved copy, on another device if you can, and enter it here:
   ```sh
   infra/backup-key.sh check
   ```
   It must say `It matches`. This is the only thing that proves the copy: every other check reads the key on this
   server, which is no help once the server is gone. `infra/status.sh` says `LOOK` until it has passed.

5. **Does it work from outside?** On your phone, on mobile data and not the farm's Wi-Fi, open the site. Check
   the padlock in the address bar, and sign in. Ask someone in the field to sign in as well, on their own phone.

6. **Does it survive a restart?** Choose a quiet moment:
   ```sh
   reboot
   ```
   Wait two minutes, sign in, and run `infra/status.sh`. Everything must come back by itself.

7. **Do alerts reach a phone?** This needs the bot. First ask the server:
   ```sh
   infra/status.sh | grep -i telegram
   ```
   It must name your bot and say there is no second poller. If it does not, see
   [what the message means](#when-a-deploy-fails), or go back to [step 2](#2-stop-the-laptops-development-server).

   Then connect your account under **Bildirishnomalar**, check that the bot answers, open the **Sozlamalar** tab there,
   and press **Sinov xabarini yuborish**. Tell the staff first: everyone an urgent alert can go to gets one message
   marked as a test, down the same road a real alert takes (`POST /api/v1/alerts/test`). Nothing repeats, and no real
   alert is made. The screen then lists who it reached, and why it missed the others, such as an account that is not
   linked. Each person who must hear about an emergency has to be on the first list.

   The daily summary comes at 07:00. **It has not yet run unattended on a real server, so check that it arrives on the
   first morning.** A test alert proves the road from the server to the phone, and says nothing about fire:
   [nothing detects one yet](#no-fire-detection-yet).

8. **Who tells you if the server dies?** The server cannot report its own death, so something outside must notice the
   silence. Use a service that raises an alarm when a regular ping stops arriving, such as healthchecks.io. Make two
   checks there, put their addresses in `.env.production`, and run `infra/deploy.sh`:

   | Setting | Pinged | Silence means | Allow |
   | --- | --- | --- | --- |
   | `HEARTBEAT_URL` | Every minute, while the [deep health check](#monitoring) passes | The server, the API, the background worker or urgent alerts have died | 5 minutes |
   | `BACKUP_HEARTBEAT_URL` | Once a day, when the real restore of step 3 passes | Backups or cron have died | 1 day and a few hours |

   They must be two addresses, or the API's pings would hide dead backups. A ping holds no farm data, so a service
   abroad is fine for this.

## Everyday work

### Looking

```sh
cd /opt/yap && infra/status.sh
```

This only reads, so run it whenever you like. Once a week is a good habit.

For logs, this shortcut saves typing. Add it to `/root/.bashrc` once:

```sh
alias yap='docker compose -f /opt/yap/docker-compose.prod.yml -f /opt/yap/docker-compose.tls.yml --env-file /opt/yap/.env.production'
```

Then `yap ps` lists the containers, and `yap logs --tail 100 api` shows the API's log. Use `web` or `caddy` for
the others.

`infra/status.sh` covers the containers and the site, the [deep health check](#monitoring), the certificate, the
backups and the real restore check, your saved backup key, the watchdog, the disk and memory, and Telegram. Telegram
is a real question to it, from inside the API container, and the token is never shown.

### The watchdog

Docker restarts the API when it dies, but not when it freezes: alive, and answering nobody. So `infra/watchdog.sh`
asks the API for `/api/health` once a minute, from `/etc/cron.d/yap-watchdog`, which `server-setup.sh` installs.

- **Three failed checks in a row restart the API.** The app is away for a minute or so, and phones sync afterwards.
- **Each restart is recorded.** It goes to `/var/log/yap/watchdog.log` and to the chat in `BACKUP_ALERT_CHAT_ID`, and
  `infra/status.sh` says `LOOK` for 7 days. A freeze is a fault, so send that log and `yap logs --tail 200 api` to a
  developer.
- **It does not loop for ever.** After three restarts that did not last, it stops, says so once, and leaves the API to
  a person: start with `infra/status.sh` and `yap logs --tail 100 api`. A restart has lasted if the API answers an hour
  or more after it, and the count then starts again.
- **It stays out of the way.** During a deploy it counts nothing. It leaves an API that is not running alone, because
  Docker handles a crash, and a restore stops the API on purpose.

To see it work, at a quiet moment:

```sh
yap pause api
tail -f /var/log/yap/watchdog.log
```

Three lines of `did not answer` appear, one a minute, then the restart. Press Ctrl-C when it says the API has restarted.

### Updating

```sh
cd /opt/yap
git pull
infra/deploy.sh
```

The deploy does this, in order, and stops at the first problem:

1. Preflight.
2. A backup of the database and the settings.
3. It tags the running images, so it can go back to them.
4. It builds the new version while the old one keeps running.
5. It starts the new version. If there are new database migrations, it stops the API first.
6. It waits for every service to be healthy.
7. A smoke check through the public address: the health check, the public page, the app, and a sign-in attempt.

The public pages stay up. The API was away for 2 seconds in testing. Expect longer on a slower server, and up to
30 seconds with the Telegram bot on, because it finishes what it has in hand first. Phones sync what they saved
meanwhile. Choose a quiet hour if the update has migrations. To change a setting, edit `.env.production`, then run
`infra/deploy.sh`.

### Someone cannot sign in

| Who, and what happened | What to do |
| --- | --- |
| Too many wrong tries | The app says how long to wait, 15 minutes at most. Only that phone from that address is locked, so another network works at once. A password or 2FA reset lifts it. |
| Staff forgot the password | The owner opens **Foydalanuvchilar**, the row's menu, **Parolni tiklash**. The person chooses a new one at sign-in. |
| Staff lost the authenticator | They use a recovery code on the sign-in screen, then connect the new phone. With no codes left, the owner uses **2FA ni tiklash** in the same menu. |
| Someone who also works on another farm, or a platform admin | A farm owner cannot reset these: a password opens every farm the person works on. The platform admin does it. |
| The owner forgot the password or lost the authenticator | The owner uses a recovery code if they have one. If not, the platform admin signs in, opens **Platforma**, **Foydalanuvchilar**, and uses the row's menu. |
| The platform admin | See below. Nobody can reset this account from the app. |

Every reset goes to the journal of the person's farm, and they hear about it on Telegram if it is linked.

**Recovery codes.** Turning on two-factor sign-in gives each person ten recovery codes, shown only once. Each works
once, in place of the 6-digit code: on the sign-in screen, press **Telefon yo'qmi? Zaxira kod bilan kiring**. Keep them
away from the phone, in a password manager or on paper in a locked drawer. After a code is used the app says how many
are left. The profile window shows that too, and **Yangi kodlar olish** gives ten new ones, and the old ones stop working.

**A lost admin password or authenticator** is fixed on the server. Sign in over SSH, then:

```sh
cd /opt/yap
docker compose -f docker-compose.prod.yml -f docker-compose.tls.yml --env-file .env.production \
  run --rm --no-deps migrate tsx src/db/reset-admin.ts
```

It prints a one-time password, once, and signs out every device. Sign in with it, choose a new password, and enrol
two-factor sign-in again. If several admins exist, it lists them: add the phone to the end of the command. To see
what platform admins have changed, and every use of this command:

```sh
docker compose -f docker-compose.prod.yml -f docker-compose.tls.yml --env-file .env.production \
  exec db sh -c 'psql -U yap yap -c "select created_at, admin_id, action, target_id, ip from platform_audit order by created_at desc limit 50"'
```

### Going back

If the deploy itself fails, it goes back by itself. If you find a problem later:

```sh
infra/deploy.sh --rollback
```

That returns to the images and the Caddyfile from before the last deploy. The two most recent sets are kept.

**What going back cannot undo:**

| | |
| --- | --- |
| Database migrations | They stay. A migration has no undo, and the old code may not work with the new schema. Only restoring the backup puts the database back. The failure message says how many ran, and gives the restore command. |
| Data saved meanwhile | It stays. A restore would lose it. |
| The code on disk, `.env.production`, the compose files | They stay at the new version. Only the running images and the Caddyfile that Caddy reads go back. Fix the cause or `git checkout` the older commit before the next deploy, or the same thing happens again: that deploy takes `infra/Caddyfile` from the checkout. |

### When a deploy fails

The script always ends by saying what happened. The exit code says the same:

| Code | Meaning | The site |
| --- | --- | --- |
| 0 | Deployed. | New version |
| 1 | Failed, and went back. On a first deploy there is nothing to go back to. | Old version, passing the smoke check |
| 2 | Refused before touching anything: preflight or the backup. | Unchanged |
| 3 | Failed, and going back failed too. | Probably down |

For code 3, read the end of the log it names, then run `yap ps -a` and `yap logs --tail 100 api`. If you
cannot see the cause, restore the backup it names: see [Restore](#restore).

| What you see | What it means | What to do |
| --- | --- | --- |
| `does not point at this server` | The domain has the wrong address, or the record has not arrived yet. | Fix the A record, wait, and run it again. |
| `the database migration failed` | A migration stopped. It ran in one transaction, so nothing changed. | Send the error line to a developer. The site is on the old version. |
| `SSL certificate problem` on a first deploy | No certificate yet: port 80 is closed somewhere, or the name is wrong. | Check the provider's firewall, then `yap logs --tail 50 caddy`. Do not retry many times in a row: Let's Encrypt allows only 5 failures an hour for a name. |
| `toomanyrequests` during a build | Docker Hub's limit for anonymous downloads. | Wait an hour, or run `docker login` with a free account. |
| `WARNING: everything works from inside this server` | The server cannot reach its own public address, which is normal with some providers. | Open the site on your phone. If it loads, nothing is wrong. |
| `another program is polling this Telegram bot` | A second program uses the same token. | Back to [step 2](#2-stop-the-laptops-development-server). |
| `Telegram refuses the bot token` | The token was revoked or mistyped. On a first deploy, preflight refuses until it is right. | Get the current token from @BotFather, put it in `TELEGRAM_BOT_TOKEN`, and run `infra/deploy.sh`. |
| `This server cannot reach Telegram` | Nothing answered from `api.telegram.org`. The route out of the country may be blocked, or Telegram may be away for a moment. | The site still works, but no alert, summary or backup warning gets out. Run `infra/status.sh` again in a while. If it stays, ask the provider whether outgoing HTTPS to `api.telegram.org` is allowed. |
| `Something unexpected answered for Telegram` | Telegram is having trouble, or a filter on the route answers in its place. | The same as above. |
| `Another deploy or a backup is running` | One is still going, perhaps after a dropped connection. | Wait. The newest file in `/var/log/yap/` shows how far a deploy is. |
| `Host key verification failed` in the backup log | The backup machine was reinstalled, so it has a new identity. | If you know why it changed: `rm /etc/yap/backup_known_hosts`, then `infra/backup-cron.sh db`. If you do not, find out first. |

### Keeping the server itself up to date

Ubuntu's security updates install by themselves. Docker's own packages do not, because a new version should be a
choice. Every few months:

```sh
apt-get update && apt-get upgrade -y
```

The containers keep running while Docker updates. Base images get their updates with each deploy, but nginx stays on
the exact version named in `apps/web/Dockerfile`, so a deploy cannot change it by itself. Each spring, when nginx.org
names a new stable line, change the tag there and deploy: an older line gets no more fixes.

### What the server removes by itself

Every night at 03:45, one job removes what has served its purpose: old notifications, stored answers to repeated
requests, finished webhook logs, what the assistant looked up, and unfinished imports. Each run that removes something
says what in the journal. The books, the journal, the audit log and stored files are never removed.
[What is kept, and for how long](retention.md) has the reasons, the times and how much it all comes to.

### Moving to a bigger server

After your provider adds memory:

```sh
infra/init-env.sh --resize
infra/deploy.sh
```

The database restarts once, for a few seconds.

## Backups

| What | When | Where |
| --- | --- | --- |
| Database and settings | Every 6 hours: 00:00, 06:00, 12:00, 18:00 | `/var/backups/yap`, then the backup machine |
| Uploaded files | Every 6 hours: 00:30, 06:30, 12:30, 18:30 | The same |
| A real restore of the newest database backup, and a check of the newest files | Every night at 03:15 | Nothing is kept: it is a test |
| A database backup | Before each deploy | `/var/backups/yap`, and the backup machine at the next run |

Spec 20.3 asks for the database every 6 hours and files daily. Files run as often as the database, because each run
only takes what is new. Everything is encrypted with `/etc/yap/backup.key` (spec 20.1), and `/etc/cron.d/yap-backup`
runs it all through `infra/backup-cron.sh`.

The settings file is backed up as well, because `JWT_SECRET` unlocks the stored two-factor secrets. Without it, a
restored database has every two-factor user locked out. So the backups and the key are all you need to rebuild.

**What makes a backup count.** A backup gets its final name only after it has been read back in full, so a file with a
final name is a good one. Its checksum is stored beside it, so a copy damaged on its way to the other machine shows.
Every night a real restore proves the newest database backup, and the newest one that passed is never removed, however
old it gets. Each pass pings `BACKUP_HEARTBEAT_URL`.

**Files are saved in sets.** Photos do not change, so a full copy every night would fill the disk with copies. A
full archive starts a set every 90 days, and each later run adds a small archive of what is new since. The archives do
not depend on each other, so a damaged one loses only the files inside it. If a file changes while it is being read, the
next run saves it again.

**On the backup machine,** this checks every copy, and prints nothing when all are whole. Run it once a month:

```sh
cd /srv/yap-backups && sha256sum --quiet -c yap-*.sha256
```

If a backup or its copy fails, it goes to `/var/log/yap/backup.log`, and `infra/status.sh` shows `LOOK` once the newest
one is too old. To hear about it straight away, set `BACKUP_ALERT_CHAT_ID` to a Telegram chat. That also needs
`TELEGRAM_BOT_TOKEN`, and sending a message does not disturb the bot. A failed backup is tried once more after a minute.

If `STORAGE_DRIVER=s3`, uploaded files are not on this server, so `backup.sh files` skips them. Use the object
store's own versioning or replication, in Uzbekistan.

### How long backups are kept

| Type | What stays |
| --- | --- |
| Database, settings | The newest 8, then the newest of each of the latest 14 days, 15 weeks and 12 months. That is under 50 dumps after a year, with at least one a week across the 90 days of the spec. |
| Uploaded files | The newest 2 sets, each removed only as a whole, so 90 to 180 days of them. |

Both machines keep the same, and the settings are in [Settings](#yours-to-fill-in). Expect the backups of uploaded
files to take about twice the space of the files themselves.

The rules count backups, not days, so when backups stop, nothing more is removed, however long that lasts. Each type is
judged alone, so healthy file backups can never push out failing database backups. Old backups go before each new one
is written, which is what lets backups carry on when the disk is nearly full.

Postgres shares the disk, and a full disk stops the whole farm. So a backup that would leave less than 1 GB free is not
started. Older backups go early to make room: a whole older set of files first, then the oldest dumps. The newest set,
the newest 3 dumps of each type and the newest proven dump always stay.

### A machine that fetches the backups

A computer at the office usually cannot be reached from outside, so it fetches the backups itself. Set
`BACKUP_OFFSITE=pull` in `.env.production`.

On that machine (Linux or a Mac, or Windows with WSL), make a key:

```sh
ssh-keygen -t ed25519 -N '' -f ~/.ssh/yap_backup
cat ~/.ssh/yap_backup.pub
```

On the server, as root, allow that key to read the backup folder and nothing else. Put the whole line in place
of `PUBLIC_KEY`:

```sh
apt-get install -y python3
echo 'command="/usr/bin/rrsync -ro /var/backups/yap",restrict PUBLIC_KEY' >> /root/.ssh/authorized_keys
```

Then, on that machine, run this every day. Use cron, or Task Scheduler on Windows:

```sh
rsync -rt -e 'ssh -i ~/.ssh/yap_backup' --exclude='*.tmp' --include='yap-*' --exclude='*' root@YOUR_SERVER_IP:/ ~/yap-backups/
bash ~/yap-backup-prune.sh ~/yap-backups
```

The second line keeps that folder to the same [rules](#how-long-backups-are-kept) as the server. After the first fetch,
copy the rules out of the folder, once, with `cp ~/yap-backups/yap-backup-prune.sh ~/`. Always run that copy, never the
one in the folder: whoever breaks into the server can replace that one. If an update changes the rules, copy it again.

The server cannot tell whether this happens, so `infra/status.sh` keeps showing `LOOK` for it, and checking is
up to you. Look at `~/yap-backups` every week.

If nothing else is possible yet, copy `/var/backups/yap` to a disk at the office by hand, every week. It is better
than nothing, but it means a week of lost work in a disaster instead of six hours. Keep that disk in Uzbekistan.

## Restore

Targets from spec 20.3: restore within 4 hours (RTO), and lose at most 6 hours of data (RPO). The database and the
files both run every 6 hours, so a lost disk costs at most that much of either. A run that failed, or a copy that did
not arrive, adds the time until the next good one, which is why the alerts matter. Nothing better than 6 hours is
possible for now, because Postgres keeps no running log of changes between dumps.

Backups are in `/var/backups/yap`, and the file name holds the UTC time it was taken. The nightly check proves a
restore works. Still do a whole drill every few months, and time it against the 4-hour target.

### Check a backup

This touches nothing live:

```sh
RESTORE_DB=yap_drill infra/restore.sh db /var/backups/yap/yap-db-XXXX.dump.enc
```

### Put the database back

```sh
RESTORE_CONFIRM=yes infra/restore.sh db /var/backups/yap/yap-db-XXXX.dump.enc
```

Everything saved after that backup is lost, so be sure. The script first restores into a new database, next to
the live one. A damaged backup or a wrong key stops it there, and the live data is not touched. Only then does it
stop the API, swap the two databases and start the API, which takes seconds.

The old database is kept as `yap_before_restore_...`, and the script prints how to remove it. Do that once you are
happy, because it uses disk.

For uploaded files, give the folder. It brings back the newest full archive and every archive after it, because each
one holds only part of the files:

```sh
infra/restore.sh files /var/backups/yap
```

If one archive is damaged, the others still come back, and the script names what is missing. To bring back only what
one archive holds, give its file name instead of the folder.

### The server is gone: rebuild on a new one

You need your saved backup key, and the backups from the other machine.

1. Do steps 1, 3 and 4 of [Go live](#go-live-step-by-step) on the new server. If its IP address changed, step 1 needs the new one.
2. Put your saved key in place of the one the script made. What you enter stays hidden:
   ```sh
   cd /opt/yap
   infra/backup-key.sh restore
   ```
   It prints the fingerprint of what you entered. That must be the fingerprint you saved with the key. If it is not, the
   key went in wrong, so run it again before going on.
3. Copy the backups into `/var/backups/yap`. For example, signed in on the backup machine as root:
   ```sh
   rsync -rt /srv/yap-backups/ root@NEW_SERVER_IP:/var/backups/yap/
   ```
4. Bring back the settings, the database and the app, in this order:
   ```sh
   cd /opt/yap
   ls -1t /var/backups/yap/yap-config-* | head -1
   infra/restore.sh config /var/backups/yap/yap-config-XXXX.env.enc
   RESTORE_CONFIRM=yes infra/restore.sh db /var/backups/yap/yap-db-XXXX.dump.enc
   infra/deploy.sh
   infra/restore.sh files /var/backups/yap
   ```
5. The new server has a new key for copying backups. Give `/etc/yap/backup_ssh_key.pub` to the backup machine, as in
   step 6. Run `infra/status.sh`, then go through [Check on day one](#check-on-day-one) again.

If the old server is still running, turn it off first. Otherwise the two will fight over the Telegram bot, just as
the laptop would.

## Settings

All of these live in `.env.production`. `infra/init-env.sh` fills in the first group, and `infra/preflight.sh`
checks most of them. Change one, then run `infra/deploy.sh`.

### Written for you

| Setting | Purpose |
| --- | --- |
| `POSTGRES_PASSWORD`, `YAP_APP_PASSWORD`, `YAP_AI_PASSWORD`, `REDIS_PASSWORD` | Passwords inside the stack. Hex, because they go inside connection URLs. `YAP_APP_PASSWORD` and `YAP_AI_PASSWORD` are applied only when the database volume is first created. |
| `JWT_SECRET` | Signs sessions, and unlocks stored two-factor secrets. Never change it on a live system. |
| `DOMAIN`, `WEB_ORIGIN`, `VITE_SITE_URL` | The name, and the same name with `https://`. |
| `TLS_MODE` | `caddy`, or `external` for [your own proxy](#using-your-own-proxy-instead-of-caddy). |
| `WEB_PORT` | The web container's port, on loopback only. |
| `DB_MEM_LIMIT`, `API_MEM_LIMIT`, `API_HEAP_MB`, `REDIS_MEM_LIMIT`, `REDIS_MAXMEMORY`, `WEB_MEM_LIMIT`, `CADDY_MEM_LIMIT`, `PG_SHARED_BUFFERS`, `PG_EFFECTIVE_CACHE_SIZE`, `PG_WORK_MEM`, `PG_MAINTENANCE_WORK_MEM` | Memory, sized for this server. |

Memory is shared out like this: Postgres gets 45 % of the server up to the 16 GB of the spec's database server, the
API 25 % up to 4 GB, because one Node process gains nothing from more, and Redis 5 % up to 1 GB. The rest stays for
the system, its disk cache and builds. If one part goes over its limit, only that part restarts, and it cannot take
the server down with it.

### Yours to fill in

| Setting | Effect | Note |
| --- | --- | --- |
| `PLATFORM_ADMIN_PHONE`, `PLATFORM_ADMIN_PASSWORD` | Create the first account | First deploy only. The demo seed refuses to run in production, so nothing else can. |
| `BACKUP_OFFSITE` | Where backups go | `user@host:path`, a mounted `/path` on another disk, or `pull`. |
| `BACKUP_ALERT_CHAT_ID` | Telegram chat told when a backup fails, or the watchdog restarts the API | Needs the bot token. |
| `HEARTBEAT_URL` | Pinged every minute while the deep health check passes | See [day one](#check-on-day-one), step 8. Empty means nothing outside notices a dead server. |
| `BACKUP_HEARTBEAT_URL` | Pinged once a day when the real restore check passes | It needs an address of its own: the API's pings would hide dead backups. |
| `BACKUP_DIR`, `BACKUP_PASSPHRASE_FILE`, `BACKUP_SSH_KEY`, `BACKUP_SSH_PORT` | Backup details | The defaults are right unless you have a reason. |
| `RETENTION_KEEP_LAST`, `RETENTION_DAILY`, `RETENTION_WEEKLY`, `RETENTION_MONTHLY`, `RETENTION_FILE_SETS` | [How long backups are kept](#how-long-backups-are-kept). Defaults: 8, 14, 15, 12 and 2 | Not in the file until you add them. The backup machine has its own copy of the rules, so set the same there. |
| `FILES_FULL_EVERY_DAYS` | How often a new full archive of the files starts. Default 90 | Add it to the file to change it. |
| `BACKUP_RESERVE_MB` | Left free on the disk by any backup or restore. Default 1024 | Add it to the file to change it. |
| `TELEGRAM_BOT_TOKEN` | Daily summary, urgent alerts, bot commands | Run one API instance only: two `getUpdates` pollers conflict. |
| `LEADS_TELEGRAM_CHAT_ID` | Tells a Telegram chat about each new enquiry from the website | Needs the bot token. Enquiries reach `/platform/leads` either way. |
| `GEMINI_API_KEY` | AI assistant and document reading | Must be from a billing-enabled Google project. On the free tier Google may use prompts and answers to improve its products and reviewers may read them, which spec 15.2 forbids. Statistical insights run without it. |
| `GEMINI_PAID_TIER` | Confirms the key above is on a paid project | Must be `true`, or production refuses to use Gemini, and preflight refuses to deploy. Google offers no way to detect the tier from a key. |
| `ANTHROPIC_API_KEY` | Alternative to Gemini | Set `AI_PROVIDER` if both keys are present. |
| `AI_PROVIDER` | `gemini` or `claude` | Only needed when both keys are set. Gemini is the default. |
| `AI_MODEL`, `AI_THINKING_BUDGET`, `AI_EFFORT`, `AI_CHAT_PER_MINUTE`, `AI_CHAT_PER_DAY` | Optional AI tuning | Empty keeps the defaults, including 10 questions a minute and 200 a day per person. `AI_THINKING_BUDGET` is Gemini only, `AI_EFFORT` Claude only. |
| `API_DOCS` | `true` serves the API reference at `/api/docs` | Off in production, because anyone can read it there, signed in or not. |
| `STORAGE_DRIVER=s3` with `S3_*` | Files in an S3-compatible store | With `local`, files live in the `files` volume. |
| `VITE_CONTACT_PHONE`, `VITE_CONTACT_TELEGRAM` | Shown on the public website | Built into the pages, so a change needs a deploy. |

The assistant sends the data a question needs to the chosen AI provider, which is outside the country. Review this
before setting either key. It has only been tested with a scripted model and, in Telegram, a mocked API, and no
score from `ai:eval` is recorded. Check it on staging with real credentials before relying on it. A real bot has
delivered a daily summary and an urgent alert ([acceptance record](acceptance.md), criterion 8).

## How it fits together

### The stack

| Service | Role |
| --- | --- |
| `db` | PostgreSQL 17 with PostGIS. Creates `yap_app` and `yap_ai` on first start. |
| `redis` | Background job queue, password protected. |
| `migrate` | One-shot: applies migrations and security rules, then exits. |
| `api` | Runs as the non-root `node` user. Starts only after `migrate` succeeds. |
| `web` | nginx, non-root. Serves the app and proxies `/api`. |
| `caddy` | HTTPS in front of `web`, from `docker-compose.tls.yml`. |

Only Caddy is reachable from outside, on 80 and 443. `web` is published on `127.0.0.1:${WEB_PORT}` only, and nothing
else leaves Docker.

Docker's published ports go around the firewall, so **the firewall does not protect anything you publish in a compose
file**. Never add a `ports:` line to `db` or `redis`. `deploy.sh` warns if a port other than 80 and 443 is open to
the internet.

Each service has a memory limit, and each log stops at 5 files of 10 MB. Postgres uses data checksums, on a volume
created by this stack. Redis uses `noeviction`, so when it fills up it refuses writes rather than silently dropping
scheduled jobs.

### HTTPS

`infra/Caddyfile` gets the certificate for `DOMAIN` from Let's Encrypt, renews it by itself, and sends plain HTTP to
HTTPS. It needs port 80 or 443 reachable from the internet, and TLS 1.2 is its minimum (spec 20.1). The certificates
live in the `caddy_data` volume, and only `down -v` could lose them. `deploy.sh` restarts Caddy when the Caddyfile has
changed, because a running Caddy cannot see that by itself.

HTTPS is required, not a nicety. The refresh cookie is marked `Secure` in production, so over plain HTTP a session
cannot be renewed and people are signed out when the access token expires. Service workers need HTTPS as well.

Three details matter to anyone changing this:

- **The assistant's stream.** Its answer streams, so nothing may buffer it: the web container's nginx removes
  `X-Accel-Buffering`, so an outer proxy never sees that request. And one model call can take 3 attempts of 120 s with
  nothing sent meanwhile, so read timeouts must be longer than that. A proxy that cuts it first hands a turn that is
  still working back to the person to send again, which can draft a second card. `infra/nginx.conf` allows 600 s under
  `/api/v1/ai/` and 120 s for the rest of the API. Caddy allows 660 s, so it is never the first to give up.
- **The real client address.** Sign-in is limited per address. Caddy replaces `X-Forwarded-For` with the address it
  saw, and ignores what the client sent. nginx trusts that header only from private addresses. If the proxy's address
  were lost, the whole farm would share one sign-in limit.
- **Compression.** Caddy adds a `Via` header, and nginx stops compressing such requests unless `gzip_proxied` is set.
  Without it, the app's scripts are about three times larger on a slow connection.

### Using your own proxy instead of Caddy

Set `TLS_MODE=external` and put any TLS proxy on the host, forwarding to `127.0.0.1:${WEB_PORT}`:

```nginx
server {
    listen 80;
    server_name app.example.uz;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name app.example.uz;
    ssl_certificate /etc/letsencrypt/live/app.example.uz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.example.uz/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
        proxy_read_timeout 600s;
        client_max_body_size 16m;
    }
}
```

The last settings are for the assistant, for the reasons above. Any other proxy needs the same things,
plus the redirect from HTTP and TLS 1.2 or later (spec 20.1).

`X-Forwarded-Proto: https` also turns on HSTS: the web container sends the header on every page and API
answer, for this name only, not its subdomains. So do not add `Strict-Transport-Security` in your proxy,
or browsers get it twice. Caddy sets it to the same value on its own answers too, such as a 502 during a
deploy, and replaces nginx's copy, so that mode also sends it once.

### Monitoring

| Address | What it looks at | Who uses it |
| --- | --- | --- |
| `/api/health` | The API and the database | The container check, the deploy's smoke check, the [watchdog](#the-watchdog) |
| `/api/health/deep` | Also Redis, the background worker, urgent alerts getting out, contact with Telegram, and the disk under 90 % | The API itself every minute, `infra/status.sh`, any outside uptime check |
| `/healthz`, on the web container | nginx | The container check |

From outside, `/api/health/deep` says only `ok` or `failing`, with status 200 or 503: that alerts are not getting out
is no business of a stranger. `infra/status.sh` asks from inside the API container, so it names what is failing.

Every minute the API runs the deep check, writes any change to its log (`deep health check is failing`), and pings
`HEARTBEAT_URL` only while it passes. So the alarm comes from outside when the server dies, and also when it lives on
with a dead worker or stuck alerts. Set it up as in [day one](#check-on-day-one), step 8.

The spec's Prometheus and Grafana monitoring (20.3) is not part of this stack yet.

### Logs

`yap logs api` and `yap logs web`. Request lines hold the path without its query string, which can carry a searched
name or phone, or the token of a file link. Errors hold the database driver's error, not the query or what the person
typed (`LOG_SERIALIZERS` in `apps/api/src/app.ts`). Caddy keeps no access log, and its error log drops the request
for the same reason. nginx's error log is the one exception: when the proxy itself fails a request, for example during
a deploy, that line shows the full address.

Deploy logs are in `/var/log/yap/deploy-*.log`, backup logs in `/var/log/yap/backup.log`, and the watchdog's in
`/var/log/yap/watchdog.log`.

### Files and uploads

| Limit | Value | Set in |
| --- | --- | --- |
| One file | 15 MB | `MAX_UPLOAD_BYTES` in `packages/shared/src/limits.ts`. nginx allows 16 MB for the same file and its wrapper, and a proxy of your own needs at least that. |
| All files of one workspace | 20 GB | `storage.quotaMb` in the workspace's policy |
| One person in 24 hours | 500 MB | `storage.dailyUploadMb` in the workspace's policy |
| One person in a minute | 60 uploads | `UPLOADS_PER_MINUTE` in `apps/api/src/core/storage.ts` |
| Free disk | Uploads stop below 2 GB | `MIN_FREE_DISK_BYTES` in `apps/api/src/modules/files/files.service.ts`. Postgres stops when its disk fills, so uploads stop first. The owner gets a `disk_low` alert below 4 GB, checked every hour. |

The owner changes the two policy values under Settings, Policies. Settings, Files shows where a workspace stands, lists
files nothing uses and deletes them. The journal records `file.uploaded` and `file.deleted`, and `file.limit_reached`
once a day for each person and limit.

Spreadsheets for import are read in a process of their own inside the API container, one at a time, with a heap of
256 MB, 20 seconds and 32 MB of unpacked data. A file that breaks a limit ends only that process. The person is told
the file is too large, and the API logs `the spreadsheet reader was stopped`. The process can peak near 460 MB on top
of the API, which is why `API_MEM_LIMIT` must not go below 768 MB. If the container does run out of memory, the kernel
takes this process first.

### Known limits

- One API instance. Background jobs and the Telegram poller run inside it, and the sign-in rate limit is kept in memory.
- The API image runs TypeScript through `tsx`, because `@yap/shared` ships as source.

### Public website and leads

`/`, `/ru`, `/en` and `/uz-cyrl` are prerendered at build time into `dist/landing/`, so search engines read real HTML.
nginx serves those files; every other address is the app. A browser with a session is sent from the public page to
`/app`, and the installed app starts there too.

Before the first public release:

1. `VITE_SITE_URL` is set for you. Add `VITE_CONTACT_PHONE` and `VITE_CONTACT_TELEGRAM`, then deploy. They are baked
   into the pages, so a change needs a rebuild, not a restart.
2. Check the result: `/sitemap.xml` exists, and `/` contains a `rel="canonical"` link.
3. Submit `/sitemap.xml` to Google Search Console and Yandex Webmaster.
4. Set `LEADS_TELEGRAM_CHAT_ID` to hear about new enquiries straight away, up to 20 an hour so that a flood cannot
   bury the chat. They all appear in the admin panel at `/platform/leads` either way.

Enquiries hold personal data, so keep them on the server in Uzbekistan with the rest of the database, and add a privacy
notice with your legal details before collecting them at scale.

## Demo data on a server

A farm that is being shown rather than used can hold the pilot demo data. The seed refuses to run in production
on purpose, so this overrides that guard for one command. Run it once, on an empty database, after the first
deploy. Never run it on a farm with real records.

```sh
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm --no-deps \
  -e NODE_ENV=development \
  -e SEED_PASSWORD='your-own-long-password' \
  -e DATABASE_OWNER_URL="postgres://yap:$(grep '^POSTGRES_PASSWORD=' .env.production | cut -d= -f2)@db:5432/yap" \
  api tsx src/seed/index.ts
```

Always set `SEED_PASSWORD`. The default is written in this repository together with the demo phone
numbers, so on a reachable server anyone could sign in as the owner. The platform admin keeps the password from
`PLATFORM_ADMIN_PASSWORD`. Demo farms have 2FA switched off, so that their logins work without an authenticator.

## For developers

### Migrations

`migrate` runs before the API on every deploy. It applies new files from `apps/api/drizzle`, then re-applies
`post-schema.sql`, which is safe to repeat and covers any new table with row-level security, audit and grants. Do not
edit a migration that has shipped. Pending migrations run in one transaction, so a failing one changes nothing.

`migrate` connects as the owner role, `yap`, which is a superuser in this stack. If Postgres moves elsewhere, the owner
must be a superuser or have BYPASSRLS. Tables force row-level security even on their owner, so a migration that changes
data finds no rows under any other role, changes nothing and still reports success.

`web` is not restarted when only the API changes. nginx asks Docker's DNS for the API's address every few seconds, so
`/api` comes back by itself within about 10 seconds of the new API starting. After changing `infra/nginx.conf`, test it
before it replaces the running container:

```sh
docker compose -f docker-compose.prod.yml --env-file .env.production build --pull web
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm --no-deps web nginx -t
```

### Trying the kit on a laptop

Everything except the real certificate works on a laptop. Put these in a test env file, and pass it with
`ENV_FILE=... COMPOSE_PROJECT=yap-kit YAP_STATE_DIR=... YAP_LOG_DIR=... infra/deploy.sh`:

```sh
DOMAIN=yap.localhost
WEB_ORIGIN=https://yap.localhost:8092
VITE_SITE_URL=https://yap.localhost:8092
CADDY_GLOBAL=local_certs     # Caddy's own CA instead of Let's Encrypt
TLS_BIND=127.0.0.1           # not reachable from the network
TLS_HTTP_PORT=8091
TLS_HTTPS_PORT=8092
WEB_PORT=8090
YAP_IMAGE_PREFIX=yap-kit     # a second stack must not overwrite the first one's image tags
```

`infra/backup.sh`, `infra/restore.sh` and `infra/backup-key.sh` also work on macOS. The other scripts need Linux.

### Upgrading a running farm to migrations 0003 and 0004

A new installation does not need this: it only concerns a database that already ran an older version.

| Migration | What it does |
| --- | --- |
| `0003_close_cost_centers` | Data only. Closes the cost centers of archived herds and written-off machines, so they can no longer be chosen. Each change is in the audit log. |
| `0004_assistant_hardening` | Adds `idempotency_keys.user_id` and `users.telegram_membership_id`, and drops `ai_proposals.needs_duplicate_confirmation`. |

0003 needs the owner role. Under `yap_app`, or an owner without BYPASSRLS, it reports `UPDATE 0` and looks like a
success. The `migrate` service already connects correctly; this matters if you run it by hand.

Choose a quiet hour, and ask field staff to open the app with a connection until nothing waits on `/today/sync`. Then:

```sh
cd /opt/yap
git pull
infra/deploy.sh
yap logs migrate
```

`deploy.sh` stops the API before migrating, because 0004 drops a column the old code reads, and gives it the 30 seconds
its Telegram shutdown needs.

`migrate` should end with `Row-level security, audit triggers and grants applied.` Then check the result:

```sh
yap exec -T db psql -U yap -d yap <<'SQL'
select count(*) as migrations from drizzle.__drizzle_migrations;
select count(*) as still_open from cost_centers cc
  left join herds h on cc.type = 'herd' and h.id = cc.ref_id
  left join assets a on cc.type = 'asset' and a.id = cc.ref_id
  where cc.active and (h.status = 'archived' or a.status = 'written_off');
SQL
```

`migrations` is the number of `.sql` files in `apps/api/drizzle`, and `still_open` is 0. If `still_open` is not 0, 0003
ran under a role that row-level security applies to. It is safe to repeat as `yap`:

```sh
yap exec -T db psql -U yap -d yap -v ON_ERROR_STOP=1 -1 -f - < apps/api/drizzle/0003_close_cost_centers.sql
```

What people may notice afterwards:

- **Telegram:** someone on one farm carries on as before. Someone on several farms is asked once, with buttons, which
  farm to work on before the assistant answers. Alerts do not change.
- **Phones:** a post saved before the upgrade whose answer never reached the phone is refused with
  `IDEMPOTENCY_KEY_REUSED` instead of being answered again, because old keys have no owner. It is not counted twice, but
  `/today/sync` shows it as failed although the record is saved. Find the record, then delete the item from the queue.
- **Open cards** stay open. Their duplicate check now runs live, when shown and at confirm.

There is no step back from 0004 by redeploying: the old code needs the dropped column. To go back, restore the backup
taken by the deploy and deploy the older commit.

### A database built with `pnpm db:setup`

`pnpm db:setup` and `pnpm db:reset` create the schema directly and record no migration history. To check, run
`select count(*) from drizzle.__drizzle_migrations` as the owner: on such a database the table does not exist. `migrate`
and `pnpm db:migrate` then try to create every table again and stop at `relation "api_keys" already exists`. Nothing
changes, but in the production stack `api` does not start.

Back up first and stop the API, then apply each migration the database does not have yet by hand, in order, as the
owner. These lines are for the development stack; for production, add the flags used above.

```sh
docker compose exec -T db psql -U yap -d yap -v ON_ERROR_STOP=1 -1 -f - < apps/api/drizzle/0003_close_cost_centers.sql
docker compose exec -T db psql -U yap -d yap -v ON_ERROR_STOP=1 -1 -f - < apps/api/drizzle/0004_assistant_hardening.sql
docker compose exec -T db psql -U yap -d yap -v ON_ERROR_STOP=1 < apps/api/src/db/post-schema.sql
```

If 0004 stops at `column "user_id" of relation "idempotency_keys" already exists`, nothing was changed: that database
was built from a newer schema. Compare it with the file before going on.

Then record the history, so that later deploys can use `migrate`. The number is the `when` of the last entry applied,
from `apps/api/drizzle/meta/_journal.json`:

```sh
docker compose exec -T db psql -U yap -d yap -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA IF NOT EXISTS drizzle;
CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);
INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('baseline', 1793866598422);
SQL
```

## What has been tested

The scripts were written and tested on 5 November 2026, on arm64. "Fake server" below means a real Ubuntu 24.04 with
systemd, its own Docker from Docker's repository, UFW, fail2ban and sshd, reached over SSH from a separate machine.
It is a privileged container, not a real server, and that is what the second table is about.

The Telegram check, the watchdog and the backup key command came after that, on 6 November. They have run in
`apps/api/test/server-kit.test.ts` and in a plain Ubuntu 24.04 container, with a stand-in for Docker and for Telegram.
They have not yet run on the fake server or a real one.

**Tested for real:**

| What | How |
| --- | --- |
| `server-setup.sh` | Ran to the end on the fake server, over SSH, and in plain `ubuntu:24.04`, where it reports the steps it had to skip. A second run changed nothing, and kept the keys. |
| Firewall | Port scan from another machine: only 22, 80 and 443 open, even with a listener on another port. SSH moved to 2222: the script found and opened it. |
| fail2ban | A real password attack from another machine: banned after 5 failures, while the owner still got in, and the banned address could still use the web app. |
| `preflight.sh` | 41 broken configurations, each refused with its own message, and 3 good ones passed. It changes nothing on the machine. DNS answers came from a real local DNS server. |
| HTTPS | A real ACME HTTP-01 challenge through the firewall and Docker's NAT, against Pebble, Let's Encrypt's own test server. One certificate survived restarts and redeploys with no second request. TLS 1.1 refused, 1.2 and 1.3 work. |
| Chat stream | Through the real Caddy and nginx, with a fake API: no buffering, 400 s of silence survived, a 700 s stream survived, and nginx cuts at 600 s, before Caddy. |
| Real client address | Reached nginx and the API through Docker's NAT, and a forged `X-Forwarded-For` was ignored. |
| `deploy.sh` | First deploy from nothing in 13 m 42 s, then updates. It went back correctly when the API crashed, a migration failed, a migration ran and then the API crashed, and the public page failed. The build failing and the backup failing touched nothing. A rollback that also failed was reported as that. Survives a dropped connection. Two at once refused. |
| Backups | Real cron firing, delivered over SSH to a second machine. That machine's key could not read, delete, run commands or leave its folder. Failures reach Telegram (a fake endpoint) and the log. |
| Restore | Into a separate database, and over the live one. A damaged backup and a wrong key left the live data alone. The whole server rebuilt from the backup files and the key alone, two-factor sign-in included. |
| Reboot | All services came back by themselves, with no container crashing while the others started. Docker restarted with the API staying up. |
| Compose hardening | Memory limits, log limits, Postgres and Redis settings read back from the running containers. |
| Creating a tenant | The whole path of step 9 in real Chrome over HTTPS, in Uzbek, including two-factor sign-in with a real code. |

**Only a real server can show:**

| What | Why it could not be tested here |
| --- | --- |
| Let's Encrypt itself | It needs a public name and address. Pebble runs the same protocol. |
| Your registrar, public DNS and your provider's firewall or routing | No real domain here, and public DNS servers were out of reach. The test of a server that cannot reach its own public address used a name that did not resolve. |
| x86 servers | Everything ran on arm64. Nothing in the kit depends on it, and all images used are multi-architecture. |
| Real swap and kernel settings | The fake server shares its kernel with other containers, so these calls were recorded, not applied. |
| The clock | Time sync does not run in a container. Check `timedatectl` on the server. |
| A kernel update and the 04:30 reboot | Reboots were simulated by restarting the fake server, whose boot takes seconds. The update settings were read back, and a dry run found the right sources. |
| A 4 GB server | The figures above were measured on a larger one. |
| Real Telegram | Keys stayed empty, so that nothing could disturb the real bot. Failure alerts went to a fake endpoint, and so did the token check, including a refused token and a blocked route. The second-poller warning looks for a log line that was checked against the real logging code, and has not seen a real conflict. |
| The watchdog against a real freeze | Its rules ran against a stand-in for Docker. Docker itself was seen to restart a paused container. Try it once as in [The watchdog](#the-watchdog). |
| Real AI | Keys stayed empty, so the stream was tested with a stand-in for the API. |
| Real load | No load test was part of this. |
