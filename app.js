/**
 * GeoMark — app.js
 * ─────────────────────────────────────────────────────────
 * A fully client-side Geo-Reminder application.
 * - Leaflet.js for interactive map rendering
 * - HTML5 Geolocation API (watchPosition) for live tracking
 * - Haversine formula for accurate geofence distance checks
 * - Web Notifications API for in-zone alerts
 * - localStorage for reminder persistence
 * - QRCode.js for on-page QR code generation
 * ─────────────────────────────────────────────────────────
 */

'use strict';

/* ═══════════════════════════════════════════════════════════
   §1 — STATE
   Central application state object. The single source of truth.
═══════════════════════════════════════════════════════════ */
const State = {
  /** @type {Array<Reminder>} All saved reminders */
  reminders: [],

  /** @type {{ lat: number, lng: number } | null} Live user position */
  userPosition: null,

  /** @type {{ lat: number, lng: number } | null} Position captured from map click */
  pendingPosition: null,

  /** @type {L.Marker | null} Leaflet marker for the user's live location */
  userMarker: null,

  /** @type {number | null} watchPosition ID for cleanup */
  watchId: null,
};

/**
 * @typedef {Object} Reminder
 * @property {string} id        — Unique identifier (timestamp-based)
 * @property {string} title     — User-provided task text
 * @property {number} lat       — Latitude of the reminder pin
 * @property {number} lng       — Longitude of the reminder pin
 * @property {number} radius    — Alert radius in meters
 * @property {boolean} triggered — Whether the geofence has been crossed
 * @property {L.Marker}  [_marker] — Leaflet marker (runtime only, not persisted)
 * @property {L.Circle}  [_circle] — Leaflet radius circle (runtime only)
 */


/* ═══════════════════════════════════════════════════════════
   §2 — MAP INITIALISATION
═══════════════════════════════════════════════════════════ */

/** Default map center (London, a neutral fallback) */
const DEFAULT_CENTER = [51.505, -0.09];
const DEFAULT_ZOOM   = 13;

/** Initialise the Leaflet map instance */
const map = L.map('map', {
  center: DEFAULT_CENTER,
  zoom: DEFAULT_ZOOM,
  zoomControl: true,
});

// OpenStreetMap tile layer (free, no API key needed)
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
}).addTo(map);


/* ═══════════════════════════════════════════════════════════
   §3 — DOM REFERENCES
═══════════════════════════════════════════════════════════ */
const DOM = {
  form:           document.getElementById('reminderForm'),
  titleInput:     document.getElementById('reminderTitle'),
  radiusInput:    document.getElementById('reminderRadius'),
  saveBtn:        document.getElementById('saveBtn'),
  cancelBtn:      document.getElementById('cancelBtn'),
  coordsValue:    document.getElementById('coordsValue'),
  remindersList:  document.getElementById('remindersList'),
  remindersCount: document.getElementById('remindersCount'),
  emptyState:     document.getElementById('emptyState'),
  mapStatus:      document.getElementById('mapStatus'),
  statusDot:      document.getElementById('statusDot'),
  statusText:     document.getElementById('statusText'),
  mapHint:        document.getElementById('mapHint'),
  qrContainer:    document.getElementById('qrCodeContainer'),
};


/* ═══════════════════════════════════════════════════════════
   §4 — WEB NOTIFICATIONS
   Request permission immediately on app startup.
═══════════════════════════════════════════════════════════ */
function requestNotificationPermission() {
  if (!('Notification' in window)) {
    console.warn('[GeoMark] Web Notifications not supported in this browser.');
    return;
  }
  if (Notification.permission === 'default') {
    Notification.requestPermission().then(perm => {
      console.info(`[GeoMark] Notification permission: ${perm}`);
    });
  }
}

/**
 * Fire a native browser notification for a triggered geofence.
 * Falls back to an in-app toast if Notification permission is denied.
 * @param {Reminder} reminder
 */
function sendGeofenceAlert(reminder) {
  const title = '📍 Geo-Reminder Alert!';
  const body  = reminder.title;

  // Try native notification first
  if (Notification.permission === 'granted') {
    const notification = new Notification(title, {
      body,
      icon: 'https://cdn-icons-png.flaticon.com/512/684/684908.png',
      badge: 'https://cdn-icons-png.flaticon.com/512/684/684908.png',
      tag: `georeminder-${reminder.id}`, // prevents duplicate stacking
    });

    // Auto-close after 8 seconds
    setTimeout(() => notification.close(), 8000);
  }

  // Always show the in-app toast regardless
  showToast(`📍 ${reminder.title}`);
}


