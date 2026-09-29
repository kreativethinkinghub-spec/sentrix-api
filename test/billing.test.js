import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import express from 'express';
import { TIERS, priceFor } from '../db/paystack.js';
import billingRouter from '../routes/billing.js';

const EXPECTED_PRICES = {
  solo: 4988,
  practice: 14988,
  boutique: 34988,
  growth: 158388,
};

let baseUrl;
let server;
let previousSecret;
let previousPublicKey;

before(async () => {
  previousSecret = process.env.PAYSTACK_SECRET_KEY;
  previousPublicKey = process.env.PAYSTACK_PUBLIC_KEY;
  delete process.env.PAYSTACK_SECRET_KEY;
  delete process.env.PAYSTACK_PUBLIC_KEY;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 'user-test', org_id: 'org-test', is_org_admin: true };
    next();
  });
  app.use('/api/billing', billingRouter);

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (previousSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
  else process.env.PAYSTACK_SECRET_KEY = previousSecret;
  if (previousPublicKey === undefined) delete process.env.PAYSTACK_PUBLIC_KEY;
  else process.env.PAYSTACK_PUBLIC_KEY = previousPublicKey;
});

async function postSubscribe(body) {
  const response = await fetch(`${baseUrl}/api/billing/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, json: await response.json() };
}

test('tier catalogue matches the annual-only commercial model', () => {
  assert.deepEqual(Object.keys(TIERS), [
    'solo', 'practice', 'boutique', 'professional', 'growth', 'command', 'sovereign',
  ]);

  for (const [tier, annual] of Object.entries(EXPECTED_PRICES)) {
    assert.equal(TIERS[tier].annual, annual);
    assert.equal(TIERS[tier].purchase_mode, 'self_service');
    assert.equal('monthly' in TIERS[tier], false);
    assert.equal(priceFor(tier, 'annual'), annual);
    assert.equal(priceFor(tier, 'monthly'), null);
  }

  assert.equal(TIERS.professional.purchase_mode, 'contact');
  assert.equal(TIERS.command.purchase_mode, 'invoice');
  assert.equal(TIERS.sovereign.purchase_mode, 'contact');
  for (const tier of ['professional', 'command', 'sovereign']) {
    assert.equal(priceFor(tier, 'annual'), null);
  }
});

test('GET /api/billing/plans exposes only annual billing and preserves assisted tiers', async () => {
  const response = await fetch(`${baseUrl}/api/billing/plans`);
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.currency, 'ZAR');
  assert.deepEqual(json.billing_cycles, ['annual']);
  assert.deepEqual(
    Object.fromEntries(Object.entries(json.tiers).map(([tier, plan]) => [tier, plan.purchase_mode])),
    {
      solo: 'self_service',
      practice: 'self_service',
      boutique: 'self_service',
      professional: 'contact',
      growth: 'self_service',
      command: 'invoice',
      sovereign: 'contact',
    }
  );
  assert.equal(Object.values(json.tiers).some((plan) => 'monthly' in plan), false);
});

test('POST /api/billing/subscribe rejects monthly instead of coercing it', async () => {
  const { response, json } = await postSubscribe({ tier: 'solo', billing_cycle: 'monthly' });

  assert.equal(response.status, 400);
  assert.match(json.error, /annual-only/);
});

test('POST /api/billing/subscribe defaults an omitted cycle to annual', async () => {
  const { response, json } = await postSubscribe({ tier: 'solo' });

  assert.equal(response.status, 503);
  assert.match(json.error, /not configured/);
});

test('POST /api/billing/subscribe preserves invoice and contact-only tiers', async (t) => {
  const cases = [
    ['professional', /contact sales/],
    ['command', /invoice-led/],
    ['sovereign', /contact sales/],
  ];

  for (const [tier, expectedError] of cases) {
    await t.test(tier, async () => {
      const { response, json } = await postSubscribe({ tier, billing_cycle: 'annual' });
      assert.equal(response.status, 400);
      assert.match(json.error, expectedError);
    });
  }
});

test('an annual self-service tier reaches the payment-provider configuration gate', async () => {
  const { response, json } = await postSubscribe({ tier: 'growth', billing_cycle: 'annual' });

  assert.equal(response.status, 503);
  assert.match(json.error, /not configured/);
});
