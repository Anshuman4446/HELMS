// server.js
// Backend for the Smart Helmet crash dispatch system.
// Receives crash reports from the ESP32 (WiFi/HTTP), matches them to a
// jurisdiction zone, and serves the alert list to the dashboard.

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'alerts.json');
const RIDERS_FILE = path.join(__dirname, 'riders.json');
const SUPPORT_FILE = path.join(__dirname, 'support-requests.json');
const HOSPITALS_FILE = path.join(__dirname, 'hospitals.json');
const HOSPITAL_USERNAME = process.env.HOSPITAL_USERNAME || 'hospital-demo';
const HOSPITAL_PASSWORD = process.env.HOSPITAL_PASSWORD || 'hospital-demo';
const HOSPITAL_ID = process.env.HOSPITAL_ID || 'pune-demo-hospital';

// Demo-only credential for the emergency services login. This is NOT real
// security (no hashing, no sessions, no HTTPS enforcement) - it exists only
// to gate access in a prototype. A production system would need proper
// authentication infrastructure.
const SERVICE_USERNAME = 'dispatch';
const SERVICE_PASSWORD = 'dispatch123';

app.use(cors());              // allows the dashboard (a different origin) to call this server
app.use(express.json());      // parses JSON bodies sent by the ESP32

// ---------- Local alert store ----------
// Keep records on disk so completing a rescue or restarting the server does
// not erase the dispatch history.
function loadStore() {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const alerts = Array.isArray(saved) ? saved : (saved && Array.isArray(saved.alerts) ? saved.alerts : []);
    const savedCounter = saved && !Array.isArray(saved) ? Number(saved.counter) || 1000 : 1000;
    const maxId = alerts.reduce((max, alert) => Math.max(max, Number(String(alert.id || '').replace(/^CR-/, '')) || 0), 0);
    return { alerts, counter: Math.max(savedCounter, maxId, 1000) };
  } catch (error) {
    return { alerts: [], counter: 1000 };
  }
}
let { alerts, counter } = loadStore();
function saveStore() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ counter, alerts }, null, 2));
  } catch (error) {
    // Keep serving the live dispatch session even if local disk writes are blocked.
    console.error('Could not save alert history:', error.message);
  }
}

// ---------- Rider profiles ----------
// Keyed by riderId (the same "helmet-01" style ID the ESP32 sends).
function loadRiders() {
  try {
    return JSON.parse(fs.readFileSync(RIDERS_FILE, 'utf8'));
  } catch (error) {
    return {};
  }
}
let riders = loadRiders();
const riderSessions = new Map();
const serviceSessions = new Map();
const hospitalSessions = new Map();
function loadHospitals() {
  try { const value = JSON.parse(fs.readFileSync(HOSPITALS_FILE, 'utf8')); return Array.isArray(value) ? value : []; } catch (error) { return []; }
}
let hospitals = loadHospitals();
function saveHospitals() { try { fs.writeFileSync(HOSPITALS_FILE, JSON.stringify(hospitals, null, 2)); } catch (error) { console.error('Could not save hospital resources:', error.message); } }
function bearerToken(req) { return (req.get('authorization') || '').replace(/^Bearer\s+/i, ''); }
function requireHospital(req, res, next) { const id = hospitalSessions.get(bearerToken(req)); if (!id) return res.status(401).json({ error: 'Hospital session expired. Sign in again.' }); req.hospitalId = id; next(); }
function requireServiceSession(req, res, next) { if (!serviceSessions.has(req.get('x-service-session') || '')) return res.status(401).json({ error: 'Authority session expired. Sign in again.' }); next(); }
function saveRiders() {
  try {
    fs.writeFileSync(RIDERS_FILE, JSON.stringify(riders, null, 2));
  } catch (error) {
    console.error('Could not save rider profiles:', error.message);
  }
}

function requireRider(req, res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const riderId = riderSessions.get(token);
  if (!riderId) return res.status(401).json({ error: 'Please sign in again.' });
  req.riderId = riderId;
  next();
}

