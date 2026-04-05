import './style.css'

const app = document.querySelector('#app')

app.innerHTML = `
  <main class="shell">
    <section class="hero">
      <p class="eyebrow">Windviz x Strava</p>
      <h1>Use your Strava activities in the app.</h1>
      <p class="lede">
        Connect a Strava account, pull recent activities through the Express
        backend, and use the returned data as the starting point for your own
        visualizations.
      </p>
      <div class="actions">
        <button id="connect-strava" type="button">Connect Strava</button>
        <button id="refresh-activities" type="button">Load activities</button>
        <button id="disconnect-strava" type="button" class="secondary">Disconnect</button>
        <span id="status" class="status">Checking setup...</span>
      </div>
    </section>

    <section class="panel panel-status">
      <div>
        <p class="panel-label">Connection</p>
        <h2 id="message-title">Preparing Strava integration</h2>
        <p id="message-body">Checking whether Strava credentials are configured.</p>
      </div>
      <pre id="payload" class="payload">Waiting for status...</pre>
    </section>

    <section class="panel panel-activities">
      <div class="section-heading">
        <div>
          <p class="panel-label">Recent activities</p>
          <h2>Latest Strava sessions</h2>
        </div>
      </div>
      <div id="activities-empty" class="empty-state">Connect Strava to load activities.</div>
      <div id="activities-layout" class="activities-layout" hidden>
        <div id="activities-list" class="activities-list" role="listbox" aria-label="Activities"></div>
        <article id="activity-detail" class="activity-detail" aria-live="polite">
          <p id="activity-detail-type" class="activity-type">-</p>
          <h3 id="activity-detail-title">Select an activity</h3>
          <p id="activity-detail-date" class="activity-date">-</p>
          <dl id="activity-detail-stats" class="activity-detail-stats"></dl>
          <section class="route-block">
            <p class="panel-label">Route wind overlay</p>
            <div id="route-visual" class="route-visual">
              <svg id="route-svg" viewBox="0 0 620 360" preserveAspectRatio="xMidYMid meet" aria-label="Activity route and wind arrows"></svg>
            </div>
            <div class="route-controls">
              <button id="route-play-toggle" type="button">Play route</button>
              <input id="route-progress" type="range" min="0" max="1000" value="0" step="1" />
              <span id="route-progress-label" class="wind-meta">0%</span>
            </div>
            <p id="route-live-wind" class="wind-summary">Wind at playhead will appear during playback.</p>
            <p id="route-meta" class="wind-meta">Select an activity to load route wind samples.</p>
          </section>
          <section class="weather-block">
            <p class="panel-label">Wind at activity start</p>
            <div id="wind-visual" class="wind-visual" aria-hidden="true">
              <div class="wind-needle-wrap">
                <span id="wind-needle" class="wind-needle"></span>
              </div>
              <span class="wind-n">N</span>
              <span class="wind-e">E</span>
              <span class="wind-s">S</span>
              <span class="wind-w">W</span>
            </div>
            <p id="wind-summary" class="wind-summary">Select an activity to load wind data.</p>
            <p id="wind-meta" class="wind-meta"></p>
          </section>
        </article>
      </div>
    </section>
  </main>
`

const connectButton = document.querySelector('#connect-strava')
const refreshButton = document.querySelector('#refresh-activities')
const disconnectButton = document.querySelector('#disconnect-strava')
const status = document.querySelector('#status')
const messageTitle = document.querySelector('#message-title')
const messageBody = document.querySelector('#message-body')
const payload = document.querySelector('#payload')
const activitiesEmpty = document.querySelector('#activities-empty')
const activitiesLayout = document.querySelector('#activities-layout')
const activitiesList = document.querySelector('#activities-list')
const activityDetailType = document.querySelector('#activity-detail-type')
const activityDetailTitle = document.querySelector('#activity-detail-title')
const activityDetailDate = document.querySelector('#activity-detail-date')
const activityDetailStats = document.querySelector('#activity-detail-stats')
const routeSvg = document.querySelector('#route-svg')
const routePlayToggle = document.querySelector('#route-play-toggle')
const routeProgress = document.querySelector('#route-progress')
const routeProgressLabel = document.querySelector('#route-progress-label')
const routeLiveWind = document.querySelector('#route-live-wind')
const routeMeta = document.querySelector('#route-meta')
const windNeedle = document.querySelector('#wind-needle')
const windSummary = document.querySelector('#wind-summary')
const windMeta = document.querySelector('#wind-meta')

