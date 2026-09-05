import type {NextApiRequest, NextApiResponse} from 'next';
import Stripe from 'stripe';

export const config = {api: {bodyParser: false}};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const event = stripe.webhooks.constructEvent(
    await buffer(req),
    req.headers['stripe-signature'] as string,
    process.env.STRIPE_WEBHOOK_SECRET!,
  );

  if (event.type === 'checkout.session.completed') {
    // grant access
  }

  res.json({received: true});
}