function loadSupportRequests() {
  try { const saved = JSON.parse(fs.readFileSync(SUPPORT_FILE, 'utf8')); return Array.isArray(saved) ? saved : []; }
  catch (error) { return []; }
}
let supportRequests = loadSupportRequests();
function saveSupportRequests() {
  try { fs.writeFileSync(SUPPORT_FILE, JSON.stringify(supportRequests, null, 2)); }
  catch (error) { console.error('Could not save support requests:', error.message); }
}
// ---------- Zones ----------
// Pune-area response zones for the local project map.
const zones = [
  { id: 'A', name: 'Zone A — North Pune Precinct', minLat: 18.56, maxLat: 18.72, minLng: 73.65, maxLng: 74.05 },
  { id: 'B', name: 'Zone B — Central Pune Precinct', minLat: 18.48, maxLat: 18.56, minLng: 73.65, maxLng: 74.05 },
  { id: 'C', name: 'Zone C — South Pune Precinct', minLat: 18.36, maxLat: 18.48, minLng: 73.65, maxLng: 74.05 },
];
function fullLocation(lat, lng) {
  // Keep the coordinates visible until the background reverse-geocoder finds
  // an actual mapped street or place. Zone names belong in `zone`, not here.
  return `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`;
}

// Resolve incident coordinates to a nearby real-world address using the
// OpenStreetMap Nominatim reverse-geocoding service. Requests are serialized
// and spaced at least one second apart to respect its public-service policy.
const geocodeCache = new Map();
let geocodeQueue = Promise.resolve();
let lastGeocodeAt = 0;

function addressFromResult(result) {
  const address = result && result.address;
  if (!address) return result && result.name ? result.name : null;
  const city = address.city || address.town || address.village || address.municipality;
  const street = address.road || address.pedestrian || address.footway || address.path;
  const district = address.neighbourhood || address.suburb || address.quarter || address.city_district;
  const parts = [street, district, city, address.state].filter(Boolean);
  return [...new Set(parts)].join(', ') || result.name || result.display_name || null;
}

function queueAddressLookup(alert) {
  const key = `${Number(alert.lat).toFixed(5)},${Number(alert.lng).toFixed(5)}`;
  if (geocodeCache.has(key)) {
    alert.location = geocodeCache.get(key);
    saveStore();
    return;
  }

  geocodeQueue = geocodeQueue.then(async () => {
    const cached = geocodeCache.get(key);
    if (cached) {
      alert.location = cached;
      saveStore();
      return;
    }
    const wait = Math.max(0, 1000 - (Date.now() - lastGeocodeAt));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    lastGeocodeAt = Date.now();
    try {
      const url = new URL('https://nominatim.openstreetmap.org/reverse');
      url.search = new URLSearchParams({
        lat: String(alert.lat), lon: String(alert.lng), format: 'jsonv2', addressdetails: '1', zoom: '18',
      }).toString();
      const response = await fetch(url, {
        headers: { 'User-Agent': 'HELMS-HelmetPrototype/1.0 (local crash-dispatch demonstration)' },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`geocoder returned HTTP ${response.status}`);
      const address = addressFromResult(await response.json());
      if (!address) throw new Error('no mapped address found');
      geocodeCache.set(key, address);
      if (geocodeCache.size > 200) geocodeCache.delete(geocodeCache.keys().next().value);
      // The location may have changed status since lookup began, but its record
      // remains in history; update only the address field and preserve the rest.
      if (alerts.includes(alert)) {
        alert.location = address;
        saveStore();
      }
    } catch (error) {
      console.warn(`Could not resolve address for ${alert.id}:`, error.message);
    }
  }).catch(error => console.error('Address lookup queue error:', error.message));
}

// Migrate the displayed location for saved zone-based records without deleting
// or changing their incident history. Failed lookups retain coordinates.
for (const alert of alerts) {
  if (/^Zone\s+[A-Z]\s*[—-]/i.test(String(alert.location || ''))) {
    alert.location = fullLocation(alert.lat, alert.lng);
    queueAddressLookup(alert);
  }
}
if (alerts.some(alert => /^\d+\.\d{5}, \d+\.\d{5}$/.test(String(alert.location || '')))) saveStore();

function matchZone(lat, lng) {
  for (const z of zones) {
    if (lat >= z.minLat && lat <= z.maxLat && lng >= z.minLng && lng <= z.maxLng) {
      return z;
    }
  }
  return { id: 'OUT', name: 'Outside Pune response area' };
}

// ---------- Routes ----------

// Serve only known frontend pages from the project root. Do not expose the
// whole folder: it contains local rider records and credential hashes.
function servePage(filename) {
  return (req, res) => res.sendFile(path.join(__dirname, '..', filename), error => {
    if (error && !res.headersSent) res.status(404).send(`${filename} is unavailable on this server.`);
  });
}
app.get(['/', '/index.html'], servePage('index.html'));
app.get('/health', (req, res) => res.send('HELMS backend is running.'));
app.get(['/portal', '/portal.html'], servePage('portal.html'));
app.get(['/rider', '/rider.html'], servePage('rider.html'));
app.get(['/rider-portal', '/rider-portal.html'], servePage('rider-portal.html'));
app.get(['/service-provider', '/authority', '/authority-portal.html'], servePage('authority-portal.html'));
app.get('/service-login.html', servePage('service-login.html'));
app.get(['/hospital-resources', '/hospital-resources.html'], servePage('hospital-resources.html'));
app.get(['/police-dashboard', '/police-dashboard.html'], servePage('police-dashboard.html'));
app.get('/helms-logo.svg', servePage('helms-logo.svg'));
app.get('/helms-logo-light.svg', servePage('helms-logo-light.svg'));
app.get('/brand-migration.js', servePage('brand-migration.js'));
app.get(['/dashboard', '/dashboard-live.html'], servePage('dashboard-live.html'));

// ESP32 calls this when a crash is detected
// Expects JSON body: { lat: 18.52, lng: 73.86, riderId: "helmet-01" }
app.post('/crash', (req, res) => {
  const { lat, lng, riderId } = req.body;

  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'lat and lng must be numbers' });
  }

  counter++;
  const zone = matchZone(lat, lng);
  const alert = {
    id: 'CR-' + counter,
    riderId: riderId || 'unknown-helmet',
    lat, lng,
    zone: zone.name,
    zoneId: zone.id,
    location: fullLocation(lat, lng),
    time: new Date().toISOString(),
    status: 'pending', // pending -> dispatched | cancelled
  };

  alerts.unshift(alert);
  saveStore();
  queueAddressLookup(alert);
  console.log('New crash alert:', alert.id, '-', alert.zone);
  res.status(201).json(alert);
});

