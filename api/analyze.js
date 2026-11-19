import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '12mb'
    }
  }
};

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
        .select()
        .single();
      profile = inserted;
    }

    if (profile.plan !== 'pro' && profile.free_reports_used >= 1) {
      return res.status(403).json({
        error: 'You have used your 1 free lab report. Upgrade to TrueRange Pro ($19/month) below for unlimited PDF & photo uploads.',
        upgradeRequired: true
      });
    }

    const { fileBase64, mimeType, fileName } = req.body;
    if (!fileBase64 || !mimeType) {
      return res.status(400).json({ error: 'Missing lab file data.' });
    }

    const prompt = `You are a functional longevity & clinical lab biomarker parser for TrueRange Labs.
Extract all visible lab biomarkers from the attached lab report (${fileName || 'uploaded file'}).
For each biomarker found, compare the measured value against BOTH:
1. Standard clinical lab reference range (as shown on the report or standard medical convention)
2. Functional / Longevity Optimal range (tighter preventative health target)

Return ONLY valid JSON matching this exact structure (no markdown backticks):
{
  "summary": "2-sentence plain-English overview of key findings and optimal vs suboptimal markers.",
  "biomarkers": [
    {
      "name": "Biomarker Name (e.g., Ferritin)",
      "category": "Short System Tag (e.g., Iron Stores & Energy)",
      "value": "Measured numeric value + unit (e.g., 28 ng/mL)",
      "standardRange": "Standard lab range (e.g., 15 – 150 ng/mL)",
      "optimalRange": "Functional optimal range (e.g., 50 – 120 ng/mL)",
      "status": "Optimal" | "Suboptimal" | "Out of Range",
      "explanation": "1-2 clear, non-diagnostic sentences explaining what this level means and practical questions to ask a clinician."
    }
  ]
}`;

                    const models = [
      'gemini-3.8-flash',
      'gemini-3.8-flash-lite',
      'gemini-2.5-flash-lite',
      'gemini-3-flash-preview'
    ];

    for (let i = 0; i < models.length; i++) {
      try {
        response = await ai.models.generateContent({
          model: models[i],
          contents: [
            {
              inlineData: {
                data: fileBase64,
                mimeType: mimeType
              }
            },
            prompt
          ],
          config: {
            responseMimeType: 'application/json',
            abortSignal: AbortSignal.timeout(25000)
          }
        });
        break;
      } catch (err) {
        if (i < models.length - 1) {
          await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
          continue;
        }
        throw err;
      }
    }


        const cleanText = response.text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleanText);

    if (profile.plan !== 'pro') {
      await supabaseAdmin
        .from('profiles')
        .update({ free_reports_used: (profile.free_reports_used || 0) + 1 })
        .eq('id', user.id);
    }

    return res.status(200).json({
      ...parsed,
      plan: profile.plan,
      freeReportsRemaining: profile.plan === 'pro' ? 'Unlimited' : 0
    });
  } catch (err) {
    console.error('Analyze error:', err);
    return res.status(500).json({ error: 'Failed to parse lab report. Please ensure the PDF or photo is legible and under 10MB.' });
  }
}