let currentConfigSource = 'none'
let currentActivities = []
let selectedActivityId = null
const weatherByActivityId = new Map()
const routeWindByActivityId = new Map()
const routePlaybackByActivityId = new Map()
let routePlaybackFrameId = null
async function requestJson(url, options) {
  const response = await fetch(url, options)
  const data = await response.json().catch(() => null)

  if (!response.ok) {
    throw new Error(data?.message || data?.error || `Request failed with status ${response.status}`)
  }

  return data
}

function setBusyState(isBusy) {
  connectButton.disabled = isBusy
  refreshButton.disabled = isBusy
  disconnectButton.disabled = isBusy
}

function renderActivities(activities) {
  currentActivities = activities

  if (!activities.length) {
    stopRoutePlayback()
    activitiesEmpty.hidden = false
    activitiesEmpty.textContent = 'No activities returned for this athlete yet.'
    activitiesLayout.hidden = true
    selectedActivityId = null
    return
  }

  activitiesEmpty.hidden = true
  activitiesLayout.hidden = false

  if (!activities.some((activity) => activity.id === selectedActivityId)) {
    selectedActivityId = activities[0].id
  }

  renderActivityList()
  renderActivityDetail()
}

function renderActivityList() {
  activitiesList.innerHTML = ''

  for (const activity of currentActivities) {
    const option = document.createElement('button')
    option.type = 'button'
    option.className = 'activity-option'
    option.dataset.activityId = String(activity.id)
    option.setAttribute('role', 'option')
    option.setAttribute('aria-selected', String(activity.id === selectedActivityId))

    if (activity.id === selectedActivityId) {
      option.classList.add('is-selected')
    }

    option.innerHTML = `
      <div class="activity-option-header">
        <p class="activity-type">${activity.sportType || activity.type}</p>
        <p class="activity-date">${formatDate(activity.startDateLocal)}</p>
      </div>
      <h3>${activity.name}</h3>
      <p class="activity-option-meta">
        ${formatDistance(activity.distanceMeters)} · ${formatDuration(activity.movingTimeSeconds)}
      </p>
    `

    activitiesList.append(option)
  }
}

function renderActivityDetail() {
  const activity = currentActivities.find((entry) => entry.id === selectedActivityId)

  if (!activity) {
    activityDetailType.textContent = '-'
    activityDetailTitle.textContent = 'Select an activity'
    activityDetailDate.textContent = '-'
    activityDetailStats.innerHTML = ''
    syncRoutePlaybackControls(0, false)
    renderRoutePlaceholder('Select an activity to load route wind samples.')
    renderWeatherPlaceholder('Select an activity to load wind data.')
    return
  }

  activityDetailType.textContent = activity.sportType || activity.type
  activityDetailTitle.textContent = activity.name
  activityDetailDate.textContent = formatDate(activity.startDateLocal)
  activityDetailStats.innerHTML = buildDetailStats(activity)
  renderRouteWeatherForActivity(activity)
  renderWeatherForActivity(activity)
}

function buildDetailStats(activity) {
  const stats = [
    ['Distance', formatDistance(activity.distanceMeters)],
    ['Moving time', formatDuration(activity.movingTimeSeconds)],
    ['Elapsed time', formatDuration(activity.elapsedTimeSeconds)],
    ['Elevation gain', `${Math.round(activity.totalElevationGain)} m`],
    ['Average speed', formatSpeed(activity.averageSpeed)],
    ['Max speed', formatSpeed(activity.maxSpeed)],
    ['Average pace', formatPace(activity.averageSpeed)],
    ['Kudos', String(activity.kudosCount)],
    ['Achievements', String(activity.achievementCount)],
    ['Energy', activity.kilojoules ? `${Math.round(activity.kilojoules)} kJ` : '-'],
  ]

  return stats
    .map(
      ([label, value]) => `
        <div>
          <dt>${label}</dt>
          <dd>${value}</dd>
        </div>
      `,
    )
    .join('')
}

