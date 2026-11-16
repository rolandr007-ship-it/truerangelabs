
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    if (req.headers.authorization) {
      const token = req.headers.authorization.replace('Bearer ', '').trim();
      const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
      if (error || !user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const { subscriptionID } = req.body;
      if (!subscriptionID) {
        return res.status(400).json({ error: 'Missing PayPal subscriptionID' });
      }

      await supabaseAdmin
        .from('profiles')
        .upsert({
          id: user.id,
          email: user.email,
          plan: 'pro',
          paypal_subscription_id: subscriptionID,
          updated_at: new Date().toISOString()
        });

      return res.status(200).json({ status: 'unlocked', plan: 'pro' });
    }

    const event = req.body;
    const eventType = event?.event_type;
    const subId = event?.resource?.id;

    if (subId && (
      eventType === 'BILLING.SUBSCRIPTION.CANCELLED' ||
      eventType === 'BILLING.SUBSCRIPTION.SUSPENDED' ||
      eventType === 'BILLING.SUBSCRIPTION.EXPIRED'
    )) {
      await supabaseAdmin
        .from('profiles')
        .update({ plan: 'free', updated_at: new Date().toISOString() })
        .eq('paypal_subscription_id', subId);
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('PayPal sync error:', err);
    return res.status(500).json({ error: 'Subscription sync failed' });
  }
}
