/**
 * The platform admin's account, from the server side: nobody in the app can create or reset it.
 * These take the owner's connection and need neither the API's configuration nor a running API.
 */
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type pg from 'pg';
import { passwordProblem } from '../core/passwords';
import { normalizePhone } from '../core/phone';

const hash = (password: string) => bcrypt.hash(password, Number(process.env.BCRYPT_ROUNDS) || 10);

/** Creates the first admin. Never touches an existing user, so a password changed later survives the next deploy. */
export async function ensurePlatformAdmin(client: pg.Client, rawPhone: string | undefined, password: string | undefined): Promise<void> {
  if (!rawPhone || !password) return;
  // Sign-in normalises what is typed, so an account stored any other way could never be reached.
  const phone = normalizePhone(rawPhone);
  if (!/^\+\d{9,15}$/.test(phone)) throw new Error('PLATFORM_ADMIN_PHONE must be written like +998901234567');
  if (password.length < 12) throw new Error('PLATFORM_ADMIN_PASSWORD must be at least 12 characters');
  const problem = passwordProblem(password, phone);
  if (problem) throw new Error(`PLATFORM_ADMIN_PASSWORD is refused (${problem}): choose one that is harder to guess`);

  const created = await client.query(
    `insert into users (id, phone, full_name, password_hash, is_platform_admin)
     values (gen_random_uuid(), $1, 'Platform Admin', $2, true)
     on conflict (phone) do nothing`,
    [phone, await hash(password)],
  );
  console.log(created.rowCount ? `Platform admin created: ${phone}` : 'Platform admin already exists.');
}

/**
 * The way back from a lost password or authenticator. Issues a one-time password, clears two-factor
 * sign-in and signs out every device, in one transaction so a failure leaves the account as it was.
 */
export async function resetPlatformAdmin(client: pg.Client, rawPhone?: string) {
  const { rows } = await client.query<{ id: string; phone: string }>(
    `select id, phone from users where is_platform_admin ${rawPhone ? 'and phone = $1' : ''}`,
    rawPhone ? [normalizePhone(rawPhone)] : [],
  );
  if (rows.length === 0) throw new Error('No platform admin has this phone.');
  if (rows.length > 1) throw new Error(`Several admins exist, so name one: ${rows.map((row) => row.phone).join(', ')}`);
  const [admin] = rows;

  const oneTimePassword = randomBytes(12).toString('base64url');
  const passwordHash = await hash(oneTimePassword);
  await client.query('begin');
  try {
    await client.query(
      `update users set password_hash = $2, must_change_password = true, status = 'active',
         totp_enabled = false, totp_secret = null, totp_last_step = null where id = $1`,
      [admin.id, passwordHash],
    );
    await client.query('delete from recovery_codes where user_id = $1', [admin.id]);
    await client.query('delete from sign_in_failures where phone = $1', [admin.phone]);
    await client.query('update refresh_tokens set revoked_at = now() where user_id = $1 and revoked_at is null', [admin.id]);
    await client.query(`insert into platform_audit (id, action, target_id) values (gen_random_uuid(), 'reset-admin command', $1)`, [admin.id]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
  return { phone: admin.phone, oneTimePassword };
}