/* ═══════════════════════════════════════════════════════════
   §5 — IN-APP TOAST
   A small floating notification inside the UI.
═══════════════════════════════════════════════════════════ */

/** @type {HTMLElement | null} Currently displayed toast element */
let activeToast = null;

/**
 * Show a temporary toast message at the top of the screen.
 * @param {string} message
 * @param {number} [duration=4000] — Display duration in ms
 */
function showToast(message, duration = 4000) {
  // Remove any existing toast
  if (activeToast) {
    activeToast.remove();
    activeToast = null;
  }

  const toast = document.createElement('div');
  toast.className = 'geo-toast';
  toast.innerHTML = `<span class="geo-toast__icon">📍</span><span>${message}</span>`;
  document.body.appendChild(toast);
  activeToast = toast;

  // Trigger animation on next frame
  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add('is-visible'));
  });

  setTimeout(() => {
    toast.classList.remove('is-visible');
    toast.addEventListener('transitionend', () => {
      toast.remove();
      if (activeToast === toast) activeToast = null;
    }, { once: true });
  }, duration);
}


/* ═══════════════════════════════════════════════════════════
   §6 — HAVERSINE FORMULA
   Calculates the great-circle distance between two GPS coordinates.
   Returns the distance in metres.
═══════════════════════════════════════════════════════════ */

/** Earth's mean radius in metres (WGS-84 approximation) */
const EARTH_RADIUS_M = 6_371_000;

/**
 * Compute the distance in metres between two geographic points
 * using the Haversine formula.
 *
 * Formula: a = sin²(Δlat/2) + cos(lat1)·cos(lat2)·sin²(Δlng/2)
 *          c = 2·atan2(√a, √(1-a))
 *          d = R·c
 *
 * @param {number} lat1 — Latitude of point A  (degrees)
 * @param {number} lng1 — Longitude of point A (degrees)
 * @param {number} lat2 — Latitude of point B  (degrees)
 * @param {number} lng2 — Longitude of point B (degrees)
 * @returns {number} Distance in metres
 */
function haversineDistance(lat1, lng1, lat2, lng2) {
  const toRad = deg => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);

  const a =
    sinDLat * sinDLat +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * sinDLng * sinDLng;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_M * c;
}


/* ═══════════════════════════════════════════════════════════
   §7 — GEOLOCATION TRACKING
   Uses watchPosition for continuous live tracking.
═══════════════════════════════════════════════════════════ */