async function loadStatus() {
  const data = await requestJson('/api/strava/status')

  connectButton.disabled = !data.configured
  refreshButton.disabled = !data.configured || !data.connected
  disconnectButton.disabled = !data.connected
  status.textContent = data.connected ? 'Connected' : data.configured ? 'Ready to connect' : 'Setup required'
  messageTitle.textContent = data.connected
    ? `Connected${data.athlete ? ` as ${data.athlete.firstName} ${data.athlete.lastName}` : ''}`
    : data.configured
      ? 'Strava available'
      : 'Strava credentials missing'
  messageBody.textContent = data.message
  payload.textContent = JSON.stringify(data, null, 2)

  if (data.connected) {
    await loadActivities()
  } else {
    renderActivities([])
    activitiesEmpty.hidden = false
    activitiesEmpty.textContent = data.configured
      ? 'Connect Strava to load activities.'
      : 'Add credentials in .env before connecting Strava.'
  }
}

async function loadActivities() {
  status.textContent = 'Loading activities...'
  refreshButton.disabled = true

  try {
    const data = await requestJson('/api/strava/activities?perPage=12')

    renderActivities(data.activities)
    await preloadSelectedWeather()
    await preloadSelectedRouteWeather()
    payload.textContent = JSON.stringify(data, null, 2)
    status.textContent = 'Connected'
  } catch (error) {
    messageTitle.textContent = 'Activity load failed'
    messageBody.textContent = 'The backend could not return Strava activity data.'
    payload.textContent = error instanceof Error ? error.message : String(error)
    status.textContent = 'Error'
  } finally {
    refreshButton.disabled = false
  }
}

async function disconnectStrava() {
  setBusyState(true)

  try {
    await requestJson('/api/strava/disconnect', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    })
    renderActivities([])
    await loadStatus()
  } catch (error) {
    payload.textContent = error instanceof Error ? error.message : String(error)
    status.textContent = 'Error'
  } finally {
    setBusyState(false)
  }
}

function formatDistance(distanceMeters) {
  return `${(distanceMeters / 1000).toFixed(1)} km`
}

function formatSpeed(speedMetersPerSecond) {
  if (!speedMetersPerSecond || speedMetersPerSecond <= 0) {
    return '-'
  }

  return `${(speedMetersPerSecond * 3.6).toFixed(1)} km/h`
}

function formatPace(speedMetersPerSecond) {
  if (!speedMetersPerSecond || speedMetersPerSecond <= 0) {
    return '-'
  }

  const totalSecondsPerKm = 1000 / speedMetersPerSecond
  const minutes = Math.floor(totalSecondsPerKm / 60)
  const seconds = Math.round(totalSecondsPerKm % 60)

  return `${minutes}:${String(seconds).padStart(2, '0')} /km`
}

function formatDuration(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)

  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }

  return `${minutes}m`
}

function formatDate(dateString) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(dateString))
}

async function preloadSelectedWeather() {
  const activity = currentActivities.find((entry) => entry.id === selectedActivityId)

  if (!activity) {
    return
  }

  await loadWeather(activity)
  renderWeatherForActivity(activity)
}

async function preloadSelectedRouteWeather() {
  const activity = currentActivities.find((entry) => entry.id === selectedActivityId)

  if (!activity) {
    return
  }

  await loadRouteWeather(activity)
  renderRouteWeatherForActivity(activity)
}

function renderWeatherPlaceholder(message) {
  windSummary.textContent = message
  windMeta.textContent = ''
  windNeedle.style.transform = 'translate(-50%, -100%) rotate(0deg)'
}

function renderWeatherForActivity(activity) {
  const weatherState = weatherByActivityId.get(activity.id)

  if (!weatherState) {
    renderWeatherPlaceholder('Loading wind data...')
    return
  }

  if (weatherState.status === 'loading') {
    renderWeatherPlaceholder('Loading wind data...')
    return
  }

  if (weatherState.status === 'error') {
    renderWeatherPlaceholder(weatherState.message)
    return
  }

  const weather = weatherState.data

  windSummary.textContent = `${weather.windSpeedKph.toFixed(1)} km/h from ${toCompass(weather.windDirectionDeg)} (${Math.round(weather.windDirectionDeg)}deg)`
  windMeta.textContent = `Sampled at ${formatDate(weather.sampleTimeUtc)} via ${weather.source}`
  windNeedle.style.transform = `translate(-50%, -100%) rotate(${weather.windDirectionDeg}deg)`
}

function renderRoutePlaceholder(message) {
  routeSvg.innerHTML = ''
  routeLiveWind.textContent = 'Wind at playhead will appear during playback.'
  routeMeta.textContent = message
}

