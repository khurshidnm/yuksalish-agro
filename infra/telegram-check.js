// Asks Telegram who the bot is. infra/lib.sh pipes this into `node -` in the API container, where the
// token already is, so it never passes through a command line. It prints one line of fixed words, and
// no error's own message: those can hold the address, and the address holds the token.
const api = process.env.TELEGRAM_API || 'https://api.telegram.org';

async function ask() {
  let response;
  try {
    response = await fetch(`${api}/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    const why = String(err?.cause?.code ?? err?.name ?? 'unknown');
    return `unreachable ${/^\w+$/.test(why) ? why : 'unknown'}`;
  }
  const body = await response.json().catch(() => null);
  if (response.ok && body?.ok === true) return `ok ${body.result?.username}`;
  // A bad token gets 401, and one that does not even look like a token gets 404.
  if (response.status === 401 || response.status === 404) return `refused ${response.status}`;
  return `odd ${response.status}`;
}

ask().then(console.log, () => console.log('unreachable unknown'));
