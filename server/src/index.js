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
const sessionEncryptionAlgorithm = 'aes-256-gcm'
const stravaAuthorizeUrl = 'https://www.strava.com/oauth/authorize'
const stravaTokenUrl = 'https://www.strava.com/oauth/token'
const stravaApiBaseUrl = 'https://www.strava.com/api/v3'
const sessionStorePath = fileURLToPath(new URL('../../.data/sessions.json', import.meta.url))
const stravaConfigStorePath = fileURLToPath(new URL('../../.data/strava-config.json', import.meta.url))
const sessionEncryptionKey = getSessionEncryptionKey()
let persistedStravaConfig = loadPersistedStravaConfig()
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
    secureStorageConfigured: Boolean(sessionEncryptionKey),
    configSource: config.source,
    athlete: session?.strava?.athlete || null,
    expiresAt: session?.strava?.expiresAt || null,
    scopes: session?.strava?.scope ? session.strava.scope.split(',') : [],
    message: config.configured
      ? sessionEncryptionKey
        ? isConnected
          ? 'Strava account connected.'
          : 'Connect your Strava account to load activities.'
        : isConnected
          ? 'Strava account connected. Add SESSION_ENCRYPTION_KEY to keep tokens encrypted across restarts.'
          : 'Connect your Strava account to load activities. Add SESSION_ENCRYPTION_KEY to persist encrypted tokens across restarts.'
      : 'Add Strava credentials in the app settings panel or through .env.',
  })
})

app.get('/api/strava/config', (_request, response) => {
  const config = getStravaConfig()

  response.json({
    configured: config.configured,
    source: config.source,
    redirectUri: config.redirectUri,
    secureStorageConfigured: Boolean(sessionEncryptionKey),
    hasStoredConfig: Boolean(persistedStravaConfig),
  })
})

app.post('/api/strava/config', (request, response) => {
  if (!sessionEncryptionKey) {
    response.status(503).json({
      error: 'SESSION_ENCRYPTION_KEY is required before storing Strava credentials from the frontend.',
    })
    return
  }

  const clientId = sanitizeConfigValue(request.body?.clientId)
  const clientSecret = sanitizeConfigValue(request.body?.clientSecret)

  if (!clientId || !clientSecret) {
    response.status(400).json({
      error: 'Both clientId and clientSecret are required.',
    })
    return
  }

  const nextConfig = {
    clientId,
    clientSecret,
    updatedAt: Date.now(),
  }

  savePersistedStravaConfig(nextConfig)

  response.json({
    ok: true,
    configured: true,
    source: 'frontend',
  })
})

app.delete('/api/strava/config', (_request, response) => {
  clearPersistedStravaConfig()
  clearStravaSessions()
  persistSessions()

  response.json({ ok: true })
})

