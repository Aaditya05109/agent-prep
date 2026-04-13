import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SYSTEM_PROMPT = `You are AgentPrep — an academic study assistant for students aged 10–18.

RULES:
1. Only generate content directly related to academic study and education.
2. If the input is not academic study material (song lyrics, personal messages, inappropriate content), respond with: {"error": "non_academic", "message": "Please paste actual study notes or textbook content."}
3. Never generate violent, sexual, discriminatory or inappropriate content.
4. Prioritise accuracy. If unsure about a fact, flag it rather than guessing.
5. Keep language age-appropriate and clear.
6. Always return only the JSON format requested — no markdown fences, no extra text.`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { prompt, userId } = req.body;
    if (!prompt || !userId) return res.status(400).json({ error: 'Missing prompt or userId' });

    // Check user plan and generation count
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('plan, generations_used, generations_reset_at')
      .eq('id', userId)
      .single();

    if (profileError) return res.status(401).json({ error: 'User not found' });

    // Reset monthly count if needed
    const now = new Date();
    const resetAt = new Date(profile.generations_reset_at);
    let generationsUsed = profile.generations_used;

    if (now.getMonth() !== resetAt.getMonth() || now.getFullYear() !== resetAt.getFullYear()) {
      generationsUsed = 0;
      await supabase.from('profiles').update({
        generations_used: 0,
        generations_reset_at: now.toISOString()
      }).eq('id', userId);
    }

    // Enforce free tier limit
    if (profile.plan === 'free' && generationsUsed >= 2) {
      return res.status(403).json({ error: 'limit_reached', message: 'Free limit reached. Upgrade to Pro to continue.' });
    }

    // Call Claude Haiku
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const claudeData = await claudeRes.json();
    if (claudeData.error) return res.status(500).json({ error: claudeData.error.message });

    const text = claudeData.content?.[0]?.text || '';

    // Check for non-academic refusal
    try {
      const parsed = JSON.parse(text);
      if (parsed.error === 'non_academic') {
        return res.status(400).json(parsed);
      }
    } catch {}

    // Increment generation count
    await supabase.from('profiles')
      .update({ generations_used: generationsUsed + 1 })
      .eq('id', userId);

    res.status(200).json({ text, generationsUsed: generationsUsed + 1, plan: profile.plan });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