/** Custom Leaflet DivIcon for the user's current location */
const userIcon = L.divIcon({
  className: '',
  html: '<div class="user-location-marker"></div>',
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

/**
 * Start watching the user's GPS position.
 * - Updates the user marker on the map
 * - Checks all active geofences on every position update
 */
function startLocationTracking() {
  if (!('geolocation' in navigator)) {
    updateStatus('Geolocation not supported', 'error');
    return;
  }

  const options = {
    enableHighAccuracy: true,  // Use GPS rather than WiFi triangulation
    timeout: 15_000,           // Wait up to 15s for a fix
    maximumAge: 0,             // Never use a cached position
  };

  State.watchId = navigator.geolocation.watchPosition(
    onPositionUpdate,
    onPositionError,
    options
  );
}

/**
 * Callback: called each time the browser provides a new GPS position.
 * @param {GeolocationPosition} position
 */
function onPositionUpdate(position) {
  const { latitude: lat, longitude: lng, accuracy } = position.coords;
  State.userPosition = { lat, lng };

  // Update or create the user's marker
  if (State.userMarker) {
    State.userMarker.setLatLng([lat, lng]);
  } else {
    State.userMarker = L.marker([lat, lng], {
      icon: userIcon,
      zIndexOffset: 1000, // Always render above reminder pins
      title: 'Your location',
    }).addTo(map);

    // Centre the map on the user's location the first time we get a fix
    map.setView([lat, lng], 15);
  }

  // Update status indicator
  const accuracyText = accuracy < 50
    ? `±${Math.round(accuracy)}m`
    : `±${Math.round(accuracy)}m (low accuracy)`;
  updateStatus(`Location acquired ${accuracyText}`, 'active');

  // Hide hint tooltip after first successful fix
  DOM.mapHint.classList.add('is-hidden');

  // Check all saved geofences against the new position
  checkGeofences(lat, lng);
}

/**
 * Callback: called if geolocation fails.
 * @param {GeolocationPositionError} error
 */
function onPositionError(error) {
  const messages = {
    1: 'Location permission denied',
    2: 'Position unavailable',
    3: 'Location request timed out',
  };
  updateStatus(messages[error.code] || 'Location error', 'error');
  console.warn('[GeoMark] Geolocation error:', error.message);
}

/**
 * Update the status pill in the map UI.
 * @param {string} text
 * @param {'active'|'error'|'loading'} [state='loading']
 */
function updateStatus(text, state = 'loading') {
  DOM.statusText.textContent = text;
  DOM.statusDot.className = 'status-dot';
  if (state === 'active') DOM.statusDot.classList.add('is-active');
  if (state === 'error')  DOM.statusDot.classList.add('is-error');
}


/* ═══════════════════════════════════════════════════════════
   §8 — GEOFENCE CHECKING
   Called on every GPS update. Checks the user's distance
   against every saved, non-triggered reminder.
═══════════════════════════════════════════════════════════ */

/**
 * Check whether the user has entered any active geofences.
 * Marks reminders as triggered to prevent repeated alerts.
 * @param {number} userLat
 * @param {number} userLng
 */
function checkGeofences(userLat, userLng) {
  let anyUpdated = false;

  State.reminders.forEach(reminder => {
    // Skip already-triggered reminders
    if (reminder.triggered) return;

    const distance = haversineDistance(
      userLat, userLng,
      reminder.lat, reminder.lng
    );

    console.debug(
      `[GeoMark] "${reminder.title}" — distance: ${Math.round(distance)}m, radius: ${reminder.radius}m`
    );

    if (distance <= reminder.radius) {
      // ── GEOFENCE CROSSED ──
      reminder.triggered = true;
      anyUpdated = true;

      sendGeofenceAlert(reminder);
      refreshReminderCard(reminder);
    }
  });

  // Persist updated triggered states
  if (anyUpdated) saveToStorage();
}


/* ═══════════════════════════════════════════════════════════
   §9 — MAP CLICK HANDLER
   Captures click position and shows the reminder form.
═══════════════════════════════════════════════════════════ */

map.on('click', (e) => {
  const { lat, lng } = e.latlng;
  State.pendingPosition = { lat, lng };

  // Show coordinates in the form header
  DOM.coordsValue.textContent =
    `${lat.toFixed(5)}°, ${lng.toFixed(5)}°`;

  // Reveal the form with animation
  DOM.form.classList.add('is-visible');
  DOM.form.setAttribute('aria-hidden', 'false');

  // Focus the title input for immediate typing
  setTimeout(() => DOM.titleInput.focus(), 50);
});


/* ═══════════════════════════════════════════════════════════
   §10 — FORM ACTIONS: SAVE & CANCEL
═══════════════════════════════════════════════════════════ */

DOM.saveBtn.addEventListener('click', () => {
  const title  = DOM.titleInput.value.trim();
  const radius = parseInt(DOM.radiusInput.value, 10);

  // Validation
  if (!title) {
    DOM.titleInput.focus();
    DOM.titleInput.style.borderColor = 'var(--danger)';
    setTimeout(() => (DOM.titleInput.style.borderColor = ''), 1500);
    return;
  }
  if (!State.pendingPosition) return;
  if (isNaN(radius) || radius < 20) {
    showToast('Minimum radius is 20 metres', 3000);
    DOM.radiusInput.focus();
    return;
  }

  // Build the reminder object
  const reminder = {
    id:        `r_${Date.now()}`,
    title,
    lat:       State.pendingPosition.lat,
    lng:       State.pendingPosition.lng,
    radius,
    triggered: false,
  };

  // Add to state, render on map, update UI
  State.reminders.push(reminder);
  addReminderToMap(reminder);
  addReminderCard(reminder);
  saveToStorage();
  hideForm();

  showToast(`Reminder saved: "${title}"`, 3000);
});

DOM.cancelBtn.addEventListener('click', hideForm);

/** Reset and hide the reminder creation form */
function hideForm() {
  DOM.form.classList.remove('is-visible');
  DOM.form.setAttribute('aria-hidden', 'true');
  DOM.titleInput.value  = '';
  DOM.radiusInput.value = '150';
  DOM.coordsValue.textContent = '—';
  State.pendingPosition = null;
}


/* ═══════════════════════════════════════════════════════════
   §11 — MAP RENDERING (Markers & Circles)
═══════════════════════════════════════════════════════════ */

/** Custom Leaflet DivIcon for reminder pins */
const reminderIcon = L.divIcon({
  className: '',
  html: '<div class="reminder-pin"></div>',
  iconSize: [32, 32],
  iconAnchor: [16, 16],
});

/**
 * Add a Leaflet marker + radius circle to the map for a reminder.
 * Attaches map objects back onto the reminder so we can remove them later.
 * @param {Reminder} reminder
 */
function addReminderToMap(reminder) {
  // Drop-pin marker
  const marker = L.marker([reminder.lat, reminder.lng], {
    icon: reminderIcon,
    title: reminder.title,
  })
    .addTo(map)
    .bindPopup(
      `<strong style="font-family:sans-serif;">${reminder.title}</strong>
       <br/><small>Radius: ${reminder.radius}m</small>`,
      { className: 'geo-popup' }
    );

  // Translucent radius circle
  const circle = L.circle([reminder.lat, reminder.lng], {
    radius: reminder.radius,
    color:        reminder.triggered ? '#10b981' : '#f59e0b',
    fillColor:    reminder.triggered ? '#10b981' : '#f59e0b',
    fillOpacity: 0.08,
    weight: 1.5,
    dashArray: reminder.triggered ? null : '5, 5',
  }).addTo(map);

  // Attach runtime-only Leaflet objects (not persisted to localStorage)
  reminder._marker = marker;
  reminder._circle = circle;
}

/**
 * Update the visual style of an existing circle when a reminder is triggered.
 * @param {Reminder} reminder
 */
function refreshReminderMapStyle(reminder) {
  if (!reminder._circle) return;
  reminder._circle.setStyle({
    color:       '#10b981',
    fillColor:   '#10b981',
    dashArray:   null,
  });
}


/* ═══════════════════════════════════════════════════════════
   §12 — SIDEBAR REMINDER CARDS
═══════════════════════════════════════════════════════════ */

/**
 * Create and append a reminder card to the sidebar list.
 * @param {Reminder} reminder
 */
function addReminderCard(reminder) {
  // Hide the empty state placeholder
  DOM.emptyState.style.display = 'none';

  const card = buildCardElement(reminder);
  DOM.remindersList.appendChild(card);
  updateCount();
}

/**
 * Build the DOM element for a reminder card.
 * @param {Reminder} reminder
 * @returns {HTMLElement}
 */
function buildCardElement(reminder) {
  const card = document.createElement('div');
  card.className = `reminder-card${reminder.triggered ? ' is-triggered' : ''}`;
  card.setAttribute('data-id', reminder.id);
  card.setAttribute('role', 'listitem');

  card.innerHTML = `
    <div class="reminder-card__title">${escapeHtml(reminder.title)}</div>
    <div class="reminder-card__meta">
      <span class="reminder-card__radius">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <circle cx="5" cy="5" r="4" stroke="currentColor" stroke-width="1.2"/>
          <circle cx="5" cy="5" r="1.5" fill="currentColor"/>
        </svg>
        ${reminder.radius}m radius
      </span>
      <span class="reminder-card__coords">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M5 1C3.07 1 1.5 2.57 1.5 4.5C1.5 7 5 9.5 5 9.5C5 9.5 8.5 7 8.5 4.5C8.5 2.57 6.93 1 5 1Z" stroke="currentColor" stroke-width="1.2"/>
          <circle cx="5" cy="4.5" r="1" fill="currentColor"/>
        </svg>
        ${reminder.lat.toFixed(4)}°, ${reminder.lng.toFixed(4)}°
      </span>
    </div>
    <div class="reminder-card__actions">
      <button class="btn btn--danger" data-action="delete" data-id="${reminder.id}">
        Remove
      </button>
    </div>
  `;

  // Clicking the card flies the map to that pin
  card.addEventListener('click', (e) => {
    // Don't fly if we clicked the delete button
    if (e.target.dataset.action === 'delete') return;
    map.flyTo([reminder.lat, reminder.lng], 16, { duration: 0.8 });
    reminder._marker?.openPopup();
  });

  // Delete button
  card.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
    e.stopPropagation();
    deleteReminder(reminder.id);
  });

  return card;
}