function renderRouteWeatherForActivity(activity) {
  const routePoints = decodePolyline(activity.summaryPolyline)

  if (routePoints.length < 2) {
    renderRoutePlaceholder('Route geometry is unavailable for this activity.')
    return
  }

  const projected = projectRoutePoints(routePoints)
  const routeState = routeWindByActivityId.get(activity.id)
  const playbackState = getRoutePlaybackState(activity.id)
  const playheadIndex = Math.round(playbackState.progress * (routePoints.length - 1))

  drawRouteBase(projected)

  if (!routeState || routeState.status === 'loading') {
    drawRoutePlayhead(projected, playheadIndex, null)
    updateRouteLiveWind(activity, routeState, playheadIndex)
    syncRoutePlaybackControls(playbackState.progress, playbackState.isPlaying)
    routeMeta.textContent = 'Loading wind samples along route...'
    return
  }

  if (routeState.status === 'error') {
    drawRoutePlayhead(projected, playheadIndex, null)
    updateRouteLiveWind(activity, routeState, playheadIndex)
    syncRoutePlaybackControls(playbackState.progress, playbackState.isPlaying)
    routeMeta.textContent = routeState.message
    return
  }

  drawRouteWindSamples(projected, routeState.samples)
  drawRoutePlayhead(projected, playheadIndex, getInterpolatedWindAtIndex(routeState.samples, playheadIndex))
  updateRouteLiveWind(activity, routeState, playheadIndex)
  syncRoutePlaybackControls(playbackState.progress, playbackState.isPlaying)
  routeMeta.textContent = `Showing ${routeState.samples.length} wind samples along route.`
}

async function loadWeather(activity) {
  if (activity.startLatitude == null || activity.startLongitude == null || !activity.startDateUtc) {
    weatherByActivityId.set(activity.id, {
      status: 'error',
      message: 'No location/time data available for this activity.',
    })
    return
  }

  const existing = weatherByActivityId.get(activity.id)

  if (existing?.status === 'ready') {
    return
  }

  weatherByActivityId.set(activity.id, { status: 'loading' })

  try {
    const params = new URLSearchParams({
      lat: String(activity.startLatitude),
      lon: String(activity.startLongitude),
      dateTime: String(activity.startDateUtc),
    })
    const weather = await requestJson(`/api/weather/wind?${params.toString()}`)

    weatherByActivityId.set(activity.id, {
      status: 'ready',
      data: weather,
    })
  } catch (error) {
    weatherByActivityId.set(activity.id, {
      status: 'error',
      message: error instanceof Error ? error.message : 'Wind data unavailable.',
    })
  }
}

async function loadRouteWeather(activity) {
  const routePoints = decodePolyline(activity.summaryPolyline)

  if (routePoints.length < 2 || !activity.startDateUtc || !activity.elapsedTimeSeconds) {
    routeWindByActivityId.set(activity.id, {
      status: 'error',
      message: 'Route wind overlay unavailable for this activity.',
    })
    return
  }

  const existing = routeWindByActivityId.get(activity.id)

  if (existing?.status === 'ready') {
    return
  }

  routeWindByActivityId.set(activity.id, { status: 'loading' })

  const sampleCount = Math.min(14, routePoints.length)
  const startTimeMs = new Date(activity.startDateUtc).getTime()
  const totalDurationMs = Number(activity.elapsedTimeSeconds) * 1000

  if (Number.isNaN(startTimeMs) || totalDurationMs <= 0) {
    routeWindByActivityId.set(activity.id, {
      status: 'error',
      message: 'Route time data unavailable for wind overlay.',
    })
    return
  }

  const samplePoints = []

  for (let i = 0; i < sampleCount; i += 1) {
    const ratio = sampleCount === 1 ? 0 : i / (sampleCount - 1)
    const routeIndex = Math.round(ratio * (routePoints.length - 1))
    const point = routePoints[routeIndex]

    samplePoints.push({
      index: routeIndex,
      lat: point.lat,
      lon: point.lon,
      dateTime: new Date(startTimeMs + totalDurationMs * ratio).toISOString(),
    })
  }

  try {
    const response = await requestJson('/api/weather/wind-track', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        points: samplePoints,
      }),
    })

    const samples = (response.samples || [])
      .filter((sample) => sample.weather)
      .map((sample) => ({
        routeIndex: sample.index,
        weather: sample.weather,
      }))

    routeWindByActivityId.set(activity.id, {
      status: 'ready',
      samples,
    })
  } catch (error) {
    routeWindByActivityId.set(activity.id, {
      status: 'error',
      message: error instanceof Error ? error.message : 'Route wind data unavailable.',
    })
  }
}