app.get('/api/strava/connect', (request, response) => {
  const config = getStravaConfig()

  if (!config.configured) {
    response.status(503).json({
      error: 'Strava is not configured.',
      message: 'Set Strava credentials in the frontend settings panel or provide them through .env.',
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

app.get('/api/weather/wind', async (request, response) => {
  const latitude = Number(request.query.lat)
  const longitude = Number(request.query.lon)
  const dateTime = request.query.dateTime

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !dateTime) {
    response.status(400).json({
      error: 'lat, lon, and dateTime are required query params.',
    })
    return
  }

  try {
    const weather = await fetchWindWeather(latitude, longitude, String(dateTime))

    if (!weather) {
      response.status(404).json({
        error: 'No wind data available for this location and time.',
      })
      return
    }

    response.json(weather)
  } catch (weatherError) {
    response.status(502).json({
      error: 'Failed to load wind data.',
      detail: weatherError instanceof Error ? weatherError.message : String(weatherError),
    })
  }
})

app.post('/api/weather/wind-track', async (request, response) => {
  const points = Array.isArray(request.body?.points) ? request.body.points : null

  if (!points || points.length === 0) {
    response.status(400).json({
      error: 'Request body must include a non-empty points array.',
    })
    return
  }

  const pointLimit = 40
  const safePoints = points.slice(0, pointLimit)
  const cache = new Map()

  try {
    const samples = await Promise.all(
      safePoints.map(async (point, idx) => {
        const latitude = Number(point.lat)
        const longitude = Number(point.lon)
        const dateTime = String(point.dateTime || '')

        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !dateTime) {
          return {
            index: Number.isFinite(Number(point.index)) ? Number(point.index) : idx,
            error: 'Invalid point payload.',
          }
        }

        const cacheKey = buildWeatherCacheKey(latitude, longitude, dateTime)
        let weather = cache.get(cacheKey)

        if (!weather) {
          weather = await fetchWindWeather(latitude, longitude, dateTime)
          cache.set(cacheKey, weather)
        }

        if (!weather) {
          return {
            index: Number.isFinite(Number(point.index)) ? Number(point.index) : idx,
            error: 'No weather sample available.',
          }
        }

        return {
          index: Number.isFinite(Number(point.index)) ? Number(point.index) : idx,
          weather,
        }
      }),
    )

    response.json({
      source: 'open-meteo',
      samples,
      limitedTo: pointLimit,
    })
  } catch (weatherError) {
    response.status(502).json({
      error: 'Failed to load route wind data.',
      detail: weatherError instanceof Error ? weatherError.message : String(weatherError),
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
  const envClientId = sanitizeConfigValue(process.env.STRAVA_CLIENT_ID)
  const envClientSecret = sanitizeConfigValue(process.env.STRAVA_CLIENT_SECRET)
  const redirectUri = process.env.STRAVA_REDIRECT_URI || `${frontendUrl}/api/strava/callback`
  const clientId = persistedStravaConfig?.clientId || envClientId || ''
  const clientSecret = persistedStravaConfig?.clientSecret || envClientSecret || ''
  const source = persistedStravaConfig ? 'frontend' : envClientId && envClientSecret ? 'env' : 'none'

  return {
    clientId,
    clientSecret,
    redirectUri,
    configured: Boolean(clientId && clientSecret),
    source,
  }
}

function sanitizeConfigValue(value) {
  const trimmed = (value || '').trim()

  if (!trimmed) {
    return ''
  }

  if (trimmed.startsWith('your-') || trimmed.startsWith('replace-with-')) {
    return ''
  }

  return trimmed
}

function getSessionEncryptionKey() {
  const rawKey = process.env.SESSION_ENCRYPTION_KEY || ''

  if (!rawKey) {
    console.warn('SESSION_ENCRYPTION_KEY is not set. Persisted Strava tokens will not survive server restarts.')
    return null
  }

  if (!/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    console.warn('SESSION_ENCRYPTION_KEY must be 64 hex characters. Persisted Strava tokens will not survive server restarts.')
    return null
  }

  return Buffer.from(rawKey, 'hex')
}

function loadPersistedStravaConfig() {
  if (!existsSync(stravaConfigStorePath)) {
    return null
  }

  if (!sessionEncryptionKey) {
    return null
  }

  try {
    const raw = readFileSync(stravaConfigStorePath, 'utf8')
    const parsed = JSON.parse(raw)
    const decrypted = decryptPayload(parsed.encryptedConfig)

    if (!decrypted?.clientId || !decrypted?.clientSecret) {
      return null
    }

    return {
      clientId: sanitizeConfigValue(decrypted.clientId),
      clientSecret: sanitizeConfigValue(decrypted.clientSecret),
      updatedAt: Number(parsed.updatedAt || Date.now()),
    }
  } catch (error) {
    console.warn('Failed to load persisted Strava config:', error)
    return null
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
  const [startLatitude, startLongitude] = Array.isArray(activity.start_latlng)
    ? activity.start_latlng
    : [null, null]

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
    startDateUtc: activity.start_date,
    startLatitude,
    startLongitude,
    summaryPolyline: activity.map?.summary_polyline || null,
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

async function fetchWindWeather(latitude, longitude, dateTimeString) {
  const activityDate = new Date(dateTimeString)

  if (Number.isNaN(activityDate.getTime())) {
    throw new Error('Invalid dateTime value.')
  }

  const dateIso = activityDate.toISOString().slice(0, 10)
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    start_date: dateIso,
    end_date: dateIso,
    hourly: 'wind_speed_10m,wind_direction_10m',
    timezone: 'UTC',
  })
  const weatherResponse = await fetch(`https://archive-api.open-meteo.com/v1/archive?${params.toString()}`)

  if (!weatherResponse.ok) {
    throw new Error(await safeReadText(weatherResponse))
  }

  const payload = await weatherResponse.json()
  const hourly = payload?.hourly

  if (!hourly?.time || !hourly?.wind_speed_10m || !hourly?.wind_direction_10m) {
    return null
  }

  let bestIndex = -1
  let smallestDiff = Number.POSITIVE_INFINITY

  for (let i = 0; i < hourly.time.length; i += 1) {
    const sampleTime = new Date(hourly.time[i]).getTime()

    if (Number.isNaN(sampleTime)) {
      continue
    }

    const diff = Math.abs(sampleTime - activityDate.getTime())

    if (diff < smallestDiff) {
      smallestDiff = diff
      bestIndex = i
    }
  }

  if (bestIndex === -1) {
    return null
  }

  return {
    source: 'open-meteo',
    sampleTimeUtc: hourly.time[bestIndex],
    windSpeedKph: Number(hourly.wind_speed_10m[bestIndex]),
    windDirectionDeg: Number(hourly.wind_direction_10m[bestIndex]),
  }
}

function buildWeatherCacheKey(latitude, longitude, dateTime) {
  const date = new Date(dateTime)
  const hourlyStamp = Number.isNaN(date.getTime())
    ? dateTime
    : new Date(
        Date.UTC(
          date.getUTCFullYear(),
          date.getUTCMonth(),
          date.getUTCDate(),
          date.getUTCHours(),
        ),
      ).toISOString()

  return `${latitude.toFixed(2)}:${longitude.toFixed(2)}:${hourlyStamp}`
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

      loadedSessions.set(sessionId, hydrateSession(sessionId, session))
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

  const serializedSessions = Object.fromEntries(
    Array.from(sessions.entries(), ([sessionId, session]) => [sessionId, serializeSession(sessionId, session)]),
  )
  const tempPath = `${sessionStorePath}.tmp`

  writeFileSync(tempPath, JSON.stringify(serializedSessions, null, 2))
  renameSync(tempPath, sessionStorePath)
}

function savePersistedStravaConfig(config) {
  persistedStravaConfig = {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    updatedAt: config.updatedAt,
  }

  mkdirSync(fileURLToPath(new URL('../../.data', import.meta.url)), { recursive: true })

  const encryptedConfig = encryptPayload({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  })
  const tempPath = `${stravaConfigStorePath}.tmp`
  const serialized = {
    updatedAt: config.updatedAt,
    encryptedConfig,
  }

  writeFileSync(tempPath, JSON.stringify(serialized, null, 2))
  renameSync(tempPath, stravaConfigStorePath)
}

function clearPersistedStravaConfig() {
  persistedStravaConfig = null

  if (!existsSync(stravaConfigStorePath)) {
    return
  }

  writeFileSync(`${stravaConfigStorePath}.tmp`, JSON.stringify({}, null, 2))
  renameSync(`${stravaConfigStorePath}.tmp`, stravaConfigStorePath)
}

function clearStravaSessions() {
  for (const session of sessions.values()) {
    delete session.oauthState
    delete session.strava
    session.updatedAt = Date.now()
  }
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

function hydrateSession(sessionId, session) {
  const hydratedSession = { ...session }

  if (hydratedSession.encryptedStrava) {
    const strava = decryptPayload(hydratedSession.encryptedStrava)

    if (strava) {
      hydratedSession.strava = strava
    }

    delete hydratedSession.encryptedStrava
  } else if (hydratedSession.strava) {
    console.warn(`Dropping legacy plaintext Strava session data for ${sessionId}.`)
    delete hydratedSession.strava
  }

  return hydratedSession
}

function serializeSession(sessionId, session) {
  const serializedSession = { ...session }

  if (!serializedSession.strava) {
    delete serializedSession.encryptedStrava
    return serializedSession
  }

  if (!sessionEncryptionKey) {
    console.warn(`Skipping persisted Strava tokens for ${sessionId} because SESSION_ENCRYPTION_KEY is not configured.`)
    delete serializedSession.strava
    delete serializedSession.encryptedStrava
    return serializedSession
  }

  serializedSession.encryptedStrava = encryptPayload(serializedSession.strava)
  delete serializedSession.strava

  return serializedSession
}

function encryptPayload(payload) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(sessionEncryptionAlgorithm, sessionEncryptionKey, iv)
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()

  return {
    algorithm: sessionEncryptionAlgorithm,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  }
}

function decryptPayload(encryptedPayload) {
  if (!sessionEncryptionKey) {
    return null
  }

  if (encryptedPayload.algorithm !== sessionEncryptionAlgorithm) {
    console.warn(`Unsupported encrypted session algorithm: ${encryptedPayload.algorithm}`)
    return null
  }

  try {
    const decipher = crypto.createDecipheriv(
      sessionEncryptionAlgorithm,
      sessionEncryptionKey,
      Buffer.from(encryptedPayload.iv, 'hex'),
    )
    decipher.setAuthTag(Buffer.from(encryptedPayload.authTag, 'hex'))

    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encryptedPayload.ciphertext, 'hex')),
      decipher.final(),
    ])

    return JSON.parse(plaintext.toString('utf8'))
  } catch (error) {
    console.warn('Failed to decrypt persisted Strava session payload:', error)
    return null
  }
}