/**
 * Update a specific card's visual state after triggering.
 * @param {Reminder} reminder
 */
function refreshReminderCard(reminder) {
  const card = DOM.remindersList.querySelector(`[data-id="${reminder.id}"]`);
  if (card) card.classList.add('is-triggered');
  refreshReminderMapStyle(reminder);
}

/** Update the count badge in the sidebar header */
function updateCount() {
  DOM.remindersCount.textContent = State.reminders.length;
}


/* ═══════════════════════════════════════════════════════════
   §13 — DELETE REMINDER
═══════════════════════════════════════════════════════════ */

/**
 * Remove a reminder from state, the map, and the sidebar.
 * @param {string} id — The reminder's unique ID
 */
function deleteReminder(id) {
  const index = State.reminders.findIndex(r => r.id === id);
  if (index === -1) return;

  const [reminder] = State.reminders.splice(index, 1);

  // Remove Leaflet objects from the map
  if (reminder._marker) map.removeLayer(reminder._marker);
  if (reminder._circle) map.removeLayer(reminder._circle);

  // Remove the card from the DOM
  const card = DOM.remindersList.querySelector(`[data-id="${id}"]`);
  if (card) {
    card.style.transition = 'opacity 0.2s, transform 0.2s';
    card.style.opacity = '0';
    card.style.transform = 'translateX(-10px)';
    setTimeout(() => card.remove(), 200);
  }

  // Show empty state if no reminders remain
  if (State.reminders.length === 0) {
    DOM.emptyState.style.display = '';
  }

  saveToStorage();
  updateCount();
}


