# CampusFlow

CampusFlow is a static HTML app served by Vercel, with anonymous Supabase Auth and Postgres for demo-session data and a Vercel function that calls Gemini. Provider secrets stay on the server. There is no user-facing sign-in.

## Set up Supabase

1. Create a Supabase project.
2. In **SQL Editor**, run [`supabase/schema.sql`](./supabase/schema.sql).
3. Copy the project URL and the project's **anon / publishable key** from **Project Settings → API**.
4. In **Authentication** settings, enable **Anonymous Sign-Ins**. The app creates an anonymous session automatically; email sign-up and confirmation links are not used.

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

Set the variables for the appropriate deployment environments and redeploy. The app automatically creates an anonymous session and saves data to that session, so no sign-in page or email confirmation is needed. If a browser already has local CampusFlow data, it is copied to its first anonymous session. Clearing browser site data loses access to that session's cloud record.

## Data and privacy

CampusFlow saves the app state as JSON in the anonymous session's Supabase row and keeps a browser copy. Uploaded images are sent to Gemini only when the user requests analysis; small source thumbnails may be retained with AI activity records. AI requests require the app's anonymous Supabase session.
