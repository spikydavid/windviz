import crypto from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'

import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'

dotenv.config({
  path: fileURLToPath(new URL('../../.env', import.meta.url)),
})

const app = express()
const port = Number(process.env.PORT || 3000)
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173'
const sessionCookieName = 'windviz_session'
const sessionTtlMs = 30 * 24 * 60 * 60 * 1000
const stravaAuthorizeUrl = 'https://www.strava.com/oauth/authorize'
const stravaTokenUrl = 'https://www.strava.com/oauth/token'
const stravaApiBaseUrl = 'https://www.strava.com/api/v3'
const sessionStorePath = fileURLToPath(new URL('../../.data/sessions.json', import.meta.url))
const sessions = loadSessions()

app.use(cors({ origin: frontendUrl, credentials: true }))
app.use(express.json())

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    service: 'windviz-api',
    timestamp: new Date().toISOString(),
  })
})

app.get('/api/message', (_request, response) => {
  response.json({
    title: 'Express backend is running',
    message: 'The frontend is connected to the Node.js API.',
  })
})

app.get('/api/strava/status', async (request, response) => {
  const config = getStravaConfig()
  const session = getSession(request)
  const isConnected = Boolean(session?.strava)

  response.json({
    configured: config.configured,
    connected: isConnected,
    athlete: session?.strava?.athlete || null,
    expiresAt: session?.strava?.expiresAt || null,
    scopes: session?.strava?.scope ? session.strava.scope.split(',') : [],
    message: config.configured
      ? isConnected
        ? 'Strava account connected.'
        : 'Connect your Strava account to load activities.'
      : 'Add STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET to .env.',
  })
})

app.get('/api/strava/connect', (request, response) => {
  const config = getStravaConfig()

  if (!config.configured) {
    response.status(503).json({
      error: 'Strava is not configured.',
      message: 'Set STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, and STRAVA_REDIRECT_URI in .env.',
    })
    return
  }

  const session = ensureSession(request, response)
  const state = crypto.randomUUID()

  session.oauthState = state
  persistSessions()

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: 'read,activity:read_all',
    state,
  })

  response.redirect(`${stravaAuthorizeUrl}?${params.toString()}`)
})

app.get('/api/strava/callback', async (request, response) => {
  const config = getStravaConfig()
  const session = getSession(request)
  const state = request.query.state
  const error = request.query.error
  const code = request.query.code

  if (!config.configured) {
    response.redirect(`${frontendUrl}?strava=error&reason=config`)
    return
  }

  if (!session || !session.oauthState || session.oauthState !== state) {
    response.redirect(`${frontendUrl}?strava=error&reason=state`)
    return
  }

  if (error) {
    delete session.oauthState
    persistSessions()
    response.redirect(`${frontendUrl}?strava=error&reason=${encodeURIComponent(error)}`)
    return
  }

  if (!code) {
    delete session.oauthState
    persistSessions()
    response.redirect(`${frontendUrl}?strava=error&reason=missing_code`)
    return
  }

  try {
    const tokenPayload = await exchangeToken({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: 'authorization_code',
    })

    session.strava = normalizeStravaToken(tokenPayload)
    delete session.oauthState
    session.updatedAt = Date.now()
    persistSessions()

    response.redirect(`${frontendUrl}?strava=connected`)
  } catch (tokenError) {
    delete session.oauthState
    persistSessions()
    response.redirect(`${frontendUrl}?strava=error&reason=token_exchange`)
  }
})

app.get('/api/strava/activities', async (request, response) => {
  const config = getStravaConfig()
  const session = getSession(request)

  if (!config.configured) {
    response.status(503).json({
      error: 'Strava is not configured.',
    })
    return
  }

  if (!session?.strava) {
    response.status(401).json({
      error: 'No Strava account connected.',
    })
    return
  }

  try {
    const token = await getValidAccessToken(session, config)
    const perPage = clampNumber(request.query.perPage, 1, 30, 10)
    const activitiesResponse = await fetch(
      `${stravaApiBaseUrl}/athlete/activities?per_page=${perPage}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    )

    if (!activitiesResponse.ok) {
      const detail = await safeReadText(activitiesResponse)

      if (activitiesResponse.status === 401) {
        delete session.strava
        session.updatedAt = Date.now()
        persistSessions()
      }

      response.status(activitiesResponse.status).json({
        error: 'Failed to fetch activities from Strava.',
        detail,
      })
      return
    }

    const activities = await activitiesResponse.json()

    response.json({
      activities: activities.map(mapActivity),
    })
  } catch (activityError) {
    response.status(500).json({
      error: 'Unexpected Strava activity fetch failure.',
      detail: activityError instanceof Error ? activityError.message : String(activityError),
    })
  }
})

app.post('/api/strava/disconnect', (request, response) => {
  const session = getSession(request)

  if (session) {
    delete session.oauthState
    delete session.strava
    session.updatedAt = Date.now()
    persistSessions()
  }

  response.json({ ok: true })
})

app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`)
})

function getStravaConfig() {
  const clientId = process.env.STRAVA_CLIENT_ID || ''
  const clientSecret = process.env.STRAVA_CLIENT_SECRET || ''
  const redirectUri = process.env.STRAVA_REDIRECT_URI || `${frontendUrl}/api/strava/callback`

  return {
    clientId,
    clientSecret,
    redirectUri,
    configured: Boolean(clientId && clientSecret),
  }
}

function parseCookies(cookieHeader = '') {
  return cookieHeader
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean)
    .reduce((allCookies, cookiePart) => {
      const separatorIndex = cookiePart.indexOf('=')

      if (separatorIndex === -1) {
        return allCookies
      }

      const key = cookiePart.slice(0, separatorIndex)
      const value = cookiePart.slice(separatorIndex + 1)

      allCookies[key] = decodeURIComponent(value)
      return allCookies
    }, {})
}

