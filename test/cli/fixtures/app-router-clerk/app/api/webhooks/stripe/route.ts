import {headers} from 'next/headers';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(request: Request) {
  const body = await request.text();
  const signature = (await headers()).get('stripe-signature')!;

  const event = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET!);

  switch (event.type) {
    case 'customer.subscription.created':
      break;
    case 'invoice.payment_failed':
      break;
    case 'customer.subscription.deleted':
      break;
  }

  return Response.json({received: true});
}
