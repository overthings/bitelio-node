import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(request: Request) {
  const event = stripe.webhooks.constructEvent(
    await request.text(),
    request.headers.get('stripe-signature')!,
    process.env.STRIPE_WEBHOOK_SECRET!,
  );
  return Response.json({type: event.type});
}