function toCompass(directionDeg) {
  const labels = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  const normalized = ((directionDeg % 360) + 360) % 360
  const index = Math.round(normalized / 45) % labels.length

  return labels[index]
}

function handleCallbackState() {
  const url = new URL(window.location.href)
  const stravaState = url.searchParams.get('strava')
  const reason = url.searchParams.get('reason')

  if (!stravaState) {
    return
  }

  if (stravaState === 'connected') {
    status.textContent = 'Connected'
  }

  if (stravaState === 'error') {
    status.textContent = 'Error'
    payload.textContent = `Strava callback error: ${reason || 'unknown'}`
  }

  url.searchParams.delete('strava')
  url.searchParams.delete('reason')
  window.history.replaceState({}, '', url)
}

function handleActivitySelection(event) {
  const target = event.target.closest('[data-activity-id]')

  if (!target) {
    return
  }

  const activityId = Number(target.dataset.activityId)

  if (!Number.isFinite(activityId) || activityId === selectedActivityId) {
    return
  }

  stopRoutePlayback()
  selectedActivityId = activityId
  renderActivityList()
  renderActivityDetail()

  const selected = currentActivities.find((activity) => activity.id === selectedActivityId)

  if (!selected) {
    return
  }

  loadWeather(selected).then(() => {
    renderWeatherForActivity(selected)
  })

  loadRouteWeather(selected).then(() => {
    renderRouteWeatherForActivity(selected)
  })
}

function handleRoutePlayToggle() {
  const activity = currentActivities.find((entry) => entry.id === selectedActivityId)

  if (!activity) {
    return
  }

  const playbackState = getRoutePlaybackState(activity.id)

  if (playbackState.isPlaying) {
    stopRoutePlayback()
    renderRouteWeatherForActivity(activity)
    return
  }

  if (playbackState.progress >= 1) {
    playbackState.progress = 0
  }

  playbackState.isPlaying = true
  playbackState.lastFrameMs = null
  routePlaybackByActivityId.set(activity.id, playbackState)
  routePlaybackFrameId = requestAnimationFrame(stepRoutePlayback)
  renderRouteWeatherForActivity(activity)
}

function handleRouteScrub(event) {
  const activity = currentActivities.find((entry) => entry.id === selectedActivityId)

  if (!activity) {
    return
  }

  const progressValue = Number(event.target.value)

  if (!Number.isFinite(progressValue)) {
    return
  }

  const playbackState = getRoutePlaybackState(activity.id)

  playbackState.progress = Math.max(0, Math.min(1, progressValue / 1000))
  playbackState.isPlaying = false
  playbackState.lastFrameMs = null
  routePlaybackByActivityId.set(activity.id, playbackState)
  stopRoutePlayback()
  renderRouteWeatherForActivity(activity)
}

function stepRoutePlayback(timestampMs) {
  const activity = currentActivities.find((entry) => entry.id === selectedActivityId)

  if (!activity) {
    stopRoutePlayback()
    return
  }

  const playbackState = getRoutePlaybackState(activity.id)

  if (!playbackState.isPlaying) {
    stopRoutePlayback()
    renderRouteWeatherForActivity(activity)
    return
  }

  if (playbackState.lastFrameMs == null) {
    playbackState.lastFrameMs = timestampMs
  }

  const deltaMs = Math.max(0, timestampMs - playbackState.lastFrameMs)
  playbackState.lastFrameMs = timestampMs
  const playbackDurationMs = getPlaybackDurationMs(activity)

  playbackState.progress = Math.min(1, playbackState.progress + deltaMs / playbackDurationMs)

  if (playbackState.progress >= 1) {
    playbackState.isPlaying = false
  }

  routePlaybackByActivityId.set(activity.id, playbackState)
  renderRouteWeatherForActivity(activity)

  if (playbackState.isPlaying) {
    routePlaybackFrameId = requestAnimationFrame(stepRoutePlayback)
    return
  }

  stopRoutePlayback()
}

