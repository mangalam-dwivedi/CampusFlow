const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES = 8;
const MAX_TEXT_CHARS = 30000;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

module.exports = async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'Method not allowed.' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!supabaseUrl || !supabaseAnonKey || !apiKey) {
    return response.status(503).json({ error: 'AI service is not configured on the server.' });
  }

  const token = (request.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return response.status(401).json({ error: 'Sign in to use the AI service.' });

  try {
    const authResponse = await fetch(`${supabaseUrl.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${token}` },
    });
    if (!authResponse.ok) return response.status(401).json({ error: 'Your session is invalid or expired. Sign in again.' });

    const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
    if (!body || (typeof body.input !== 'string' && !Array.isArray(body.input))) {
      return response.status(400).json({ error: 'A text prompt or conversation is required.' });
    }
    if (Array.isArray(body.input) && body.input.some(turn =>
      !turn || !['user', 'assistant'].includes(turn.role) || typeof turn.content !== 'string')) {
      return response.status(400).json({ error: 'Conversation turns must have a user or assistant role and text content.' });
    }

    const promptText = Array.isArray(body.input)
      ? body.input.map(turn => turn && typeof turn.content === 'string' ? turn.content : '').join('')
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

    const imageParts = images.map(image => {
      if (!image || !ALLOWED_IMAGE_TYPES.has(image.mimeType) || typeof image.data !== 'string' ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) {
        throw new Error('An attached image has an unsupported format.');
      }
      return { inlineData: { mimeType: image.mimeType, data: image.data } };
    });

    const contents = Array.isArray(body.input)
      ? body.input.map(turn => ({
          role: turn.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: String(turn.content || '').slice(0, MAX_TEXT_CHARS) }],
        }))
      : [{ role: 'user', parts: [{ text: body.input }] }];
    if (imageParts.length) {
      const lastUser = [...contents].reverse().find(turn => turn.role === 'user');
      if (lastUser) lastUser.parts.push(...imageParts);
      else contents.push({ role: 'user', parts: imageParts });
    }

    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const aiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents }),
      },
    );
    const result = await aiResponse.json().catch(() => ({}));
    if (!aiResponse.ok) {
      console.error('Gemini request failed:', aiResponse.status, result.error?.message || 'Unknown provider error');
      return response.status(502).json({ error: 'The AI provider could not complete the request. Check the server logs and provider quota.' });
    }
    const text = (result.candidates?.[0]?.content?.parts || [])
      .map(part => part.text || '')
      .join('');
    if (!text) return response.status(502).json({ error: 'The AI provider returned an empty response.' });
    return response.status(200).json({ text });
  } catch (error) {
    if (error instanceof SyntaxError) return response.status(400).json({ error: 'Request body must be valid JSON.' });
    console.error('AI route error:', error);
    if (error instanceof TypeError) return response.status(502).json({ error: 'Could not reach the authentication or AI service. Try again shortly.' });
    return response.status(400).json({ error: error.message || 'Invalid AI request.' });
  }
};
