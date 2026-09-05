import {Webhook} from 'svix';
import type {WebhookEvent} from '@clerk/nextjs/server';

export async function POST(request: Request) {
  const wh = new Webhook(process.env.CLERK_WEBHOOK_SECRET!);
  const event = wh.verify(await request.text(), {}) as WebhookEvent;

  if (event.type === 'user.created') {
    // create the user
  }

  return new Response('', {status: 200});
}
