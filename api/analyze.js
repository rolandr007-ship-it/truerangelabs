import { createClient } from '@supabase/supabase-js';

export const config = {
  maxDuration: 60,
  api: {
    bodyParser: {
      sizeLimit: '12mb'
    }
  }
};

const PLAN_LIMITS = {
  pro: 40,
  clinic: 150,
  enterprise: 500
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (!token) {
      return res.status(401).json({ error: 'Please log in or create a free account to analyze your lab report.' });
    }

    const supabaseUrl = process.env.SUPABASE_URL || 'https://nrwhpxkwxgdsiwbvplsx.supabase.co';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const geminiApiKey = process.env.GEMINI_API_KEY;

    if (!supabaseServiceKey || !geminiApiKey) {
      return res.status(500).json({ error: 'Server environment variables are missing in Vercel.' });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }

    let { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (!profile) {
      const nowIso = new Date().toISOString();
      const { data: inserted } = await supabaseAdmin
        .from('profiles')
        .insert({
          id: user.id,
          email: user.email,
          plan: 'free',
          free_reports_used: 0,
          monthly_reports_used: 0,
          billing_cycle_start: nowIso
        })
        .select('*')
        .single();
      profile = inserted || {
        plan: 'free',
        free_reports_used: 0,
        monthly_reports_used: 0,
        billing_cycle_start: nowIso
      };
    }

    const userPlan = (profile.plan || 'free').toLowerCase();
    const monthlyLimit = PLAN_LIMITS[userPlan];
    let currentMonthlyUsage = profile.monthly_reports_used || 0;
    let cycleStartIso = profile.billing_cycle_start || new Date().toISOString();

    if (monthlyLimit) {
      const now = new Date();
      const cycleStart = profile.billing_cycle_start ? new Date(profile.billing_cycle_start) : now;
      const daysElapsed = (now - cycleStart) / (1000 * 60 * 60 * 24);

      if (!profile.billing_cycle_start || daysElapsed >= 30) {
        currentMonthlyUsage = 0;
        cycleStartIso = now.toISOString();
        await supabaseAdmin
          .from('profiles')
          .update({
            monthly_reports_used: 0,
            billing_cycle_start: cycleStartIso,
            updated_at: cycleStartIso
          })
          .eq('id', user.id);
      }

      if (currentMonthlyUsage >= monthlyLimit) {
        let upgradeNote = 'Contact support@truerangelabs.com to increase your custom Enterprise volume limit.';
        if (userPlan === 'pro') {
          upgradeNote = 'Upgrade to Clinic ($299/mo for 150 reports) or Enterprise ($799/mo for 500 reports).';
        } else if (userPlan === 'clinic') {
          upgradeNote = 'Upgrade to Enterprise ($799/mo for 500 reports) or contact support@truerangelabs.com.';
        }

        return res.status(429).json({
          error: `You have reached your ${monthlyLimit}-report monthly limit. ${upgradeNote}`
        });
      }
    } else if ((profile.free_reports_used || 0) >= 1) {
      return res.status(403).json({
        error: 'You have used your 1 free lab report. Upgrade to TrueRange Pro ($19/mo) for personal use, Clinic ($299/mo), or Enterprise ($799/mo).'
      });
    }

    const { fileBase64, mimeType } = req.body || {};
    if (!fileBase64) {
      return res.status(400).json({ error: 'No file received. Please select a PDF or photo.' });
    }

    const prompt = `Extract all clinical lab biomarkers from this lab report and compare each against preventative functional longevity ranges.
Return ONLY valid JSON matching this schema (keep explanations concise, 1 sentence each):
{
  "summary": "2-sentence overview highlighting optimal markers and any suboptimal or out-of-range markers.",
  "biomarkers": [
    {
      "name": "Biomarker Name",
      "category": "System (e.g. Metabolic, Thyroid, Iron, Lipids, Vitamins, CBC)",
      "value": "Measured value + unit",
      "standardRange": "Lab standard range",
      "optimalRange": "Functional longevity optimal range",
      "status": "Optimal or Suboptimal or Out of Range",
      "explanation": "Concise 1-sentence plain-English takeaway."
    }
  ]
}`;

    // Active fast multimodal Gemini models with automatic fallback
    const models = [
      'gemini-3.5-flash-lite',
      'gemini-3.5-flash',
      'gemini-3.8-flash',
      'gemini-3.1-flash-lite'
    ];

    let parsedResult = null;
    const errors = [];

    for (const model of models) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 14000);

      try {
        const geminiResponse = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    { text: prompt },
                    {
                      inlineData: {
                        mimeType: mimeType || 'application/pdf',
                        data: fileBase64
                      }
                    }
                  ]
                }
              ],
              generationConfig: {
                maxOutputTokens: 4096,
                responseMimeType: 'application/json'
              }
            })
          }
        );

        clearTimeout(timeoutId);

        if (!geminiResponse.ok) {
          const errText = await geminiResponse.text();
          const summaryErr = `${model} (${geminiResponse.status})`;
          errors.push(summaryErr);
          console.error('Gemini model failed:', summaryErr, errText.slice(0, 200));
          continue;
        }

        const geminiJson = await geminiResponse.json();
        const rawText = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const cleanedJson = rawText.replace(/```json|```/gi, '').trim();
        parsedResult = JSON.parse(cleanedJson);

        if (parsedResult && Array.isArray(parsedResult.biomarkers)) {
          break;
        }
      } catch (modelErr) {
        clearTimeout(timeoutId);
        const summaryErr = modelErr.name === 'AbortError' ? `${model} (timeout)` : `${model} (${modelErr.message})`;
        errors.push(summaryErr);
        console.error('Gemini exception:', summaryErr);
      }
    }

    if (!parsedResult || !Array.isArray(parsedResult.biomarkers)) {
      return res.status(502).json({
        error: `AI service is temporarily busy (${errors.join(', ')}). Please tap Select Lab PDF or Photo to try again.`
      });
    }

    const updatedAt = new Date().toISOString();

    if (monthlyLimit) {
      await supabaseAdmin
        .from('profiles')
        .update({
          monthly_reports_used: currentMonthlyUsage + 1,
          billing_cycle_start: cycleStartIso,
          updated_at: updatedAt
        })
        .eq('id', user.id);
    } else {
      await supabaseAdmin
        .from('profiles')
        .update({
          free_reports_used: (profile.free_reports_used || 0) + 1,
          updated_at: updatedAt
        })
        .eq('id', user.id);
    }

    return res.status(200).json(parsedResult);
  } catch (err) {
    console.error('Analyze error:', err);
    return res.status(500).json({ error: 'Server error analyzing report: ' + err.message });
  }
}
