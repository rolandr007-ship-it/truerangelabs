import { createClient } from '@supabase/supabase-js';

export const config = {
  maxDuration: 60,
  api: {
    bodyParser: {
      sizeLimit: '12mb'
    }
  }
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
      const { data: inserted } = await supabaseAdmin
        .from('profiles')
        .insert({ id: user.id, email: user.email, plan: 'free', free_reports_used: 0 })
        .select('*')
        .single();
      profile = inserted || { plan: 'free', free_reports_used: 0 };
    }

    if (profile.plan !== 'pro' && (profile.free_reports_used || 0) >= 1) {
      return res.status(403).json({
        error: 'You have used your 1 free lab report. Upgrade to TrueRange Pro ($19/mo) for unlimited analyses.'
      });
    }

    const { fileBase64, mimeType } = req.body || {};
    if (!fileBase64) {
      return res.status(400).json({ error: 'No file received. Please select a PDF or photo.' });
    }

    const prompt = `You are a preventative medicine and clinical biomarker analyst.
Extract every lab biomarker from the attached lab report.
Return ONLY valid JSON matching this exact structure (no markdown, no extra text):
{
  "summary": "2-3 sentence plain-English overview highlighting optimal markers and any suboptimal or out-of-range markers.",
  "biomarkers": [
    {
      "name": "Biomarker Name",
      "category": "Body System (e.g. Metabolic, Thyroid, Iron Stores, Lipids, Vitamins)",
      "value": "Measured value with unit",
      "standardRange": "Lab standard reference range",
      "optimalRange": "Preventative functional longevity target range",
      "status": "Optimal or Suboptimal or Out of Range",
      "explanation": "1-2 sentence plain-English explanation of what this result means."
    }
  ]
}`;

    // Active multimodal Gemini models with automatic retry on temporary 503 spikes
    const models = [
      'gemini-3.8-flash',
      'gemini-3.8-flash',
      'gemini-3.5-flash',
      'gemini-3.1-flash-lite',
      'gemini-3-flash-preview'
    ];
    let parsedResult = null;
    let lastError = '';

    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      if (i > 0) {
        await new Promise((r) => setTimeout(r, 1500));
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 45000);

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
                temperature: 0.2,
                responseMimeType: 'application/json'
              }
            })
          }
        );

        clearTimeout(timeoutId);

        if (!geminiResponse.ok) {
          const errText = await geminiResponse.text();
          lastError = `${model} (${geminiResponse.status}): ${errText.slice(0, 160)}`;
          console.error('Gemini model failed:', lastError);
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
        lastError = `${model}: ${modelErr.message}`;
        console.error('Gemini exception:', lastError);
      }
    }

    if (!parsedResult || !Array.isArray(parsedResult.biomarkers)) {
      return res.status(502).json({
        error: `AI service is temporarily busy. Please tap Select Lab PDF or Photo to try again (${lastError}).`
      });
    }

    if (profile.plan !== 'pro') {
      await supabaseAdmin
        .from('profiles')
        .update({
          free_reports_used: (profile.free_reports_used || 0) + 1,
          updated_at: new Date().toISOString()
        })
        .eq('id', user.id);
    }

    return res.status(200).json(parsedResult);
  } catch (err) {
    console.error('Analyze error:', err);
    return res.status(500).json({ error: 'Server error analyzing report: ' + err.message });
  }
}
