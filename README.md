# CampusFlow

CampusFlow is a static HTML app served by Vercel, with Supabase Auth and Postgres for account-scoped data and a Vercel function that calls Gemini. Provider secrets stay on the server.

## Set up Supabase

1. Create a Supabase project.
2. In **SQL Editor**, run [`supabase/schema.sql`](./supabase/schema.sql).
3. Copy the project URL and the project's **anon / publishable key** from **Project Settings → API**.
4. In **Authentication → Providers → Email**, configure email sign-in. For production, set the site URL and redirect URLs to your Vercel domain.

The `user_data` table uses row-level security so authenticated users can only read or update their own record.

## Set up Gemini

Create a Gemini API key in Google AI Studio. The key is used only by the Vercel API function; do not add it to the HTML or expose it as a `NEXT_PUBLIC_*` or `VITE_*` variable.

## Run locally

Install the Vercel CLI if needed, copy `.env.example` to `.env.local`, and fill in the Supabase URL, anon key, and Gemini API key:

```sh
npx vercel dev
```

The app and its `/api` functions need to be served together. Opening `index.html` directly as a `file://` URL will not work.

## Deploy to Vercel

Import this folder as a Vercel project (no build command or output directory is required), then add these **Project → Settings → Environment Variables**:

| Variable | Required | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_ANON_KEY` | Yes | Supabase anon / publishable key |
| `GEMINI_API_KEY` | Yes | Server-side Gemini API key |
| `GEMINI_MODEL` | No | Gemini model; defaults to `gemini-2.5-flash` |

Set the variables for the appropriate deployment environments and redeploy. The app requires users to sign in; if their account has no saved record yet, the current browser's existing CampusFlow data is copied into that account on first sign-in.

## Data and privacy

CampusFlow saves the app state as JSON in the user's Supabase row and keeps a browser copy. Uploaded images are sent to Gemini only when the user requests analysis; small source thumbnails may be retained with AI activity records. AI requests require a valid Supabase session. Avoid uploading sensitive personal information.
