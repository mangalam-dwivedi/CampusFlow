module.exports = function handler(_request, response) {
  response.setHeader('Cache-Control', 'no-store');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return response.status(503).json({
      error: 'Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY in the deployment environment.',
    });
  }

  return response.status(200).json({ supabaseUrl, supabaseAnonKey });
};
