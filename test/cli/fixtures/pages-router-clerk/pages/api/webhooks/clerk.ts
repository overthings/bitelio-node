import {Webhook} from 'svix';

export default async function handler(req, res) {
  const wh = new Webhook(process.env.CLERK_WEBHOOK_SECRET);
  const event = wh.verify(JSON.stringify(req.body), req.headers);
  if (event.type === 'user.created') { /* … */ }
  res.status(200).end();
}
