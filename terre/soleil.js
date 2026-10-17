// ============================================================
//  soleil.js - Position du soleil pour la page TERRE
//  Meme algorithme que lib/Soleil/soleil.cpp : "Approximate Solar
//  Coordinates" de l'USNO (aa.usno.navy.mil/faq/sun_approx, ~0,01 deg de
//  1950 a 2050). Ne pas remplacer par les series NOAA : fausses de 0,42 deg
//  en declinaison.
// ============================================================
const DEG = Math.PI / 180;

// Declinaison (degres) et equation du temps (minutes, > 0 : soleil en avance)
export function ephemeride(ms) {
  const j = (ms / 1000 - 946728000) / 86400;            // jours depuis J2000
  const g = ((357.529 + 0.98560028 * j) % 360) * DEG;   // anomalie moyenne
  const q = (280.459 + 0.98564736 * j) % 360;           // longitude moyenne
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
  const e = (23.439 - 0.00000036 * j) * DEG;            // obliquite
  const decl = Math.asin(Math.sin(e) * Math.sin(L)) / DEG;
  let ad = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / DEG;
  if (ad < 0) ad += 360;
  const eot = (((q - ad + 540) % 360) + 360) % 360 - 180;
  return { decl, eqTemps: eot * 4 };
}

// Point subsolaire (degres)
export function subsolaire(ms) {
  const { decl, eqTemps } = ephemeride(ms);
  const d = new Date(ms);
  const heure = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600 + d.getUTCMilliseconds() / 3600000;
  let lon = -(15 * (heure - 12) + eqTemps / 4);
  while (lon < -180) lon += 360;
  while (lon >= 180) lon -= 360;
  return { lat: decl, lon };
}

// Direction du soleil dans le repere de vue (x droite, y haut, z vers
// l'observateur) pour un globe centre sur lat0, lon0 (degres)
export function soleilDansVue(ms, lat0, lon0) {
  const sub = subsolaire(ms);
  const d = sub.lat * DEG, ls = sub.lon * DEG;
  const s = [Math.cos(d) * Math.cos(ls), Math.cos(d) * Math.sin(ls), Math.sin(d)];
  const p0 = lat0 * DEG, l0 = lon0 * DEG;
  const ex = [-Math.sin(l0), Math.cos(l0), 0];
  const ey = [-Math.sin(p0) * Math.cos(l0), -Math.sin(p0) * Math.sin(l0), Math.cos(p0)];
  const ez = [Math.cos(p0) * Math.cos(l0), Math.cos(p0) * Math.sin(l0), Math.sin(p0)];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return { sv: [dot(s, ex), dot(s, ey), dot(s, ez)], sub };
}

// Vecteur unitaire d'un point (lat, lon en degres) dans le meme repere de vue
export function pointDansVue(lat, lon, lat0, lon0) {
  const p = lat * DEG, l = lon * DEG, p0 = lat0 * DEG, l0 = lon0 * DEG;
  const s = [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
  const ex = [-Math.sin(l0), Math.cos(l0), 0];
  const ey = [-Math.sin(p0) * Math.cos(l0), -Math.sin(p0) * Math.sin(l0), Math.cos(p0)];
  const ez = [Math.cos(p0) * Math.cos(l0), Math.cos(p0) * Math.sin(l0), Math.sin(p0)];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return [dot(s, ex), dot(s, ey), dot(s, ez)];
}
