import { createClient } from '@supabase/supabase-js';

const PAYPAL_PLAN_TO_TIER = {
  'P-67A60544K5870822LNL4VK5I': 'pro',
  'P-6X7146173Y739354RNMBYIZY': 'clinic',
  'P-6GS168829G298301JNMBYNCQ': 'enterprise'
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (!token) {
      return res.status(401).json({ error: 'Please log in before linking a subscription.' });
    }

    const { subscriptionID } = req.body || {};
    if (!subscriptionID) {
      return res.status(400).json({ error: 'Missing PayPal subscriptionID.' });
    }

    const supabaseUrl = process.env.SUPABASE_URL || 'https://nrwhpxkwxgdsiwbvplsx.supabase.co';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const paypalClientId = process.env.PAYPAL_CLIENT_ID;
    const paypalSecret = process.env.PAYPAL_SECRET;

    if (!supabaseServiceKey || !paypalClientId || !paypalSecret) {
      return res.status(500).json({ error: 'Missing Supabase or PayPal environment variables in Vercel.' });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid or expired session.' });
    }

    // 1. Authenticate with PayPal Live API
    const basicAuth = Buffer.from(`${paypalClientId}:${paypalSecret}`).toString('base64');
    const tokenRes = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });

    if (!tokenRes.ok) {
      return res.status(502).json({ error: 'Could not authenticate with PayPal API.' });
    }
    const { access_token } = await tokenRes.json();

    // 2. Verify subscription status and plan_id with PayPal
    const subRes = await fetch(`https://api-m.paypal.com/v1/billing/subscriptions/${encodeURIComponent(subscriptionID)}`, {
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!subRes.ok) {
      return res.status(400).json({ error: 'Could not verify PayPal subscription ID.' });
    }

    const subData = await subRes.json();
    const validStatuses = ['ACTIVE', 'APPROVED'];
    if (!validStatuses.includes(subData.status)) {
      return res.status(403).json({ error: `Subscription is not active (status: ${subData.status}).` });
    }

    const assignedTier = PAYPAL_PLAN_TO_TIER[subData.plan_id];
    if (!assignedTier) {
      return res.status(400).json({ error: `Unrecognized PayPal plan ID: ${subData.plan_id}` });
    }

    // 3. Unlock the paid tier in Supabase, store PayPal subscription ID, and reset 30-day cycle
    const nowIso = new Date().toISOString();
    const { error: updateError } = await supabaseAdmin
      .from('profiles')
      .update({
        plan: assignedTier,
        paypal_subscription_id: subscriptionID,
        monthly_reports_used: 0,
        billing_cycle_start: nowIso,
        updated_at: nowIso
      })
      .eq('id', user.id);

    if (updateError) {
      return res.status(500).json({ error: 'Failed to update profile plan in Supabase.' });
    }

    return res.status(200).json({ success: true, plan: assignedTier });
  } catch (err) {
    console.error('PayPal sync error:', err);
    return res.status(500).json({ error: 'Server error verifying PayPal subscription.' });
  }
}