function stopRoutePlayback() {
  if (routePlaybackFrameId != null) {
    cancelAnimationFrame(routePlaybackFrameId)
    routePlaybackFrameId = null
  }

  const activity = currentActivities.find((entry) => entry.id === selectedActivityId)

  if (!activity) {
    return
  }

  const playbackState = getRoutePlaybackState(activity.id)

  playbackState.isPlaying = false
  playbackState.lastFrameMs = null
  routePlaybackByActivityId.set(activity.id, playbackState)
}

function getRoutePlaybackState(activityId) {
  const existing = routePlaybackByActivityId.get(activityId)

  if (existing) {
    return existing
  }

  return {
    progress: 0,
    isPlaying: false,
    lastFrameMs: null,
  }
}

function getPlaybackDurationMs(activity) {
  const elapsedSeconds = Number(activity.elapsedTimeSeconds || activity.movingTimeSeconds || 0)

  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) {
    return 18000
  }

  return Math.max(12000, Math.min(45000, elapsedSeconds * 20))
}

function syncRoutePlaybackControls(progress, isPlaying) {
  routeProgress.value = String(Math.round(Math.max(0, Math.min(1, progress)) * 1000))
  routeProgressLabel.textContent = `${Math.round(progress * 100)}%`
  routePlayToggle.textContent = isPlaying ? 'Pause route' : progress >= 1 ? 'Replay route' : 'Play route'
}

function getInterpolatedWindAtIndex(samples, targetIndex) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return null
  }

  const ordered = [...samples].sort((left, right) => left.routeIndex - right.routeIndex)

  if (targetIndex <= ordered[0].routeIndex) {
    return ordered[0].weather
  }

  if (targetIndex >= ordered[ordered.length - 1].routeIndex) {
    return ordered[ordered.length - 1].weather
  }

  for (let i = 0; i < ordered.length - 1; i += 1) {
    const before = ordered[i]
    const after = ordered[i + 1]

    if (targetIndex < before.routeIndex || targetIndex > after.routeIndex) {
      continue
    }

    if (before.routeIndex === after.routeIndex) {
      return before.weather
    }

    const t = (targetIndex - before.routeIndex) / (after.routeIndex - before.routeIndex)
    const beforeRadians = (before.weather.windDirectionDeg * Math.PI) / 180
    const afterRadians = (after.weather.windDirectionDeg * Math.PI) / 180
    const beforeX = Math.cos(beforeRadians) * before.weather.windSpeedKph
    const beforeY = Math.sin(beforeRadians) * before.weather.windSpeedKph
    const afterX = Math.cos(afterRadians) * after.weather.windSpeedKph
    const afterY = Math.sin(afterRadians) * after.weather.windSpeedKph
    const mixedX = beforeX + (afterX - beforeX) * t
    const mixedY = beforeY + (afterY - beforeY) * t
    const mixedSpeed = Math.sqrt(mixedX ** 2 + mixedY ** 2)
    const mixedDirection = ((Math.atan2(mixedY, mixedX) * 180) / Math.PI + 360) % 360

    return {
      source: before.weather.source,
      sampleTimeUtc: before.weather.sampleTimeUtc,
      windSpeedKph: mixedSpeed,
      windDirectionDeg: mixedDirection,
    }
  }

  return ordered[0].weather
}

function drawRoutePlayhead(projectedPoints, playheadIndex, wind) {
  const point = projectedPoints[playheadIndex]

  if (!point) {
    return
  }

  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  marker.setAttribute('cx', point.x.toFixed(1))
  marker.setAttribute('cy', point.y.toFixed(1))
  marker.setAttribute('r', '5.5')
  marker.setAttribute('class', 'route-playhead-dot')
  routeSvg.append(marker)

  if (!wind) {
    return
  }

  const group = document.createElementNS('http://www.w3.org/2000/svg', 'g')
  group.setAttribute(
    'transform',
    `translate(${point.x.toFixed(1)} ${point.y.toFixed(1)}) rotate(${wind.windDirectionDeg})`,
  )
  group.setAttribute('class', 'route-playhead-wind')

  const shaft = document.createElementNS('http://www.w3.org/2000/svg', 'line')
  shaft.setAttribute('x1', '0')
  shaft.setAttribute('y1', '10')
  shaft.setAttribute('x2', '0')
  shaft.setAttribute('y2', '-14')
  shaft.setAttribute('class', 'route-playhead-shaft')

  const head = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  head.setAttribute('d', 'M -5 -13 L 0 -20 L 5 -13 Z')
  head.setAttribute('class', 'route-playhead-head')

  group.append(shaft, head)
  routeSvg.append(group)
}