// Dispatch visibility and rider cancellation use one server-side deadline.
const RIDER_CANCEL_WINDOW_MS = 45_000;
const CANCELLED_PIN_LIFETIME_MS = 30_000;
function alertDispatchAt(alert) { const explicit = Date.parse(alert.dispatchAt || ''); return Number.isFinite(explicit) ? explicit : Date.parse(alert.time) + RIDER_CANCEL_WINDOW_MS; }
app.get('/alerts', (req, res) => {
  const now = Date.now();
  const dispatchAlerts = alerts.filter(alert => {
    const age = now - new Date(alert.time).getTime();
    return !alert.suppressedFromDispatch && now >= alertDispatchAt(alert);
  }).map(alert => {
    const rider = riders[alert.riderId] || {};
    const pinVisibleAt = alertDispatchAt(alert);
    const cancelledAt = new Date(alert.cancelledAt || alert.time).getTime();
    return {
      ...alert,
      riderName: rider.name || '',
      riderPhone: rider.phone || '',
      bloodGroup: rider.bloodGroup || '',
      medicalNotes: rider.medicalNotes || '',
      emergencyContacts: (rider.emergencyContacts || []).map(contact => ({ name: contact.name, phone: contact.phone })),
      cancelledPinExpiresAt: alert.status === 'cancelled'
        ? new Date(Math.max(pinVisibleAt, cancelledAt) + CANCELLED_PIN_LIFETIME_MS).toISOString()
        : null,
    };
  });
  res.json(dispatchAlerts);
});

