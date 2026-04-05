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
      <div id="activities-list" class="activities-list"></div>
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
const activitiesList = document.querySelector('#activities-list')

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
  activitiesList.innerHTML = ''

  if (!activities.length) {
    activitiesEmpty.hidden = false
    activitiesEmpty.textContent = 'No activities returned for this athlete yet.'
    return
  }

  activitiesEmpty.hidden = true

  for (const activity of activities) {
    const article = document.createElement('article')
    article.className = 'activity-card'
    article.innerHTML = `
      <div class="activity-header">
        <p class="activity-type">${activity.sportType || activity.type}</p>
        <p class="activity-date">${formatDate(activity.startDateLocal)}</p>
      </div>
      <h3>${activity.name}</h3>
      <dl class="activity-stats">
        <div>
          <dt>Distance</dt>
          <dd>${formatDistance(activity.distanceMeters)}</dd>
        </div>
        <div>
          <dt>Moving time</dt>
          <dd>${formatDuration(activity.movingTimeSeconds)}</dd>
        </div>
        <div>
          <dt>Elevation</dt>
          <dd>${Math.round(activity.totalElevationGain)} m</dd>
        </div>
        <div>
          <dt>Kudos</dt>
          <dd>${activity.kudosCount}</dd>
        </div>
      </dl>
    `
    activitiesList.append(article)
  }
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

connectButton.addEventListener('click', () => {
  window.location.href = '/api/strava/connect'
})

refreshButton.addEventListener('click', loadActivities)
disconnectButton.addEventListener('click', disconnectStrava)

handleCallbackState()
loadStatus().catch((error) => {
  messageTitle.textContent = 'Setup check failed'
  messageBody.textContent = 'The frontend could not retrieve backend integration status.'
  payload.textContent = error instanceof Error ? error.message : String(error)
  status.textContent = 'Error'
})