function updateRouteLiveWind(activity, routeState, playheadIndex) {
  if (!routeState || routeState.status !== 'ready') {
    routeLiveWind.textContent = 'Wind at playhead will appear once route samples load.'
    return
  }

  const wind = getInterpolatedWindAtIndex(routeState.samples, playheadIndex)

  if (!wind) {
    routeLiveWind.textContent = 'No wind sample available at current playhead.'
    return
  }

  routeLiveWind.textContent = `Playhead wind: ${wind.windSpeedKph.toFixed(1)} km/h from ${toCompass(wind.windDirectionDeg)} (${Math.round(wind.windDirectionDeg)}deg)`
}

function decodePolyline(encoded) {
  if (!encoded) {
    return []
  }

  let index = 0
  let latitude = 0
  let longitude = 0
  const points = []

  while (index < encoded.length) {
    let result = 0
    let shift = 0
    let byte = 0

    do {
      byte = encoded.charCodeAt(index) - 63
      index += 1
      result |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20)

    const deltaLat = result & 1 ? ~(result >> 1) : result >> 1
    latitude += deltaLat

    result = 0
    shift = 0

    do {
      byte = encoded.charCodeAt(index) - 63
      index += 1
      result |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20)

    const deltaLon = result & 1 ? ~(result >> 1) : result >> 1
    longitude += deltaLon

    points.push({
      lat: latitude / 1e5,
      lon: longitude / 1e5,
    })
  }

  return points
}

function projectRoutePoints(points) {
  const width = 620
  const height = 360
  const padding = 24
  const lats = points.map((point) => point.lat)
  const lons = points.map((point) => point.lon)
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const minLon = Math.min(...lons)
  const maxLon = Math.max(...lons)
  const latSpan = Math.max(maxLat - minLat, 0.0001)
  const lonSpan = Math.max(maxLon - minLon, 0.0001)

  return points.map((point) => {
    const x = padding + ((point.lon - minLon) / lonSpan) * (width - padding * 2)
    const y = padding + (1 - (point.lat - minLat) / latSpan) * (height - padding * 2)

    return { x, y }
  })
}

function drawRouteBase(projectedPoints) {
  routeSvg.innerHTML = ''

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  const commands = projectedPoints
    .map((point, idx) => `${idx === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(' ')

  path.setAttribute('d', commands)
  path.setAttribute('class', 'route-line')
  routeSvg.append(path)
}

function drawRouteWindSamples(projectedPoints, samples) {
  for (const sample of samples) {
    const point = projectedPoints[sample.routeIndex]

    if (!point) {
      continue
    }

    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    group.setAttribute('transform', `translate(${point.x.toFixed(1)} ${point.y.toFixed(1)}) rotate(${sample.weather.windDirectionDeg})`)
    group.setAttribute('class', 'route-wind-sample')

    const shaft = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    shaft.setAttribute('x1', '0')
    shaft.setAttribute('y1', '8')
    shaft.setAttribute('x2', '0')
    shaft.setAttribute('y2', '-10')
    shaft.setAttribute('class', 'route-wind-shaft')

    const head = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    head.setAttribute('d', 'M -4 -9 L 0 -15 L 4 -9 Z')
    head.setAttribute('class', 'route-wind-head')

    group.append(shaft, head)
    routeSvg.append(group)
  }
}

connectButton.addEventListener('click', () => {
  window.location.href = '/api/strava/connect'
})

refreshButton.addEventListener('click', loadActivities)
disconnectButton.addEventListener('click', disconnectStrava)
activitiesList.addEventListener('click', handleActivitySelection)
routePlayToggle.addEventListener('click', handleRoutePlayToggle)
routeProgress.addEventListener('input', handleRouteScrub)

handleCallbackState()
loadStatus().catch((error) => {
  messageTitle.textContent = 'Setup check failed'
  messageBody.textContent = 'The frontend could not retrieve backend integration status.'
  payload.textContent = error instanceof Error ? error.message : String(error)
  status.textContent = 'Error'
})
