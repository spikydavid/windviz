# Windviz

Full-stack JavaScript starter with an Express API in `server` and a Vite frontend in `client`.

This version includes a Strava integration flow so the app can connect to a Strava athlete account and load recent activities through the backend.

## Scripts

- `npm install`: install all workspace dependencies
- `npm run dev`: run the Express server and Vite client together
- `npm run build`: build the frontend for production
- `npm run start`: start the Express API

## Project structure

- `client`: browser frontend built with Vite
- `server`: Express backend API

## API endpoints

- `GET /api/health`: simple health response
- `GET /api/message`: sample payload used by the frontend
- `GET /api/strava/status`: current Strava configuration and connection state
- `GET /api/strava/connect`: starts the Strava OAuth flow
- `GET /api/strava/callback`: handles the OAuth callback from Strava
- `GET /api/strava/activities`: returns recent activities for the connected athlete
- `POST /api/strava/disconnect`: clears the current Strava session

## Strava setup

1. Copy `.env.example` to `.env` in the workspace root.
2. Create a Strava API application in the Strava developer settings.
3. Fill in `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET` in `.env`.
4. Generate a 32-byte encryption key, for example with `openssl rand -hex 32`, and set it as `SESSION_ENCRYPTION_KEY` in `.env`.
5. Set the Strava authorization callback to `http://localhost:5173/api/strava/callback`.
6. Run `npm run dev` and open the frontend.

The backend keeps the Strava token in a local persisted session store at `.data/sessions.json` tied to a cookie, and the stored Strava payload is encrypted with `SESSION_ENCRYPTION_KEY`, so Strava sessions survive server restarts during development without writing plaintext tokens to disk. That is still not durable or secure enough for production and should be replaced with a proper server-side session store or encrypted credential storage.

## Development

Run `npm run dev` from the workspace root. The frontend uses Vite's `/api` proxy to reach the Express server on port 3000 during development.