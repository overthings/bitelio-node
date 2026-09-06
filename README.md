# bitelio

Official Node.js client for the [Bitelio](https://bitelio.com) email API. Zero runtime
dependencies, ESM and CommonJS, Node 20+.

```bash
npm i bitelio
```

## `npx bitelio init`

The package also ships a command. It signs you in the way `gh` and `docker login` do — a short code
you approve in a browser, nothing pasted at a shell prompt — then gives you a project and a **test
key** to put in your `.env`.

```bash
npx bitelio init
```

A test key does everything a live one does and stops before the provider, so your first send works
straight away and reaches nobody. Re-running is safe: it reuses the project and keeps the key you
already wrote down.

For a scripted run: `--project <id>` picks the project without asking, and `--yes` takes the default
where there is one. With projects already on the account and neither flag, it refuses rather than
guesses — writing drafted emails into somebody's live project is not a thing to get wrong quietly.

It reads your repository first, and stops before touching your account if this is not a stack it
understands — Next.js and Stripe, for now. `--dry-run` does that part and nothing else: it shows
exactly which files it would upload, how large each one is, how many secrets it redacted from each,
and what it could not find. Nothing leaves your machine, and no account is needed.

    npx bitelio init --dry-run

Before any upload it shows the same list and waits. You can read any file exactly as it would be
sent, drop any of them — it tells you which events that costs you — or walk away. It will not
upload without a person saying yes, so this half does not run in CI at all.

Then it shows you the lifecycle it found and the emails it would write, and asks again. Only after
that second yes does it generate anything.

What it does to your repository, and what it will not do:

- **A branch of its own, from `HEAD`.** With uncommitted changes it stops before doing anything —
  so whatever it makes, `git branch -D bitelio-init` throws all of it away.
- **It runs your tests before and after.** A check that was already failing stays failing and the
  pull request says so; a check that passed and now fails means the patch is **undone** and you are
  put back where you were. Repositories with a red test on main are common, and a tool that could
  never open a pull request for one — or that blamed itself for a failure it did not cause — would
  be useless on half of them.
- **No key goes in the pull request.** Only the variable name and a placeholder. The test key is
  printed once in your terminal, for your local `.env`, because a test key committed into production
  configuration is an app that deploys, runs, records every send and delivers none of them.
- **If `gh` is missing the branch stays.** It prints the compare URL instead of throwing away work
  because the last optional step could not run.

## Your first email, without touching DNS

Every Bitelio send normally comes from a domain you have verified. There is one shared address you
can use immediately, so you can see this work before doing any DNS:

```ts
import {Bitelio} from 'bitelio';

const bitelio = new Bitelio(process.env.BITELIO_API_KEY!);

await bitelio.emails.send({
  from: 'onboarding@send.bitelio.com',
  to: 'you@yourcompany.com',   // must be your own account address
  subject: 'Hello from Bitelio',
  body: '<p>It works.</p>',
});
```

The shared sender proves **your code works**. It does not prove your deliverability — the mail
leaves a domain that is not yours, so it exercises none of your SPF, DKIM or reputation. It writes
only to members of your own project, fifty times a day. [Verify your own
domain](https://docs.bitelio.com/guides/verifying-domains) before you send to anyone real.

## Test keys

A key is minted `sk_live_…` or `sk_test_…`. A test key does everything a live one does — same
endpoints, same rendering, same consent and link checks, same record in your history — and stops
before delivery. It costs nothing and counts towards no limit.

Test mode is about **sending, not data**: a test key writes real contacts and fires your real
workflows in the same project. That is what makes it useful for checking an onboarding flow, and
it is not isolation. Use a separate project if you need that.

## Reading what you sent

```ts
const page = await bitelio.emails.list({status: 'BOUNCED', limit: 50});

for (const email of page.data) {
  console.log(email.to, email.error);
}
```

Page by handing `nextCursor` back verbatim, or let the client do it:

```ts
for await (const email of bitelio.emails.iterate({status: 'BOUNCED'})) {
  console.log(email.to, email.error);
}
```

`emails.get(id)` returns one send **including the HTML that actually went out**, after variables
were substituted and your brand applied. That is the call that answers "the email looked wrong".

Test sends are hidden unless you ask: `mode: 'test'` or `mode: 'all'`.

## Contacts and events

```ts
await bitelio.contacts.create({email: 'jane@example.com', data: {plan: 'pro'}});

await bitelio.events.track({
  event: 'trial.started',
  email: 'jane@example.com',
  data: {plan: 'pro'},
});
```

`events.track` is what triggers a workflow, so it is the call a SaaS makes from its own lifecycle
code. Values in `data` are saved onto the contact; wrap one as `{value: 'x', persistent: false}` to
pass it to this event only.

## Verifying webhooks

```ts
import express from 'express';
import {webhooks} from 'bitelio';

app.post('/webhooks/bitelio', express.raw({type: 'application/json'}), (req, res) => {
  const ok = webhooks.verify({
    payload: req.body,                            // the RAW body, not a parsed object
    signature: req.header('Bitelio-Signature')!,
    timestamp: req.header('Bitelio-Timestamp')!,
    secret: process.env.BITELIO_WEBHOOK_SECRET!,
  });

  if (!ok) return res.sendStatus(400);

  const event = JSON.parse(req.body.toString('utf8'));
  // …
  res.sendStatus(200);
});
```

**Use the raw body.** `JSON.parse` then `JSON.stringify` reorders keys and changes whitespace, and
the signature covers bytes. This is the single most common reason verification fails.

## Errors

Every failure is a `BitelioError`:

```ts
import {BitelioError} from 'bitelio';

try {
  await bitelio.emails.send({/* … */});
} catch (error) {
  if (error instanceof BitelioError) {
    console.error(error.status, error.code, error.message);
    console.error('request id:', error.requestId);   // quote this in support
  }
}
```

`status` is `0` when the request never reached the API at all — DNS, a refused connection, or the
client's own timeout.

## Retries and idempotency

429 and 5xx responses are retried twice by default, with jittered exponential backoff, honouring
`Retry-After`. 4xx is never retried: a 403 retried three times is a 403 three times slower.

`emails.send` generates an `Idempotency-Key` for every call and reuses it across those retries.
Without that, the retry would be a duplicate in somebody's inbox. Pass your own `idempotencyKey`
when the natural unit of work is not one call — the same order confirmation retried across two
processes, say.

## Options

```ts
new Bitelio(apiKey, {
  baseUrl: 'https://api.bitelio.com',  // point at your own deployment if self-hosted
  timeoutMs: 30_000,                    // per attempt
  maxRetries: 2,                        // 0 turns retries off
  fetch: myFetch,                       // a proxying fetch, or a stub in tests
});
```

## What is not here

Campaigns, segments, templates and workflows. They are designed in the dashboard, and an SDK that
covered everything on day one would be an SDK with half its surface unused and all of it frozen.
The REST API has them: [docs.bitelio.com](https://docs.bitelio.com/api-reference/overview).

## Licence

MIT
