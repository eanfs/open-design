import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createTcpServer } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AuroraLedgerResponseSchema, AuroraWalletSchema } from '@open-design/aurora-contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { createAuroraApp } from '../src/app.js';
import {
  createAuroraSessionStore,
  upsertAuroraAccount,
  type AuroraPrincipal,
} from '../src/auth/session-store.js';
import type { AuroraConfig } from '../src/config.js';
import {
  AuroraLedgerError,
  createAuroraLedgerService,
  getAuroraWallet,
  listAuroraLedgerEntries,
  rebuildWalletsFromLedger,
} from '../src/commerce/ledger.js';

const SESSION_COOKIE = '__Host-aurora_session';

async function reservePort(): Promise<number> {
  const probe = createTcpServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function closeServer(server: Server): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.close((error) => (error ? reject(error) : resolve()));
  return promise;
}

async function readWalletRow(
  pool: Pool,
  accountId: string,
): Promise<{ availableCredits: string; reservedCredits: string }> {
  const result = await pool.query<{ available_credits: string; reserved_credits: string }>(
    'SELECT available_credits, reserved_credits FROM wallets WHERE account_id = $1',
    [accountId],
  );
  const row = result.rows[0];
  return {
    availableCredits: row?.available_credits ?? '0.00',
    reservedCredits: row?.reserved_credits ?? '0.00',
  };
}

