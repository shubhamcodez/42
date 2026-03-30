# 42 is the answer to everything (Formerly JARVIS)

Assistant that can chat, control the **desktop** (screenshot + vision + pyautogui—including your on-screen browser), run **sandboxed Python**, optional **host shell** (opt-in), and **market data / analysis** via **yfinance** (finance agent). Routes via a supervisor LLM; supports OpenAI and xAI (Grok).

---

## Core idea: self-improving agents through evals

The agent improves over time by **looping through evals** and turning results into **prompt and code changes**:

1. **Trace every run** — Each chat and agent run is logged (provider, route, success, tokens, errors) to `jarvis-observability/traces/`.
2. **Generate evals from logs** — An LLM turns recent traces into multi-turn evaluation cases (coherence, task completion). Stored in `jarvis-observability/evals/`.
3. **Run evals for all models** — Each case is run with both OpenAI and xAI; optional LLM judge scores replies. Pass@1 per model is recorded.
4. **Optimization step** — Aggregates trace stats + eval pass rates, then asks an LLM for:
   - **Prompt modification instructions**: what to add or change in the supervisor, desktop, coding, shell, finance, or chat prompts (with reasons).
   - **Code addition suggestions**: which file and what logic/code to add (e.g. retries, validation), with reasons.

You (or a future automation layer) apply those instructions and suggestions; the next runs and evals reflect the improvements. So: **evals → scores → optimization → prompt/code suggestions → apply → better agents**.

---

## Memory architecture (planned)
Supermemory launches an opensource 98% memory retrieval success framework.

---

## Google Sign-In for Calendar + Gmail (multi-user)

This app now includes a backend OAuth scaffold so each user can connect their own
Google account from **Settings → Google Calendar + Gmail access**.

Required backend environment variables:

- `GOOGLE_OAUTH_CLIENT_ID` - Google OAuth Web client id
- `GOOGLE_OAUTH_CLIENT_SECRET` - Google OAuth Web client secret

Put `.env` at the **repo root** (same folder as `backend/`), e.g. `E:\Socrates\.env`. The backend loads that file automatically. To use a different path, set `JARVIS_DOTENV_PATH` to the full path of your env file.

Example `.env` entries (names must match exactly):

```
GOOGLE_OAUTH_CLIENT_ID="your-google-web-client-id.apps.googleusercontent.com"
GOOGLE_OAUTH_CLIENT_SECRET="your-google-web-client-secret"
```

Optional variables:

- `GOOGLE_OAUTH_REDIRECT_URI` (default: `http://localhost:5173/api/auth/google/callback`)
- `GOOGLE_OAUTH_FRONTEND_URL` (default: `http://localhost:5173`)
- `GOOGLE_OAUTH_SCOPES` (default includes openid/email/profile + Calendar + Gmail read scope)
- `GOOGLE_OAUTH_STORE_PATH` (default: `.secrets/google-oauth-store.json`)
- `GOOGLE_OAUTH_COOKIE_SECURE` (`true` for HTTPS-only cookies in production)

Google Cloud setup notes:

1. Create an OAuth **Web application** client (not Desktop).
2. Add **Authorized redirect URIs** that match what the backend sends (must match **exactly**, including `http` vs `https` and `localhost` vs `127.0.0.1`):
   - Default dev: `http://localhost:5173/api/auth/google/callback`
   - If you open the UI at `127.0.0.1`, also add: `http://127.0.0.1:5173/api/auth/google/callback`
   - Or set `GOOGLE_OAUTH_REDIRECT_URI` to your chosen URL and add that same value in GCP.
3. Enable Google Calendar API and Gmail API for your project.
4. For external users, publish the OAuth consent screen.

### Error `redirect_uri_mismatch`

Google rejects the login when the redirect URI in the request is not listed on the Web client. Open **Settings** in the app and use **Copy** next to the redirect URI shown there, then paste it into GCP **Authorized redirect URIs** and save.
