import { createClient } from '@supabase/supabase-js';

const DOWNGRADE_EVENTS = new Set([
  'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.EXPIRED',
  'BILLING.SUBSCRIPTION.SUSPENDED'
]);

const PLAN_ID_TO_TIER = {
  'P-67A60544K5870822LNL4VK5I': 'pro',
  'P-6X7146173Y739354RNMBYIZY': 'clinic',
  'P-6GS168829G298301JNMBYNCQ': 'enterprise'
};

async function getPayPalAccessToken(clientId, secret) {
  const auth = Buffer.from(`${clientId}:${secret}`).toString('base64');
  const res = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`PayPal token error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return data.access_token;
}

async function verifyPayPalWebhookSignature(req, webhookId, clientId, secret) {
  if (!webhookId) {
    return true;
  }

  const accessToken = await getPayPalAccessToken(clientId, secret);
  const verifyRes = await fetch('https://api-m.paypal.com/v1/notifications/verify-webhook-signature', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      auth_algo: req.headers['paypal-auth-algo'],
      cert_url: req.headers['paypal-cert-url'],
      transmission_id: req.headers['paypal-transmission-id'],
      transmission_sig: req.headers['paypal-transmission-sig'],
      transmission_time: req.headers['paypal-transmission-time'],
      webhook_id: webhookId,
      webhook_event: req.body
    })
  });

  if (!verifyRes.ok) {
    return false;
  }

  const verifyData = await verifyRes.json();
  return verifyData.verification_status === 'SUCCESS';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL || 'https://nrwhpxkwxgdsiwbvplsx.supabase.co';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const paypalClientId = process.env.PAYPAL_CLIENT_ID;
    const paypalSecret = process.env.PAYPAL_SECRET;
    const paypalWebhookId = process.env.PAYPAL_WEBHOOK_ID;

    if (!supabaseServiceKey || !paypalClientId || !paypalSecret) {
      return res.status(500).json({ error: 'Missing required server environment variables.' });
    }

    const isValid = await verifyPayPalWebhookSignature(
      req,
      paypalWebhookId,
      paypalClientId,
      paypalSecret
    );

    if (!isValid) {
      return res.status(401).json({ error: 'Invalid PayPal webhook signature.' });
    }

    const event = req.body || {};
    const eventType = event.event_type || '';
    const resource = event.resource || {};
    const subscriptionId = resource.id || '';
    const subscriberEmail = (resource.subscriber?.email_address || '').trim().toLowerCase();

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    if (DOWNGRADE_EVENTS.has(eventType)) {
      let updatedRows = [];

      if (subscriptionId) {
        const { data, error } = await supabaseAdmin
          .from('profiles')
          .update({
            plan: 'free',
            updated_at: new Date().toISOString()
          })
          .eq('paypal_subscription_id', subscriptionId)
          .select('id, email, plan');

        if (error) {
          console.error('Supabase downgrade by subscription ID failed:', error.message);
        } else if (Array.isArray(data) && data.length > 0) {
          updatedRows = data;
        }
      }

      if (updatedRows.length === 0 && subscriberEmail) {
        const { data, error } = await supabaseAdmin
          .from('profiles')
          .update({
            plan: 'free',
            updated_at: new Date().toISOString()
          })
          .ilike('email', subscriberEmail)
          .select('id, email, plan');

        if (error) {
          console.error('Supabase downgrade by email failed:', error.message);
        } else if (Array.isArray(data)) {
          updatedRows = data;
        }
      }

      return res.status(200).json({
        received: true,
        event_type: eventType,
        downgraded_users: updatedRows.length
      });
    }

    if (eventType === 'BILLING.SUBSCRIPTION.ACTIVATED' || eventType === 'BILLING.SUBSCRIPTION.RE-ACTIVATED') {
      const mappedPlan = PLAN_ID_TO_TIER[resource.plan_id];
      if (mappedPlan && subscriptionId) {
        await supabaseAdmin
          .from('profiles')
          .update({
            plan: mappedPlan,
            paypal_subscription_id: subscriptionId,
            updated_at: new Date().toISOString()
          })
          .eq('paypal_subscription_id', subscriptionId);
      }
    }

    return res.status(200).json({ received: true, event_type: eventType });
  } catch (err) {
    console.error('PayPal webhook error:', err);
    return res.status(500).json({ error: 'Webhook processing failed: ' + err.message });
  }
}