describe('Aurora credit ledger', () => {
  let pool: Pool;
  let container: StartedPostgreSqlContainer;
  let appServer: Server;
  let appOrigin: string;
  let config: AuroraConfig;
  let accountCounter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withStartupTimeout(120_000)
      .start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    // 002-commerce.sql stays reserved for Task 4 (Stripe commerce); the ledger
    // tests only need the auth tables plus the credit schema.
    for (const file of ['001-auth.sql', '003-ledger.sql']) {
      const migration = await readFile(new URL(`../src/migrations/${file}`, import.meta.url), 'utf8');
      await pool.query(migration);
    }
    const appPort = await reservePort();
    appOrigin = `http://127.0.0.1:${appPort}`;
    config = {
      host: '127.0.0.1',
      port: appPort,
      publicOrigin: appOrigin,
      oidc: {
        issuer: 'https://aurora-oidc.invalid',
        clientId: 'aurora-web',
        clientSecret: 'aurora-secret',
      },
      sessionTtlSeconds: 3600,
      loginStateTtlSeconds: 600,
      loginStateSigningSecret: 'test-signing-secret',
    };
    appServer = createAuroraApp({ db: pool, config }).listen(config.port, config.host);
    await new Promise<void>((resolve) => appServer.once('listening', resolve));
  }, 120_000);

  afterAll(async () => {
    if (appServer) await closeServer(appServer);
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  async function createAccount(): Promise<AuroraPrincipal> {
    accountCounter += 1;
    return await upsertAuroraAccount(pool, {
      issuer: 'https://aurora-oidc.invalid',
      subject: `ledger-user-${accountCounter}`,
      email: `ledger-user-${accountCounter}@example.com`,
      displayName: `Ledger User ${accountCounter}`,
    });
  }

  /** Test-only funding that mirrors what the Task 4 Stripe webhook will do. */
  async function fundWallet(accountId: string, amount: string): Promise<void> {
    await pool.query(
      `INSERT INTO ledger_entries (account_id, kind, direction, amount)
       VALUES ($1, 'topup', 'credit', $2)`,
      [accountId, amount],
    );
    await rebuildWalletsFromLedger(pool);
  }

  it('serializes concurrent reservations so only one succeeds when funds run out', async () => {
    const account = await createAccount();
    const ledger = createAuroraLedgerService(pool);
    await fundWallet(account.accountId, '10.00');

    const results = await Promise.allSettled([
      ledger.reserveCredits(account.accountId, 'run:req-1', '8.00'),
      ledger.reserveCredits(account.accountId, 'run:req-2', '8.00'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((result) => result.status === 'rejected');
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect((reason as AuroraLedgerError).code).toBe('aurora_insufficient_credits');
    expect((reason as AuroraLedgerError).status).toBe(402);

    expect(await readWalletRow(pool, account.accountId)).toEqual({
      availableCredits: '2.00',
      reservedCredits: '8.00',
    });
  });

  it('rejects a duplicate reservation key without double-reserving', async () => {
    const account = await createAccount();
    const ledger = createAuroraLedgerService(pool);
    await fundWallet(account.accountId, '20.00');

    const results = await Promise.allSettled([
      ledger.reserveCredits(account.accountId, 'run:duplicate', '3.00'),
      ledger.reserveCredits(account.accountId, 'run:duplicate', '3.00'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as
      | PromiseRejectedResult
      | undefined;
    expect(rejected?.reason).toBeInstanceOf(AuroraLedgerError);
    expect((rejected?.reason as AuroraLedgerError).code).toBe('aurora_reservation_conflict');
    expect((rejected?.reason as AuroraLedgerError).status).toBe(409);

    expect(await readWalletRow(pool, account.accountId)).toEqual({
      availableCredits: '17.00',
      reservedCredits: '3.00',
    });
  });

  it('rejects reserving more than the available balance', async () => {
    const account = await createAccount();
    const ledger = createAuroraLedgerService(pool);
    await fundWallet(account.accountId, '5.00');

    await expect(ledger.reserveCredits(account.accountId, 'run:too-much', '6.00')).rejects.toThrow(
      AuroraLedgerError,
    );

    expect(await readWalletRow(pool, account.accountId)).toEqual({
      availableCredits: '5.00',
      reservedCredits: '0.00',
    });
  });

  it('moves balances through reserve, settle, and release and rejects double transitions', async () => {
    const account = await createAccount();
    const ledger = createAuroraLedgerService(pool);
    await fundWallet(account.accountId, '10.00');

    await ledger.reserveCredits(account.accountId, 'run:settle', '4.00');
    expect(await readWalletRow(pool, account.accountId)).toEqual({
      availableCredits: '6.00',
      reservedCredits: '4.00',
    });

    await ledger.reserveCredits(account.accountId, 'run:release', '2.00');
    expect(await readWalletRow(pool, account.accountId)).toEqual({
      availableCredits: '4.00',
      reservedCredits: '6.00',
    });

    await ledger.settleReservation('run:settle');
    expect(await readWalletRow(pool, account.accountId)).toEqual({
      availableCredits: '4.00',
      reservedCredits: '2.00',
    });

    await ledger.releaseReservation('run:release');
    expect(await readWalletRow(pool, account.accountId)).toEqual({
      availableCredits: '6.00',
      reservedCredits: '0.00',
    });

    await expect(ledger.settleReservation('run:settle')).rejects.toMatchObject({
      code: 'aurora_reservation_closed',
    });
    await expect(ledger.releaseReservation('run:release')).rejects.toMatchObject({
      code: 'aurora_reservation_closed',
    });
    await expect(ledger.settleReservation('run:missing')).rejects.toMatchObject({
      code: 'aurora_reservation_not_found',
    });
  });

  it('rejects non-positive and malformed amounts', async () => {
    const account = await createAccount();
    const ledger = createAuroraLedgerService(pool);
    await fundWallet(account.accountId, '10.00');

    await expect(ledger.reserveCredits(account.accountId, 'run:zero', '0.00')).rejects.toThrow();
    await expect(ledger.reserveCredits(account.accountId, 'run:negative', '-1.00')).rejects.toThrow();
    await expect(
      ledger.reserveCredits(account.accountId, 'run:precision', '1.234'),
    ).rejects.toThrow();
    await expect(
      ledger.reserveCredits(account.accountId, 'run:numeric', 'abc'),
    ).rejects.toThrow();

    expect(await readWalletRow(pool, account.accountId)).toEqual({
      availableCredits: '10.00',
      reservedCredits: '0.00',
    });
  });

  it('keeps ledger entries immutable against update, delete, and truncate', async () => {
    const account = await createAccount();
    await fundWallet(account.accountId, '1.00');

    await expect(
      pool.query("UPDATE ledger_entries SET amount = 999.99 WHERE kind = 'topup'"),
    ).rejects.toThrow(/immutable/i);
    await expect(pool.query('DELETE FROM ledger_entries WHERE true')).rejects.toThrow(/immutable/i);
    await expect(pool.query('TRUNCATE ledger_entries')).rejects.toThrow(/immutable/i);
  });

  it('rebuilds wallets from the ledger for offline audits', async () => {
    const account = await createAccount();
    const ledger = createAuroraLedgerService(pool);
    await fundWallet(account.accountId, '12.00');
    await ledger.reserveCredits(account.accountId, 'run:rb-1', '5.00');
    await ledger.settleReservation('run:rb-1');
    await ledger.reserveCredits(account.accountId, 'run:rb-2', '3.00');
    const before = await readWalletRow(pool, account.accountId);
    expect(before).toEqual({ availableCredits: '4.00', reservedCredits: '3.00' });

    await pool.query('UPDATE wallets SET available_credits = 0, reserved_credits = 0');
    await rebuildWalletsFromLedger(pool);

    expect(await readWalletRow(pool, account.accountId)).toEqual(before);
  });

  it('requires an authenticated session for wallet and ledger routes', async () => {
    for (const path of ['/api/aurora/wallet', '/api/aurora/ledger']) {
      const response = await fetch(`${appOrigin}${path}`);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: 'aurora_unauthenticated', status: 401 });
    }
  });

  it('serves contract-only wallet and ledger DTOs for the authenticated account', async () => {
    const account = await createAccount();
    const other = await createAccount();
    const ledger = createAuroraLedgerService(pool);
    await fundWallet(account.accountId, '10.00');
    await ledger.reserveCredits(account.accountId, 'run:route', '4.00');

    const store = createAuroraSessionStore(pool, { ttlSeconds: config.sessionTtlSeconds });
    const sessionToken = await store.create(account, {
      accessToken: null,
      refreshToken: null,
      idToken: null,
      expiresAt: null,
    });
    const headers = { cookie: `${SESSION_COOKIE}=${sessionToken}` };

    const walletResponse = await fetch(`${appOrigin}/api/aurora/wallet`, { headers });
    expect(walletResponse.status).toBe(200);
    expect(AuroraWalletSchema.parse(await walletResponse.json())).toEqual({
      availableCredits: '6.00',
      reservedCredits: '4.00',
    });

    const ledgerResponse = await fetch(`${appOrigin}/api/aurora/ledger`, { headers });
    expect(ledgerResponse.status).toBe(200);
    const entries = AuroraLedgerResponseSchema.parse(await ledgerResponse.json());
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ amount: '10.00', direction: 'credit' });
    expect(entries[1]).toMatchObject({ amount: '4.00', direction: 'debit' });
    expect(entries[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    const rawBody = JSON.stringify(entries);
    expect(rawBody).not.toContain('reservation_key');
    expect(rawBody).not.toContain('kind');

    const otherSession = await store.create(other, {
      accessToken: null,
      refreshToken: null,
      idToken: null,
      expiresAt: null,
    });
    const otherLedger = await fetch(`${appOrigin}/api/aurora/ledger`, {
      headers: { cookie: `${SESSION_COOKIE}=${otherSession}` },
    });
    expect(AuroraLedgerResponseSchema.parse(await otherLedger.json())).toEqual([]);

    const directRead = await getAuroraWallet(pool, account.accountId);
    expect(directRead).toEqual({ availableCredits: '6.00', reservedCredits: '4.00' });
    const serviceEntries = await listAuroraLedgerEntries(pool, account.accountId);
    expect(serviceEntries).toHaveLength(2);
  });
});
