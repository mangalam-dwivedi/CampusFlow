const crypto = require('crypto');

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES = 8;
const MAX_TEXT_CHARS = 30000;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const GEMINI_KEY_RE = /^AIza[0-9A-Za-z_-]{30,60}$/;
const ATTEMPT_TIMEOUT_MS = 25000;
const MAX_ATTEMPTS = 6;

/* Best-effort protections. Serverless instances are short-lived, so these are per-instance,
   but they still stop one heavy user from draining the shared free quota. */
const USER_LIMIT_PER_HOUR = Number(process.env.AI_USER_HOURLY_LIMIT) || 30;
const hits = new Map();
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 150;

function overUserLimit(userId) {
  const now = Date.now();
  const recent = (hits.get(userId) || []).filter(t => now - t < 3600 * 1000);
  if (recent.length >= USER_LIMIT_PER_HOUR) { hits.set(userId, recent); return true; }
  recent.push(now);
  hits.set(userId, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < 3600 * 1000)) hits.delete(k);
  return false;
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > CACHE_TTL_MS) { cache.delete(key); return null; }
  return hit.text;
}
function cacheSet(key, text) {
  cache.set(key, { t: Date.now(), text });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/* Order of attempts: the student's own Gemini key, then the server's Gemini key(s)
   (GEMINI_API_KEY may hold several keys separated by commas), each on the main model and
   then a lighter fallback model (free quotas are tracked per model), then Groq. */
function buildAttempts(userKey, hasImages) {
  const models = [...new Set([
    process.env.GEMINI_MODEL || 'gemini-flash-latest',
    process.env.GEMINI_FALLBACK_MODEL || 'gemini-flash-lite-latest',
  ])];
  const serverKeys = (process.env.GEMINI_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
  const start = serverKeys.length ? Math.floor(Math.random() * serverKeys.length) : 0;
  const rotated = serverKeys.slice(start).concat(serverKeys.slice(0, start));

  const keys = [];
  if (userKey) keys.push({ key: userKey, own: true });
  rotated.forEach(key => keys.push({ key, own: false }));

  const gemini = [];
  for (const k of keys) for (const model of models) gemini.push({ provider: 'gemini', key: k.key, model, own: k.own });

  const groqKey = process.env.GROQ_API_KEY;
  const groqModel = hasImages ? process.env.GROQ_VISION_MODEL : (process.env.GROQ_MODEL || 'openai/gpt-oss-120b');
  const groq = groqKey && groqModel ? [{ provider: 'groq', key: groqKey, model: groqModel }] : [];

  /* Keep Groq reachable even when there are many Gemini keys. */
  return gemini.slice(0, MAX_ATTEMPTS - groq.length).concat(groq);
}

async function callGemini(attempt, contents) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(attempt.model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': attempt.key },
      body: JSON.stringify({ contents }),
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, status: res.status, message: data.error?.message || 'Unknown provider error' };
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  return text ? { ok: true, text } : { ok: false, status: 502, message: 'Empty response (possibly blocked)' };
}

async function callGroq(attempt, input, images) {
  const turns = Array.isArray(input)
    ? input.map(t => ({ role: t.role, content: String(t.content || '').slice(0, MAX_TEXT_CHARS) }))
    : [{ role: 'user', content: input }];
  if (images.length) {
    const lastUser = [...turns].reverse().find(t => t.role === 'user') || turns[turns.length - 1];
    lastUser.content = [
      { type: 'text', text: lastUser.content },
      ...images.map(i => ({ type: 'image_url', image_url: { url: `data:${i.mimeType};base64,${i.data}` } })),
    ];
  }
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${attempt.key}` },
    body: JSON.stringify({ model: attempt.model, messages: turns, temperature: 0.2 }),
    signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, status: res.status, message: data.error?.message || 'Unknown provider error' };
  const text = data.choices?.[0]?.message?.content || '';
  return text ? { ok: true, text } : { ok: false, status: 502, message: 'Empty response' };
}

module.exports = async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'Method not allowed.' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  const userKeyHeader = String(request.headers['x-user-gemini-key'] || '').trim();
  const userKey = GEMINI_KEY_RE.test(userKeyHeader) ? userKeyHeader : '';
  const anyProvider = process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY || userKey;
  if (!supabaseUrl || !supabaseAnonKey || !anyProvider) {
    return response.status(503).json({ error: 'AI service is not configured on the server.' });
  }

  const token = (request.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return response.status(401).json({ error: 'The demo session is missing. Reload the page and try again.' });

  try {
    const authResponse = await fetch(`${supabaseUrl.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${token}` },
    });
    if (!authResponse.ok) return response.status(401).json({ error: 'The demo session is invalid or expired. Reload the page and try again.' });
    const user = await authResponse.json().catch(() => ({}));

    const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
    if (!body || (typeof body.input !== 'string' && !Array.isArray(body.input))) {
      return response.status(400).json({ error: 'A text prompt or conversation is required.' });
    }
    if (Array.isArray(body.input) && body.input.some(turn =>
      !turn || !['user', 'assistant'].includes(turn.role) || typeof turn.content !== 'string')) {
      return response.status(400).json({ error: 'Conversation turns must have a user or assistant role and text content.' });
    }

    const promptText = Array.isArray(body.input)
      ? body.input.map(turn => (turn && typeof turn.content === 'string' ? turn.content : '')).join('')
      : body.input;
    if (!promptText.trim() || promptText.length > MAX_TEXT_CHARS) {
      return response.status(400).json({ error: `Prompt must be between 1 and ${MAX_TEXT_CHARS} characters.` });
    }

    const images = body.images || [];
    if (!Array.isArray(images) || images.length > MAX_IMAGES) {
      return response.status(400).json({ error: `Attach no more than ${MAX_IMAGES} images at a time.` });
    }
    const requestBytes = Buffer.byteLength(JSON.stringify(body));
    if (requestBytes > MAX_REQUEST_BYTES) {
      return response.status(413).json({ error: 'The request is too large. Try fewer or smaller images.' });
    }
    const cleanImages = images.map(image => {
      if (!image || !ALLOWED_IMAGE_TYPES.has(image.mimeType) || typeof image.data !== 'string' ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) {
        throw new Error('An attached image has an unsupported format.');
      }
      return { mimeType: image.mimeType, data: image.data };
    });

    /* Repeated identical text prompts are answered from a short-lived cache. */
    const cacheKey = cleanImages.length ? null : crypto.createHash('sha256').update(JSON.stringify(body.input)).digest('hex');
    if (cacheKey) {
      const cached = cacheGet(cacheKey);
      if (cached) return response.status(200).json({ text: cached, provider: 'cache' });
    }

    /* Students using their own key do not touch the shared quota, so they are not limited. */
    if (!userKey && user.id && overUserLimit(user.id)) {
      return response.status(429).json({
        code: 'user_limit',
        error: `You have reached the hourly AI limit (${USER_LIMIT_PER_HOUR}). Try again later, or add your own free Gemini key in Preferences for unlimited use.`,
      });
    }

    const contents = Array.isArray(body.input)
      ? body.input.map(turn => ({
          role: turn.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: String(turn.content || '').slice(0, MAX_TEXT_CHARS) }],
        }))
      : [{ role: 'user', parts: [{ text: body.input }] }];
    if (cleanImages.length) {
      const parts = cleanImages.map(i => ({ inlineData: { mimeType: i.mimeType, data: i.data } }));
      const lastUser = [...contents].reverse().find(turn => turn.role === 'user');
      if (lastUser) lastUser.parts.push(...parts);
      else contents.push({ role: 'user', parts });
    }

    const attempts = buildAttempts(userKey, cleanImages.length > 0);
    if (!attempts.length) return response.status(503).json({ error: 'AI service is not configured on the server.' });

    let sawQuota = false;
    for (const attempt of attempts) {
      let result;
      try {
        result = attempt.provider === 'gemini'
          ? await callGemini(attempt, contents)
          : await callGroq(attempt, body.input, cleanImages);
      } catch (error) {
        result = { ok: false, status: 0, message: error.name === 'TimeoutError' ? 'Timed out' : 'Network error' };
      }
      if (result.ok) {
        if (cacheKey) cacheSet(cacheKey, result.text);
        const provider = attempt.provider === 'gemini' ? (attempt.own ? 'gemini-own' : 'gemini') : 'groq';
        return response.status(200).json({ text: result.text, provider });
      }
      if (result.status === 429) sawQuota = true;
      console.error(`AI attempt failed [${attempt.provider}/${attempt.model}${attempt.own ? '/own-key' : ''}]:`, result.status, result.message);
    }

    if (sawQuota) {
      return response.status(429).json({
        code: 'quota',
        error: 'The free AI quota is used up for now. Try again in a minute, or add your own free Gemini key in Preferences.',
      });
    }
    return response.status(502).json({ error: 'The AI provider could not complete the request. Check the server logs and provider quota.' });
  } catch (error) {
    if (error instanceof SyntaxError) return response.status(400).json({ error: 'Request body must be valid JSON.' });
    console.error('AI route error:', error);
    if (error instanceof TypeError) return response.status(502).json({ error: 'Could not reach the authentication or AI service. Try again shortly.' });
    return response.status(400).json({ error: error.message || 'Invalid AI request.' });
  }
};