/* ═══════════════════════════════════════════════════════════
   §14 — LOCALSTORAGE PERSISTENCE
   Reminder objects are serialised without the runtime-only
   Leaflet _marker and _circle references.
═══════════════════════════════════════════════════════════ */

const STORAGE_KEY = 'geomark_reminders_v1';

/** Serialise the current reminder list to localStorage */
function saveToStorage() {
  // Strip runtime Leaflet objects before serialising
  const serialisable = State.reminders.map(({ id, title, lat, lng, radius, triggered }) => ({
    id, title, lat, lng, radius, triggered,
  }));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(serialisable));
}

/**
 * Load reminders from localStorage and restore the full application state.
 * Called once on page load.
 */
function loadFromStorage() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error('[GeoMark] Failed to parse localStorage data:', err);
    return;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) return;

  // Restore each reminder: add to state, render map objects, render sidebar card
  parsed.forEach(data => {
    const reminder = { ...data };
    State.reminders.push(reminder);
    addReminderToMap(reminder);
    addReminderCard(reminder);
  });

  // Fly map to show all restored reminders
  const group = L.featureGroup(State.reminders.map(r => r._marker));
  if (group.getLayers().length > 0) {
    map.fitBounds(group.getBounds().pad(0.3), { maxZoom: 15 });
  }
}


/* ═══════════════════════════════════════════════════════════
   §15 — QR CODE GENERATION
   Converts the current page URL into a scannable QR code,
   useful for quickly opening the app on a mobile device.
═══════════════════════════════════════════════════════════ */

/**
 * Generate a QR code inside the sidebar container.
 * Requires the QRCode.js library to be loaded.
 */
function generateQRCode() {
  if (typeof QRCode === 'undefined') {
    console.warn('[GeoMark] QRCode.js not loaded — skipping QR generation.');
    return;
  }

  const pageUrl = window.location.href;

  /* eslint-disable no-new */
  new QRCode(DOM.qrContainer, {
    text:           pageUrl,
    width:          140,
    height:         140,
    colorDark:      '#0d1117',  // dark module colour
    colorLight:     '#ffffff',  // light module colour
    correctLevel:   QRCode.CorrectLevel.M, // Medium error correction
  });
}


/* ═══════════════════════════════════════════════════════════
   §16 — UTILITIES
═══════════════════════════════════════════════════════════ */

/**
 * Escape special HTML characters to prevent XSS.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return str.replace(/[&<>"']/g, m => map[m]);
}


/* ═══════════════════════════════════════════════════════════
   §17 — BOOTSTRAP (window.onload)
   Entry point: runs once the page and all scripts are ready.
═══════════════════════════════════════════════════════════ */
window.onload = function init() {
  console.info('[GeoMark] Initialising…');

  // 1. Request browser notification permission
  requestNotificationPermission();

  // 2. Restore any previously saved reminders from localStorage
  loadFromStorage();

  // 3. Start live GPS tracking
  startLocationTracking();

  // 4. Generate the QR code from the current page URL
  generateQRCode();

  // 5. Update initial UI state
  updateCount();
  updateStatus('Acquiring location…', 'loading');

  console.info('[GeoMark] Ready. Click anywhere on the map to add a reminder.');
};