// Dashboard and rider update an alert status or hide its map pin.
app.patch('/alerts/:id', (req, res) => {
  const alert = alerts.find(a => a.id === req.params.id);
  if (!alert) return res.status(404).json({ error: 'alert not found' });

  const authorization = req.get('authorization') || '';
  if (authorization) {
    const token = authorization.replace(/^Bearer\s+/i, '');
    const signedInRider = riderSessions.get(token);
    if (!signedInRider || signedInRider !== alert.riderId) return res.status(403).json({ error: 'This alert does not belong to the signed-in rider.' });
    const isHelpRequest = req.body.helpRequested === true && req.body.status === undefined && req.body.hideCancelledDot === undefined;
    if (req.body.status && req.body.status !== 'cancelled') return res.status(403).json({ error: 'Riders can only cancel their own pending alert.' });
    if (req.body.helpRequested !== undefined && (typeof req.body.helpRequested !== 'boolean' || !isHelpRequest)) return res.status(400).json({ error: 'Invalid help request.' });
    if (isHelpRequest && alert.status !== 'pending') return res.status(409).json({ error: 'This incident is no longer awaiting a response.' });
    if (req.body.status === 'cancelled' && (alert.status !== 'pending' || Date.now() >= alertDispatchAt(alert))) {
      return res.status(409).json({ error: 'The cancellation window has closed.' });
    }
  }

  const { status, hideCancelledDot } = req.body;
  if (status !== undefined && !['pending', 'dispatched', 'cancelled', 'completed'].includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  if (hideCancelledDot !== undefined && typeof hideCancelledDot !== 'boolean') {
    return res.status(400).json({ error: 'hideCancelledDot must be a boolean' });
  }

  if (status !== undefined) {
    alert.status = status;
    alert.statusChangedAt = new Date().toISOString();
    if (status === 'completed' || status === 'cancelled') {
      let released = false;
      hospitals.forEach(hospital => (hospital.ambulances || []).forEach(unit => {
        if (unit.assignedIncidentId === alert.id) { unit.status = 'available'; delete unit.assignedIncidentId; unit.updatedAt = alert.statusChangedAt; released = true; }
      }));
      if (released) saveHospitals();
    }
    if (status === 'cancelled') {
      alert.cancelledAt = alert.statusChangedAt;
      // Rider cancellations stay in that rider's account history but never
      // appear in the service dashboard queue, map, or all-riders history.
      if (authorization) alert.suppressedFromDispatch = true;
    }
  }
  if (authorization && req.body.helpRequested === true) {
    const now = Date.now();
    if (now >= alertDispatchAt(alert)) return res.status(409).json({ error: 'The response timer has already ended.' });
    alert.helpRequested = true;
    alert.helpRequestedAt = alert.helpRequestedAt || new Date(now).toISOString();
    const remainingMs = alertDispatchAt(alert) - now;
    if (remainingMs > 10_000) alert.dispatchAt = new Date(now + 10_000).toISOString();
  }
  if (hideCancelledDot !== undefined && alert.status === 'cancelled') alert.hideCancelledDot = hideCancelledDot;
  saveStore();
  res.json(alert);
});

// Rider sign-in is a local demonstration account flow. Passwords are hashed,
// while real deployment still needs HTTPS, managed identity and account provisioning.
app.post('/rider-auth/register', (req, res) => {
  const riderId = String(req.body.riderId || '').trim();
  const password = String(req.body.password || '');
  const details = req.body.profile || {};
  const name = String(details.name || '').trim();
  const phone = String(details.phone || '').trim();
  const emergencyContacts = Array.isArray(details.emergencyContacts) ? details.emergencyContacts : [];
  if (!/^[a-z0-9-]{3,32}$/i.test(riderId)) return res.status(400).json({ error: 'Use a Helmet ID with 3–32 letters, numbers or hyphens.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (emergencyContacts.some(contact => Boolean(String(contact?.name || '').trim()) !== Boolean(String(contact?.phone || '').trim()))) {
    return res.status(400).json({ error: 'For each emergency contact, enter both the name and phone number.' });
  }
  if (!name || !phone || !emergencyContacts.some(contact => contact && String(contact.name || '').trim() && String(contact.phone || '').trim())) {
    return res.status(400).json({ error: 'Enter your name, phone number, and at least one emergency contact name and phone.' });
  }
  const profile = riders[riderId] || { riderId, name: '', phone: '', bloodGroup: '', emergencyContacts: [] };
  if (profile.passwordHash) return res.status(409).json({ error: 'This Helmet ID already has an account. Sign in instead.' });
  profile.name = name;
  profile.phone = phone;
  profile.bloodGroup = String(details.bloodGroup || '').trim();
  profile.medicalNotes = String(details.medicalNotes || '').trim().slice(0, 500);
  profile.emergencyContacts = emergencyContacts.slice(0, 2).map(contact => ({
    name: String(contact.name || '').trim().slice(0, 80),
    phone: String(contact.phone || '').trim().slice(0, 40),
  }));
  profile.updatedAt = new Date().toISOString();
  const salt = crypto.randomBytes(16).toString('hex');
  profile.passwordSalt = salt;
  profile.passwordHash = crypto.scryptSync(password, salt, 64).toString('hex');
  riders[riderId] = profile;
  saveRiders();
  const token = crypto.randomBytes(32).toString('hex');
  riderSessions.set(token, riderId);
  res.status(201).json({ token, riderId, profile: publicRiderProfile(profile) });
});

app.post('/rider-auth/login', (req, res) => {
  const riderId = String(req.body.riderId || '').trim();
  const password = String(req.body.password || '');
  const profile = riders[riderId];
  if (!profile || !profile.passwordHash || !profile.passwordSalt) return res.status(401).json({ error: 'Helmet ID or password is incorrect. If this is your first visit, create an account.' });
  const actual = crypto.scryptSync(password, profile.passwordSalt, 64);
  const expected = Buffer.from(profile.passwordHash, 'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return res.status(401).json({ error: 'Helmet ID or password is incorrect.' });
  const token = crypto.randomBytes(32).toString('hex');
  riderSessions.set(token, riderId);
  res.json({ token, riderId, profile: publicRiderProfile(profile) });
});

function publicRiderProfile(profile) {
  const { passwordHash, passwordSalt, ...safe } = profile;
  return safe;
}

app.get('/rider/me', requireRider, (req, res) => {
  res.json(publicRiderProfile(riders[req.riderId]));
});

app.put('/rider/me', requireRider, (req, res) => {
  const { name, phone, bloodGroup, medicalNotes, emergencyContacts } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'name and phone are required' });
  const contacts = Array.isArray(emergencyContacts) ? emergencyContacts.slice(0, 2) : [];
  if (contacts.some(contact => Boolean(String(contact?.name || '').trim()) !== Boolean(String(contact?.phone || '').trim()))) {
    return res.status(400).json({ error: 'For each emergency contact, enter both the name and phone number.' });
  }

  const existing = riders[req.riderId] || {};
  riders[req.riderId] = {
    ...existing,
    riderId: req.riderId,
    name,
    phone,
    bloodGroup: bloodGroup || '',
    medicalNotes: String(medicalNotes || '').trim().slice(0, 500),
    emergencyContacts: contacts.map(contact => ({
      name: String(contact.name || '').trim().slice(0, 80),
      phone: String(contact.phone || '').trim().slice(0, 40),
    })).filter(contact => contact.name && contact.phone),
    updatedAt: new Date().toISOString(),
  };
  saveRiders();
  res.json(publicRiderProfile(riders[req.riderId]));
});

app.get('/rider/alerts', requireRider, (req, res) => {
  const now = Date.now();
  res.json(alerts.filter(alert => alert.riderId === req.riderId).map(alert => ({
    ...alert,
    remainingSeconds: alert.status === 'pending'
      ? Math.max(0, Math.ceil((alertDispatchAt(alert) - now) / 1000))
      : 0,
  })));
});

app.post('/rider/support', requireRider, (req, res) => {
  const topic = String(req.body.topic || '').trim().slice(0, 80);
  const message = String(req.body.message || '').trim().slice(0, 1200);
  if (!topic || message.length < 5) return res.status(400).json({ error: 'Choose a topic and enter a message of at least 5 characters.' });
  const ticket = {
    id: 'SH-' + Date.now().toString(36).toUpperCase(),
    riderId: req.riderId,
    topic,
    message,
    createdAt: new Date().toISOString(),
    delivery: 'demo-only: saved locally; no staff notified',
  };
  supportRequests.unshift(ticket);
  saveSupportRequests();
  res.status(201).json(ticket);
});

// Demo-only sessions; not production authentication.
app.post('/service-login', (req, res) => {
  const { username, password } = req.body;
  if (username === SERVICE_USERNAME && password === SERVICE_PASSWORD) {
    const token = crypto.randomBytes(32).toString('hex'); serviceSessions.set(token, true);
    return res.json({ success: true, token });
  }
  res.status(401).json({ success: false, error: 'invalid credentials' });
});
app.post('/hospital-auth/login', (req, res) => {
  if (String(req.body.username || '') !== HOSPITAL_USERNAME || String(req.body.password || '') !== HOSPITAL_PASSWORD) return res.status(401).json({ error: 'Hospital username or password is incorrect.' });
  const token = crypto.randomBytes(32).toString('hex'); hospitalSessions.set(token, HOSPITAL_ID); res.json({ token, hospitalId: HOSPITAL_ID });
});
app.get('/hospital/resources', requireHospital, (req, res) => {
  res.json(hospitals.find(item => item.id === req.hospitalId) || { id: req.hospitalId, name: '', address: '', publicPhone: '', lat: null, lng: null, ambulances: [] });
});
app.put('/hospital/resources', requireHospital, (req, res) => {
  const body = req.body || {}, name = String(body.name || '').trim().slice(0, 120), address = String(body.address || '').trim().slice(0, 240), publicPhone = String(body.publicPhone || '').trim().slice(0, 40), lat = Number(body.lat), lng = Number(body.lng);
  if (!name || !address || !publicPhone || !Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) return res.status(400).json({ error: 'Enter hospital name, official contact, address, and valid coordinates.' });
  if (!Array.isArray(body.ambulances) || body.ambulances.length > 50) return res.status(400).json({ error: 'Upload at most 50 ambulance records.' });
  const previous = hospitals.find(item => item.id === req.hospitalId), oldUnits = new Map((previous?.ambulances || []).map(unit => [unit.unitId, unit])), ids = new Set(), ambulances = [];
  for (const item of body.ambulances) {
    const unitId = String(item?.unitId || '').trim().slice(0, 40), plate = String(item?.plate || '').trim().slice(0, 24), statusInput = String(item?.status || 'available'), driver = item?.driver || {}, driverName = String(driver.name || '').trim().slice(0, 100), driverPhone = String(driver.phone || '').trim().slice(0, 40), crewInput = Array.isArray(item?.crew) ? item.crew.slice(0, 4) : [];
    if (!unitId || !plate || !driverName || !['available', 'busy', 'out_of_service'].includes(statusInput) || ids.has(unitId)) return res.status(400).json({ error: 'Each ambulance needs a unique unit ID, plate, driver, and valid availability.' });
    ids.add(unitId);
    const crew = crewInput.map(person => ({ name: String(person?.name || '').trim().slice(0, 100), role: String(person?.role || '').trim().slice(0, 60), phone: String(person?.phone || '').trim().slice(0, 40) })).filter(person => person.name && person.role);
    const old = oldUnits.get(unitId), status = old?.assignedIncidentId ? 'busy' : statusInput;
    ambulances.push({ unitId, plate, status, driver: { name: driverName, phone: driverPhone }, crew, updatedAt: new Date().toISOString(), ...(old?.assignedIncidentId ? { assignedIncidentId: old.assignedIncidentId } : {}) });
  }
  const record = { id: req.hospitalId, name, address, publicPhone, lat, lng, ambulances, updatedAt: new Date().toISOString() };
  hospitals = hospitals.filter(item => item.id !== req.hospitalId); hospitals.push(record); saveHospitals(); res.json(record);
});
// Only operational identifiers and official hospital contact leave this endpoint; crew identities stay in the hospital portal.
app.get('/dispatch/hospital-ambulances', requireServiceSession, (req, res) => {
  const availableAmbulances = hospitals.flatMap(hospital => (hospital.ambulances || []).filter(unit => unit.status === 'available').map(unit => ({ hospitalId: hospital.id, hospitalName: hospital.name, name: hospital.name, hospitalAddress: hospital.address, hospitalPhone: hospital.publicPhone, unitId: unit.unitId, plate: unit.plate, lat: hospital.lat, lng: hospital.lng, kind: 'ambulance', facilityType: 'registered hospital ambulance', status: unit.status, simulated: false })));
  res.json({ hasRegisteredHospitals: hospitals.length > 0, availableAmbulances });
});
app.post('/dispatch/assign-ambulance', requireServiceSession, (req, res) => {
  const alert = alerts.find(item => item.id === req.body.alertId);
  if (!alert || alert.status !== 'dispatched') return res.status(409).json({ error: 'Dispatch this incident before assigning an ambulance.' });
  const hospital = hospitals.find(item => item.id === req.body.hospitalId), unit = hospital?.ambulances?.find(item => item.unitId === req.body.unitId);
  if (!hospital || !unit || unit.status !== 'available') return res.status(409).json({ error: 'That ambulance is no longer available. Finding the next available hospital unit.' });
  if (alert.ambulanceAssignment?.unitId === unit.unitId && alert.ambulanceAssignment?.hospitalId === hospital.id) return res.json(alert.ambulanceAssignment);
  if (hospitals.some(item => (item.ambulances || []).some(candidate => candidate.assignedIncidentId === alert.id))) return res.status(409).json({ error: 'An ambulance is already assigned to this incident.' });
  unit.status = 'busy'; unit.assignedIncidentId = alert.id; unit.updatedAt = new Date().toISOString();
  const route = req.body.route && typeof req.body.route === 'object' ? req.body.route : {};
  alert.ambulanceAssignment = { hospitalId: hospital.id, hospitalName: hospital.name, hospitalAddress: hospital.address, hospitalPhone: hospital.publicPhone, unitId: unit.unitId, plate: unit.plate, lat: hospital.lat, lng: hospital.lng, assignedAt: unit.updatedAt, facilityType: 'registered hospital ambulance', simulated: false, routeGeometry: route.geometry || null, routeDistance: Number.isFinite(route.distance) ? route.distance : null, routeDuration: Number.isFinite(route.duration) ? route.duration : null, routeStreets: Array.isArray(route.streets) ? route.streets.slice(0, 8) : [] };
  saveHospitals(); saveStore(); res.json(alert.ambulanceAssignment);
});
app.post('/dispatch/record-ambulance-route', requireServiceSession, (req, res) => {
  const alert = alerts.find(item => item.id === req.body.alertId);
  const { facilityName, lat, lng, route } = req.body;
  if (!alert || alert.status !== 'dispatched') return res.status(409).json({ error: 'Dispatch this incident before recording its route.' });
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !facilityName || !route?.geometry || route.geometry.type !== 'LineString' || !Array.isArray(route.geometry.coordinates)) return res.status(400).json({ error: 'A mapped base and road route are required.' });
  alert.ambulanceAssignment = { hospitalName: String(facilityName).slice(0, 180), hospitalAddress: 'Mapped medical response location', hospitalPhone: '', unitId: 'SIMULATED AMBULANCE', plate: '', lat, lng, assignedAt: new Date().toISOString(), facilityType: String(req.body.facilityType || 'mapped hospital or ambulance base').slice(0, 100), simulated: true, routeGeometry: route.geometry, routeDistance: Number.isFinite(route.distance) ? route.distance : null, routeDuration: Number.isFinite(route.duration) ? route.duration : null, routeStreets: Array.isArray(route.streets) ? route.streets.slice(0, 8).map(value => String(value).slice(0, 100)) : [] };
  saveStore(); res.json(alert.ambulanceAssignment);
});
app.get('/police/dispatch', requireServiceSession, (req, res) => res.json(alerts.filter(item => item.status === 'dispatched').map(item => ({ id: item.id, time: item.time, status: item.status, statusChangedAt: item.statusChangedAt, location: item.location, lat: item.lat, lng: item.lng, ambulance: item.ambulanceAssignment ? { hospitalName: item.ambulanceAssignment.hospitalName, hospitalAddress: item.ambulanceAssignment.hospitalAddress, hospitalPhone: item.ambulanceAssignment.hospitalPhone, unitId: item.ambulanceAssignment.unitId, plate: item.ambulanceAssignment.plate, lat: item.ambulanceAssignment.lat, lng: item.ambulanceAssignment.lng, facilityType: item.ambulanceAssignment.facilityType, simulated: item.ambulanceAssignment.simulated, routeGeometry: item.ambulanceAssignment.routeGeometry, routeDistance: item.ambulanceAssignment.routeDistance, routeDuration: item.ambulanceAssignment.routeDuration, routeStreets: item.ambulanceAssignment.routeStreets } : null }))));

app.listen(PORT, () => {
  console.log(`Crash dispatch backend listening on http://localhost:${PORT}`);
  console.log(`Test it: open http://localhost:${PORT} in a browser`);
});