function getSession(request) {
  const cookies = parseCookies(request.headers.cookie)
  const sessionId = cookies[sessionCookieName]

  if (!sessionId) {
    return null
  }

  return getSessionById(sessionId)
}

function ensureSession(request, response) {
  const cookies = parseCookies(request.headers.cookie)
  let sessionId = cookies[sessionCookieName]

  if (!sessionId || !getSessionById(sessionId)) {
    sessionId = crypto.randomUUID()
    sessions.set(sessionId, createSessionRecord())
    persistSessions()
    response.setHeader('Set-Cookie', serializeCookie(sessionCookieName, sessionId))
  }

  return sessions.get(sessionId)
}

function serializeCookie(name, value) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=2592000',
  ].join('; ')
}

async function exchangeToken(parameters) {
  const tokenResponse = await fetch(stravaTokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(parameters),
  })

  if (!tokenResponse.ok) {
    throw new Error(await safeReadText(tokenResponse))
  }

  return tokenResponse.json()
}

function normalizeStravaToken(payload) {
  return {
    athlete: payload.athlete
      ? {
          id: payload.athlete.id,
          firstName: payload.athlete.firstname,
          lastName: payload.athlete.lastname,
        }
      : null,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: payload.expires_at,
    scope: payload.scope || '',
    tokenType: payload.token_type || 'Bearer',
  }
}

async function getValidAccessToken(session, config) {
  const expiresSoon = !session.strava.expiresAt || session.strava.expiresAt <= Math.floor(Date.now() / 1000) + 60

  if (!expiresSoon) {
    return session.strava.accessToken
  }

  const refreshed = await exchangeToken({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: session.strava.refreshToken,
  })

  session.strava = normalizeStravaToken({
    ...refreshed,
    athlete: session.strava.athlete,
    scope: refreshed.scope || session.strava.scope,
  })
  session.updatedAt = Date.now()
  persistSessions()

  return session.strava.accessToken
}

function clampNumber(value, minimum, maximum, fallback) {
  const parsed = Number(value)

  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)))
}

function mapActivity(activity) {
  return {
    id: activity.id,
    name: activity.name,
    type: activity.type,
    sportType: activity.sport_type,
    distanceMeters: activity.distance,
    movingTimeSeconds: activity.moving_time,
    elapsedTimeSeconds: activity.elapsed_time,
    totalElevationGain: activity.total_elevation_gain,
    startDateLocal: activity.start_date_local,
    timezone: activity.timezone,
    averageSpeed: activity.average_speed,
    maxSpeed: activity.max_speed,
    kilojoules: activity.kilojoules,
    kudosCount: activity.kudos_count,
    achievementCount: activity.achievement_count,
  }
}

async function safeReadText(response) {
  try {
    return await response.text()
  } catch {
    return 'Unable to read response body.'
  }
}

function createSessionRecord() {
  const now = Date.now()

  return {
    createdAt: now,
    updatedAt: now,
  }
}

function getSessionById(sessionId) {
  pruneExpiredSessions()

  const session = sessions.get(sessionId)

  return session || null
}

function loadSessions() {
  if (!existsSync(sessionStorePath)) {
    return new Map()
  }

  try {
    const raw = readFileSync(sessionStorePath, 'utf8')
    const parsed = JSON.parse(raw)
    const now = Date.now()
    const loadedSessions = new Map()

    for (const [sessionId, session] of Object.entries(parsed)) {
      if (!session || typeof session !== 'object') {
        continue
      }

      const updatedAt = Number(session.updatedAt || session.createdAt || 0)

      if (!updatedAt || now - updatedAt > sessionTtlMs) {
        continue
      }

      loadedSessions.set(sessionId, session)
    }

    return loadedSessions
  } catch (error) {
    console.warn('Failed to load persisted sessions:', error)
    return new Map()
  }
}

function persistSessions() {
  pruneExpiredSessions()
  mkdirSync(fileURLToPath(new URL('../../.data', import.meta.url)), { recursive: true })

  const serializedSessions = Object.fromEntries(sessions)
  const tempPath = `${sessionStorePath}.tmp`

  writeFileSync(tempPath, JSON.stringify(serializedSessions, null, 2))
  renameSync(tempPath, sessionStorePath)
}

function pruneExpiredSessions() {
  const now = Date.now()
  let removedAny = false

  for (const [sessionId, session] of sessions.entries()) {
    const updatedAt = Number(session?.updatedAt || session?.createdAt || 0)

    if (!updatedAt || now - updatedAt > sessionTtlMs) {
      sessions.delete(sessionId)
      removedAny = true
    }
  }

  return removedAny
}