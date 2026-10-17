// ============================================================
//  terre.js - Globe jour / nuit en temps reel (fond d'ecran)
//  Port WebGL2 de l'ecran TERRE de MultiClock (lib/Terre/terre_ecran.cpp,
//  reference outils/terre_simulateur.py) : meme projection orthographique,
//  memes constantes d'eclairage, sans les textes. Avions en orbite dessines
//  sur un calque 2D anime.
//
//  Vue : glisser = faire tourner le globe ; molette / pincement = taille ;
//  clic droit, Maj+glisser ou deux doigts = deplacer ; double clic = recentrer.
//  Reglages : panneau (bouton engrenage, visible quand la souris bouge),
//  gardes dans le navigateur (localStorage). Priorite : URL > reglages
//  gardes > defauts. Parametres d'URL = noms de DEFAUTS ci-dessous, plus
//    t   instant fige, ISO UTC (2026-10-11T16:50:00Z)
// ============================================================
import { soleilDansVue, pointDansVue } from "./soleil.js";

const VERSION = "2.0";

const DEFAUTS = {
  lat: 43.6, lon: 1.4,          // centre de la vue, degres
  taille: 0.8,                  // diametre du globe / petit cote de l'ecran
  cx: 0.5, cy: 0.5,             // centre du globe, fraction de l'ecran
  etoiles: 600,                 // nombre d'etoiles (MAX_ETOILES au plus)
  ombre: 0.5,                   // luminosite de la face cachee (hors villes)
  villes: 0.5,                  // luminosite des lumieres des villes
  crepuscule: 0,                // 1 = lignes -6 / -12 / -18 deg
  brume: 1,                     // voile atmospherique + lisere cote eclaire
  brumeEp: 1,                   // epaisseur (1 = firmware)
  brumeLum: 1,                  // intensite (1 = firmware)
  brumeTeinte: "#78aaff",       // (120, 170, 255) du firmware
  avions: 3,                    // nombre d'avions
  avionTaille: 1,               // 1 = 16 px de long
  avionDist: 0.12,              // altitude, en rayons du globe
  avionVit: 0.5,                // tours par minute
  iss: 1,                       // station spatiale internationale
  issTaille: 1,                 // 1 = 24 px de long
  issTrace: 1,                  // trace de l'orbite (passe plein, avenir pointille)
};
const CLE_STOCKAGE = "terre.reglages";
const MAX_ETOILES = 3000;

const params = new URLSearchParams(location.search);
const INSTANT_FIGE = params.has("t") ? Date.parse(params.get("t")) : NaN;

function convertit(cle, texte) {
  if (typeof DEFAUTS[cle] === "string") return /^#[0-9a-fA-F]{6}$/.test(texte) ? texte : undefined;
  const v = parseFloat(texte);
  return Number.isFinite(v) ? v : undefined;
}

const reglages = { ...DEFAUTS };
try {
  const garde = JSON.parse(localStorage.getItem(CLE_STOCKAGE) || "{}");
  for (const cle in DEFAUTS) {
    if (garde[cle] === undefined) continue;
    const v = convertit(cle, String(garde[cle]));
    if (v !== undefined) reglages[cle] = v;
  }
} catch (e) { /* stockage indisponible : defauts */ }
for (const cle in DEFAUTS) {
  if (!params.has(cle)) continue;
  const v = convertit(cle, params.get(cle));
  if (v !== undefined) reglages[cle] = v;
}

const toile = document.getElementById("toile");
const calque = document.getElementById("avions");
const ctx = calque.getContext("2d");
const msg = document.getElementById("msg");
function erreur(texte) {
  msg.textContent = texte;
  msg.style.display = "flex";
}

const gl = toile.getContext("webgl2", { antialias: false, alpha: false, preserveDrawingBuffer: true });
if (!gl) erreur("WebGL2 indisponible dans ce navigateur.");

// ------------------------------------------------------------
//  Shader : fond, etoiles, globe, lisere (constantes du firmware)
// ------------------------------------------------------------
const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;          // taille du tampon en pixels
uniform vec2 uC;            // centre du globe (pixels, y vers le haut)
uniform float uR;           // rayon du globe en pixels
uniform vec2 uP;            // lat0, lon0 en radians
uniform vec3 uSv;           // direction du soleil dans le repere de vue
uniform float uOmbre;       // luminosite de la face cachee
uniform float uVilles;      // luminosite des villes
uniform float uCrep;        // lignes de crepuscule
uniform vec3 uBrume;        // teinte de la brume (0..255)
uniform float uBrumeEp;     // epaisseur de la brume
uniform float uBrumeLum;    // intensite de la brume (0 = sans)
uniform sampler2D uJour, uNuitTex, uLut, uEtoiles;
out vec4 sortie;

const float PI = 3.14159265358979;

float lisse(float a, float b, float x) {
  float t = clamp((x - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
float bruit(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 p = gl_FragCoord.xy - uC;
  float rho = length(p);

  // ---- fond : lois du firmware assombries, distances en rayons ----
  vec3 col = vec3(1.0, 2.0, 6.0);
  float th = clamp(1.0 - (rho - uR) / (uR * (230.0 / 96.0)), 0.0, 1.0);
  col += th * th * vec3(3.0, 8.0, 22.0);
  float vy = 1.0 - gl_FragCoord.y / uRes.y;
  col += vy * vy * vy * vec3(1.0, 2.0, 5.0);
  col /= 255.0;
  col = max(col, texture(uEtoiles, vec2(gl_FragCoord.x / uRes.x, vy)).rgb * lisse(1.0, 1.12, rho / uR));

  // ---- halo atmospherique hors du disque, cote eclaire : somme de trois
  //      exponentielles (coeur fin + aureoles larges), fondu sans arete ----
  vec2 dirLimbe = p / max(rho, 1.0);
  float h = max(rho - uR, 0.0) / uR;
  float halo = 0.50 * exp(-h / (0.016 * uBrumeEp)) + 0.30 * exp(-h / (0.05 * uBrumeEp))
             + 0.14 * exp(-h / (0.16 * uBrumeEp));
  float cote = lisse(-0.35, 0.7, dot(dirLimbe, uSv.xy));
  col += uBrume / 255.0 * halo * cote * 0.85 * uBrumeLum;

  // ---- globe : projection orthographique (calculee pour tous les pixels,
  //      les derivees de textureGrad exigent un flot uniforme) ----
  vec2 q = p / uR;
  float rho2 = dot(q, q);
  float pz = sqrt(max(1.0 - rho2, 0.0004));
  float sinP = sin(uP.x), cosP = cos(uP.x);
  float lat = asin(clamp(pz * sinP + q.y * cosP, -1.0, 1.0));
  float lonRel = atan(q.x, pz * cosP - q.y * sinP);
  float v = 0.5 - lat / PI;
  // longitude : deux decoupes differentes, on garde les derivees de celle
  // qui est continue ici (sinon trait visible a la couture)
  float uRaw = (uP.y + lonRel) / (2.0 * PI) + 0.5;
  float ua = fract(uRaw), ub = fract(uRaw + 0.5);
  vec2 gax = vec2(dFdx(ua), dFdy(ua)), gbx = vec2(dFdx(ub), dFdy(ub));
  bool choixA = dot(gax, gax) < dot(gbx, gbx);
  vec2 gu = choixA ? gax : gbx;
  vec2 gv = vec2(dFdx(v), dFdy(v));
  vec2 duv_dx = vec2(gu.x, gv.x), duv_dy = vec2(gu.y, gv.y);
  vec2 uv = vec2(ua, v);

  float L = q.x * uSv.x + q.y * uSv.y + pz * uSv.z;
  float f = lisse(-0.10, 0.06, L);

  // jour : Lambert adouci + voile atmospherique. Epaisseur d'air traversee
  // ~ 1/pz : le voile croit en douceur vers le limbe (pas de bord net), il est
  // module par l'eclairement et vire au chaud vers le terminateur.
  vec3 jr = textureGrad(uJour, uv, duv_dx, duv_dy).rgb * 255.0;
  float ecl = 0.35 + 0.65 * sqrt(max(L, 0.0));
  float air = 1.0 / (pz + 0.12) - 1.0 / 1.12;
  float soleilHaut = lisse(-0.25, 0.5, L);
  float voile = (1.0 - exp(-0.11 * uBrumeEp * air)) * soleilHaut * 0.95 * uBrumeLum;
  voile = min(voile, 0.92);
  vec3 teinte = mix(uBrume, vec3(255.0, 150.0, 90.0), 0.4 * (1.0 - lisse(0.0, 0.4, L)));
  vec3 jour = jr * ecl * (1.0 - voile) + teinte * mix(0.55, 1.0, lisse(0.0, 0.5, L)) * voile;

  // nuit : luminance -> palette (couleur moyenne reelle du niveau) x gain ;
  // gain du firmware 0,55 -> 1,60 de l'ombre aux villes, chacun regle a part
  vec3 nt = textureGrad(uNuitTex, uv, duv_dx, duv_dy).rgb;
  float lum = floor(clamp((nt.r + nt.g + nt.b) / 3.0 * 255.0, 0.0, 255.0));
  vec3 lut = texelFetch(uLut, ivec2(int(lum), 0), 0).rgb * 255.0;
  float k = clamp((lum - 40.0) / 80.0, 0.0, 1.0);
  vec3 nuit = lut * mix(0.55 * uOmbre, 1.60 * uVilles, k);

  vec3 pix = nuit * (1.0 - f) + jour * f;
  if (uCrep > 0.5) {
    for (int i = 0; i < 3; i++) {
      float s = i == 0 ? -0.1045 : (i == 1 ? -0.2079 : -0.3090);
      float a = i == 0 ? 0.8 : (i == 1 ? 0.55 : 0.35);
      float w = clamp(1.0 - abs(L - s) / 0.006, 0.0, 1.0) * a;
      pix = pix * (1.0 - w) + vec3(255.0, 170.0, 60.0) * w;
    }
  }
  float couv = clamp(uR - rho + 0.5, 0.0, 1.0);
  col = mix(col, min(pix, 255.0) / 255.0, couv);

  col += (bruit(gl_FragCoord.xy) - 0.5) / 255.0;     // evite les bandes du degrade
  sortie = vec4(col, 1.0);
}`;

function compile(type, source) {
  const s = gl.createShader(type);
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

const UNIFORMES = ["uRes", "uC", "uR", "uP", "uSv", "uOmbre", "uVilles", "uCrep", "uBrume", "uBrumeEp",
  "uBrumeLum", "uJour", "uNuitTex", "uLut", "uEtoiles"];
let programme, uni = {}, texEtoiles;

function initGL() {
  programme = gl.createProgram();
  gl.attachShader(programme, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(programme, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(programme);
  if (!gl.getProgramParameter(programme, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(programme));
  gl.useProgram(programme);
  for (const n of UNIFORMES) uni[n] = gl.getUniformLocation(programme, n);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const pos = gl.getAttribLocation(programme, "aPos");
  gl.enableVertexAttribArray(pos);
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
}

function chargeImage(url) {
  return new Promise((ok, ko) => {
    const im = new Image();
    im.onload = () => ok(im);
    im.onerror = () => ko(new Error("image introuvable : " + url));
    im.src = url;
  });
}

function textureCarte(unite, image) {
  const t = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unite);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const ext = gl.getExtension("EXT_texture_filter_anisotropic");
  if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT,
    Math.min(8, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  return t;
}

// Palette de nuit : pour chaque niveau de luminance 0..255, couleur moyenne
// reelle des pixels de la carte COMPLETE a ce niveau (niveaux absents
// interpoles) - outils/terre.py palette_nuit()
function palette(image) {
  const c = document.createElement("canvas");
  c.width = image.naturalWidth; c.height = image.naturalHeight;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(image, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const somme = new Float64Array(768), nb = new Float64Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const lum = Math.min(255, (d[i] + d[i + 1] + d[i + 2]) / 3 | 0);
    somme[lum * 3] += d[i]; somme[lum * 3 + 1] += d[i + 1]; somme[lum * 3 + 2] += d[i + 2];
    nb[lum]++;
  }
  const pleins = [];
  for (let i = 0; i < 256; i++) if (nb[i] > 0) pleins.push(i);
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    for (let k = 0; k < 3; k++) {
      let val;
      if (nb[i] > 0) val = somme[i * 3 + k] / nb[i];
      else {
        let a = -1, b = -1;
        for (const p of pleins) { if (p < i) a = p; else if (p > i && b < 0) b = p; }
        if (a < 0) val = somme[b * 3 + k] / nb[b];
        else if (b < 0) val = somme[a * 3 + k] / nb[a];
        else {
          const va = somme[a * 3 + k] / nb[a], vb = somme[b * 3 + k] / nb[b];
          val = va + (vb - va) * (i - a) / (b - a);
        }
      }
      lut[i * 4 + k] = Math.round(val);
    }
    lut[i * 4 + 3] = 255;
  }
  const t = gl.createTexture();
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

// ------------------------------------------------------------
//  Etoiles : tirage fixe (graine 7), memes lois de luminosite (60..230) et
//  de teinte que outils/lune.py ; positions normalisees 0..1. Les N
//  premieres sont affichees : augmenter le nombre ajoute des etoiles sans
//  deplacer les autres.
// ------------------------------------------------------------
function aleaGraine(a) {           // mulberry32
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function choix(alea, valeurs, probas) {
  let x = alea();
  for (let i = 0; i < valeurs.length - 1; i++) { if (x < probas[i]) return valeurs[i]; x -= probas[i]; }
  return valeurs[valeurs.length - 1];
}
const ETOILES = (() => {
  const alea = aleaGraine(7), liste = [];
  for (let i = 0; i < MAX_ETOILES; i++) {
    const u = alea(), v = alea();
    const b = choix(alea, [60, 90, 120, 170, 230], [0.35, 0.25, 0.2, 0.13, 0.07]);
    const te = choix(alea, [0, 1, 2], [0.7, 0.18, 0.12]);
    liste.push([u, v, b, te]);
  }
  return liste;
})();

const TEINTES = [[1, 1, 1], [0.8, 0.88, 1], [1, 0.92, 0.78]];
function dessineEtoiles(l, h, dpr) {
  const c = document.createElement("canvas");
  c.width = l; c.height = h;
  const g = c.getContext("2d");
  g.fillStyle = "#000";
  g.fillRect(0, 0, l, h);
  const n = Math.min(MAX_ETOILES, Math.max(0, Math.round(reglages.etoiles)));
  for (let i = 0; i < n; i++) {
    const [u, v, b, te] = ETOILES[i];
    const x = u * l, y = v * h;
    const t = TEINTES[te];
    const couleur = (k) => `rgb(${Math.round(t[0] * b * k)},${Math.round(t[1] * b * k)},${Math.round(t[2] * b * k)})`;
    const rayon = dpr * (0.55 + b / 230 * 0.55);
    g.fillStyle = couleur(1);
    g.beginPath(); g.arc(x, y, rayon, 0, 2 * Math.PI); g.fill();
    if (b >= 170) {                                           // croix des plus brillantes
      g.fillStyle = couleur(0.35);
      const e = rayon * 1.6;
      g.fillRect(x - e - rayon, y - rayon * 0.5, e, rayon);
      g.fillRect(x + rayon, y - rayon * 0.5, e, rayon);
      g.fillRect(x - rayon * 0.5, y - e - rayon, rayon, e);
      g.fillRect(x - rayon * 0.5, y + rayon, rayon, e);
    }
  }
  gl.activeTexture(gl.TEXTURE3);
  if (!texEtoiles) {
    texEtoiles = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texEtoiles);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  gl.bindTexture(gl.TEXTURE_2D, texEtoiles);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
}

// ------------------------------------------------------------
//  Rendu du globe (une image toutes les 30 s, ou a chaque reglage / geste)
// ------------------------------------------------------------
let enAttente = false;
let pret = false, derniereCle = "", dernierCreneau = -1;
let vue = { l: 1, h: 1, dpr: 1, cx: 0, cy: 0, R: 1 };
let soleil = [0, 0, 1];

function geometrie() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const l = Math.max(1, Math.round(toile.clientWidth * dpr));
  const h = Math.max(1, Math.round(toile.clientHeight * dpr));
  return { dpr, l, h };
}

// Les gestes demandent un rendu ; il est fait au plus une fois par image.
function demandeRendu() {
  if (enAttente) return;
  enAttente = true;
  requestAnimationFrame(() => rendu(true));
}

function couleurRvb(hexa) {
  const n = parseInt(hexa.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rendu(forcer) {
  if (!pret) return;
  const ms = Number.isFinite(INSTANT_FIGE) ? INSTANT_FIGE : Date.now();
  const { dpr, l, h } = geometrie();
  const cle = [l, h, dpr, reglages.etoiles].join("|");
  const creneau = Math.floor(ms / 30000);               // soleil : 0,125 deg par 30 s
  if (!forcer && cle === derniereCle && creneau === dernierCreneau) return;
  enAttente = false;

  const R = reglages.taille * Math.min(l, h) / 2;
  const cx = reglages.cx * l, cy = reglages.cy * h;     // cy du haut de l'ecran
  vue = { l, h, dpr, cx, cy, R };
  if (cle !== derniereCle) {
    toile.width = l; toile.height = h;
    calque.width = l; calque.height = h;
    dessineEtoiles(l, h, dpr);
    derniereCle = cle;
  }
  dernierCreneau = creneau;

  soleil = soleilDansVue(ms, reglages.lat, reglages.lon).sv;
  const brume = couleurRvb(reglages.brumeTeinte);
  gl.viewport(0, 0, l, h);
  gl.uniform2f(uni.uRes, l, h);
  gl.uniform2f(uni.uC, cx, h - cy);
  gl.uniform1f(uni.uR, R);
  gl.uniform2f(uni.uP, reglages.lat * Math.PI / 180, reglages.lon * Math.PI / 180);
  gl.uniform3f(uni.uSv, soleil[0], soleil[1], soleil[2]);
  gl.uniform1f(uni.uOmbre, reglages.ombre);
  gl.uniform1f(uni.uVilles, reglages.villes);
  gl.uniform1f(uni.uCrep, reglages.crepuscule ? 1 : 0);
  gl.uniform3f(uni.uBrume, brume[0], brume[1], brume[2]);
  gl.uniform1f(uni.uBrumeEp, Math.max(0.05, reglages.brumeEp));
  gl.uniform1f(uni.uBrumeLum, reglages.brume ? reglages.brumeLum : 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  document.title = "Terre - " + new Date(ms).toISOString().slice(0, 16) + "Z";
  window.terrePrete = true;
}

// ------------------------------------------------------------
//  Avions : orbites circulaires d'inclinaison aleatoire, en 3D dans le
//  repere de vue (x droite, y haut, z vers l'observateur), projetes comme
//  le globe. Caches derriere le disque, assombris dans l'ombre de la Terre.
// ------------------------------------------------------------
const avions = [];

function nouvelAvion() {
  // normale de l'orbite uniforme sur la sphere -> angle aleatoire autour du globe
  const z = Math.random() * 2 - 1, phi = Math.random() * 2 * Math.PI, s = Math.sqrt(1 - z * z);
  const n = [s * Math.cos(phi), s * Math.sin(phi), z];
  const ref = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const a = normalise(vectoriel(n, ref)), b = vectoriel(n, a);
  return {
    a, b,
    theta: Math.random() * 2 * Math.PI,
    sens: Math.random() < 0.5 ? -1 : 1,
    facteurDist: 0.85 + Math.random() * 0.3,
    facteurVit: 0.7 + Math.random() * 0.6,
    phaseFeu: Math.random(),
  };
}
function vectoriel(u, v) {
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}
function normalise(u) {
  const n = Math.hypot(u[0], u[1], u[2]);
  return [u[0] / n, u[1] / n, u[2] / n];
}
function ajusteFlotte() {
  const n = Math.max(0, Math.round(reglages.avions));
  while (avions.length < n) avions.push(nouvelAvion());
  avions.length = n;
}

function positionAvion(av, theta) {
  const d = 1 + reglages.avionDist * av.facteurDist;
  const c = Math.cos(theta), s = Math.sin(theta);
  return [d * (av.a[0] * c + av.b[0] * s), d * (av.a[1] * c + av.b[1] * s), d * (av.a[2] * c + av.b[2] * s)];
}
function cache(P) {
  return P[2] < 0 && P[0] * P[0] + P[1] * P[1] < 1;
}
function eclaire(P) {
  const d = P[0] * soleil[0] + P[1] * soleil[1] + P[2] * soleil[2];
  return d > 0 || P[0] * P[0] + P[1] * P[1] + P[2] * P[2] - d * d > 1;
}

const LONGUEUR_TRAINEE = 0.5;     // radians d'orbite
const SEGMENTS_TRAINEE = 18;

function dessineAvion(av, t) {
  const { cx, cy, R, dpr } = vue;
  const ecran = (P) => [cx + R * P[0], cy - R * P[1]];
  const P = positionAvion(av, av.theta);
  const allume = eclaire(P);

  // trainee : segments de plus en plus transparents vers l'arriere
  const taille = 16 * reglages.avionTaille * dpr;
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(1, taille * 0.12);
  let prec = P;
  for (let i = 1; i <= SEGMENTS_TRAINEE; i++) {
    const Q = positionAvion(av, av.theta - av.sens * LONGUEUR_TRAINEE * i / SEGMENTS_TRAINEE);
    if (!cache(prec) && !cache(Q)) {
      const alpha = 0.45 * (1 - i / SEGMENTS_TRAINEE) * (eclaire(Q) ? 1 : 0.3);
      const [x0, y0] = ecran(prec), [x1, y1] = ecran(Q);
      ctx.strokeStyle = `rgba(225, 235, 255, ${alpha.toFixed(3)})`;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
    prec = Q;
  }
  if (cache(P)) return;

  // cap a l'ecran et raccourci quand l'avion vient vers nous ou s'eloigne
  const V = [av.sens * (-av.a[0] * Math.sin(av.theta) + av.b[0] * Math.cos(av.theta)),
             av.sens * (-av.a[1] * Math.sin(av.theta) + av.b[1] * Math.cos(av.theta)),
             av.sens * (-av.a[2] * Math.sin(av.theta) + av.b[2] * Math.cos(av.theta))];
  const vPlan = Math.hypot(V[0], V[1]);
  const raccourci = Math.max(0.25, vPlan);
  const [x, y] = ecran(P);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.atan2(-V[1], V[0]));
  ctx.scale(taille / 16 * (1 + 0.12 * P[2]), taille / 16 * (1 + 0.12 * P[2]));

  // silhouette (nez vers +x, 16 unites de long)
  ctx.save();
  ctx.scale(raccourci, 1);
  ctx.fillStyle = allume ? "#e9eef8" : "#3c4766";
  ctx.beginPath();
  ctx.moveTo(8, 0);
  ctx.quadraticCurveTo(7, -1.1, 4, -1.1);
  ctx.lineTo(1, -1.1); ctx.lineTo(-2, -7.5); ctx.lineTo(-3.6, -7.5); ctx.lineTo(-2.2, -1.1);
  ctx.lineTo(-5.6, -1.0); ctx.lineTo(-7, -3.6); ctx.lineTo(-8, -3.6); ctx.lineTo(-7.4, -0.6);
  ctx.lineTo(-8, 0);
  ctx.lineTo(-7.4, 0.6); ctx.lineTo(-8, 3.6); ctx.lineTo(-7, 3.6); ctx.lineTo(-5.6, 1.0);
  ctx.lineTo(-2.2, 1.1); ctx.lineTo(-3.6, 7.5); ctx.lineTo(-2, 7.5); ctx.lineTo(1, 1.1);
  ctx.lineTo(4, 1.1);
  ctx.quadraticCurveTo(7, 1.1, 8, 0);
  ctx.fill();
  ctx.restore();

  // feu anticollision rouge : un eclat par seconde
  if (((t / 1000 + av.phaseFeu) % 1) < 0.12) {
    ctx.fillStyle = "rgba(255, 60, 50, 0.95)";
    ctx.beginPath(); ctx.arc(0, 0, 1.3, 0, 2 * Math.PI); ctx.fill();
  }
  ctx.restore();
}

// ------------------------------------------------------------
//  ISS : api.wheretheiss.at (CORS ouvert, sans cle). Une seule requete rend
//  10 positions espacees de 6 min (24 min passees, 30 min a venir) ; entre
//  deux positions on interpole sur le grand cercle, donc aucun appel reseau
//  pendant l'affichage. Derniere reponse gardee pour un demarrage hors
//  ligne.
// ------------------------------------------------------------
const ISS_URL = "https://api.wheretheiss.at/v1/satellites/25544/positions";
const CLE_ISS = "terre.iss";
const PAS_ISS = 360;                       // secondes entre deux positions
const RAYON_TERRE_KM = 6371;
let issPos = [];                           // {t (ms), lat, lon, alt (km)}
let issProchainEssai = 0;

function instant() { return Number.isFinite(INSTANT_FIGE) ? INSTANT_FIGE : Date.now(); }

try {
  const garde = JSON.parse(localStorage.getItem(CLE_ISS) || "[]");
  if (Array.isArray(garde) && garde.every((e) => Number.isFinite(e.t + e.lat + e.lon + e.alt))) issPos = garde;
} catch (e) { /* pas de cache */ }

async function chargeIss() {
  const t0 = Math.floor(instant() / 1000);
  const ts = [];
  for (let k = -4; k <= 5; k++) ts.push(t0 + k * PAS_ISS);
  const rep = await fetch(`${ISS_URL}?timestamps=${ts.join(",")}&units=kilometers`);
  if (!rep.ok) throw new Error("ISS : HTTP " + rep.status);
  const j = await rep.json();
  const pos = j.map((e) => ({ t: e.timestamp * 1000, lat: e.latitude, lon: e.longitude, alt: e.altitude }))
    .filter((e) => Number.isFinite(e.t + e.lat + e.lon + e.alt)).sort((p, q) => p.t - q.t);
  if (pos.length < 2) throw new Error("ISS : reponse vide");
  issPos = pos;
  try { localStorage.setItem(CLE_ISS, JSON.stringify(pos)); } catch (e) { /* ignore */ }
}

// Rafraichit quand la fenetre de positions touche a sa fin (ou est vide) ;
// apres un echec on attend une minute avant de reessayer.
function verifieIss(maintenant) {
  if (!reglages.iss || maintenant < issProchainEssai) return;
  const fin = issPos.length ? issPos[issPos.length - 1].t : 0;
  if (fin - instant() > 10 * 60000 && issPos[0].t <= instant()) return;
  issProchainEssai = maintenant + 60000;
  chargeIss().then(() => { issProchainEssai = maintenant + 5 * 60000; }).catch(() => {});
}

const vecteurGeo = (lat, lon) => {
  const p = lat * Math.PI / 180, l = lon * Math.PI / 180;
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
};

// Position de l'ISS a l'instant ms dans le repere de vue (rayons du globe),
// ou null si l'instant sort de la fenetre connue
function issDansVue(ms) {
  if (issPos.length < 2 || ms < issPos[0].t || ms > issPos[issPos.length - 1].t) return null;
  let i = 0;
  while (i < issPos.length - 2 && ms > issPos[i + 1].t) i++;
  const A = issPos[i], B = issPos[i + 1];
  const f = (ms - A.t) / (B.t - A.t);
  const u = vecteurGeo(A.lat, A.lon), v = vecteurGeo(B.lat, B.lon);
  const c = Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]));
  const om = Math.acos(c), so = Math.sin(om);
  const ka = so < 1e-6 ? 1 - f : Math.sin((1 - f) * om) / so;
  const kb = so < 1e-6 ? f : Math.sin(f * om) / so;
  const w = [ka * u[0] + kb * v[0], ka * u[1] + kb * v[1], ka * u[2] + kb * v[2]];
  const lat = Math.asin(Math.max(-1, Math.min(1, w[2]))) * 180 / Math.PI;
  const lon = Math.atan2(w[1], w[0]) * 180 / Math.PI;
  const d = 1 + (A.alt + (B.alt - A.alt) * f) / RAYON_TERRE_KM;
  const P = pointDansVue(lat, lon, reglages.lat, reglages.lon);
  return [P[0] * d, P[1] * d, P[2] * d];
}

function dessineIss() {
  const ms = instant();
  const P = issDansVue(ms);
  if (!P) return;
  const { cx, cy, R, dpr } = vue;
  const ecran = (Q) => [cx + R * Q[0], cy - R * Q[1]];

  if (reglages.issTrace) {
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(1, 1.6 * dpr);
    let prec = null;
    for (let m = -24; m <= 30; m++) {
      const Q = issDansVue(ms + m * 60000);
      if (Q && prec && !cache(prec) && !cache(Q)) {
        const passe = m <= 0;
        const alpha = (passe ? 0.15 + 0.5 * (1 + m / 24) : 0.45 * (1 - m / 30)) * (eclaire(Q) ? 1 : 0.45);
        ctx.setLineDash(passe ? [] : [4 * dpr, 5 * dpr]);
        ctx.strokeStyle = `rgba(150, 200, 255, ${alpha.toFixed(3)})`;
        const [x0, y0] = ecran(prec), [x1, y1] = ecran(Q);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
      prec = Q;
    }
    ctx.setLineDash([]);
  }
  if (cache(P)) return;

  // la ferme est perpendiculaire a la vitesse, vue a l'ecran
  const Q = issDansVue(ms + 20000) || P;
  const [x, y] = ecran(P), [xq, yq] = ecran(Q);
  const cap = Math.atan2(yq - y, xq - x);
  const allume = eclaire(P);
  const u = reglages.issTaille * dpr * (1 + 0.1 * P[2]);   // 1 unite = 1 px, ferme de 24 unites

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(cap + Math.PI / 2);
  ctx.scale(u, u);
  const halo = ctx.createRadialGradient(0, 0, 1, 0, 0, 16);
  halo.addColorStop(0, allume ? "rgba(170, 210, 255, 0.35)" : "rgba(90, 120, 180, 0.2)");
  halo.addColorStop(1, "rgba(170, 210, 255, 0)");
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(0, 0, 16, 0, 2 * Math.PI); ctx.fill();

  const panneau = allume ? "#e2b04e" : "#5b5036";
  const coque = allume ? "#f1f4fb" : "#4a5470";
  ctx.fillStyle = coque;
  ctx.fillRect(-12, -0.7, 24, 1.4);                          // ferme, perpendiculaire a la vitesse
  ctx.fillStyle = panneau;
  for (const sx of [-1, 1]) {
    ctx.fillRect(sx * 9.5 - 1.8, -10, 3.6, 8);              // grands panneaux, de part et d'autre de la ferme
    ctx.fillRect(sx * 9.5 - 1.8, 2, 3.6, 8);
    ctx.fillRect(sx * 3.8 - 1.5, -8, 3, 6);
    ctx.fillRect(sx * 3.8 - 1.5, 2, 3, 6);
  }
  ctx.fillStyle = coque;
  ctx.fillRect(-1.6, -3.2, 3.2, 6.4);                        // modules
  ctx.restore();

  ctx.font = `bold ${16 * dpr}px sans-serif`;
  ctx.textBaseline = "middle";
  ctx.fillStyle = allume ? "rgba(205, 225, 255, 0.95)" : "rgba(120, 140, 185, 0.9)";
  ctx.shadowColor = "rgba(0, 0, 0, 0.8)";
  ctx.shadowBlur = 4 * dpr;
  ctx.fillText("ISS", x + 16 * reglages.issTaille * dpr, y - 14 * reglages.issTaille * dpr);
  ctx.shadowBlur = 0;
}

// ------------------------------------------------------------
//  Boucle d'animation du calque (avions + ISS)
// ------------------------------------------------------------
let dernierT = 0, boucleActive = false;
function anime(t) {
  if (!avions.length && !reglages.iss) {
    ctx.clearRect(0, 0, calque.width, calque.height);
    boucleActive = false;
    return;
  }
  requestAnimationFrame(anime);
  if (t - dernierT < 33) return;                        // ~30 images / s suffisent
  const dt = dernierT ? Math.min(0.2, (t - dernierT) / 1000) : 0;
  dernierT = t;
  const omega = 2 * Math.PI * reglages.avionVit / 60;
  ctx.clearRect(0, 0, calque.width, calque.height);
  if (reglages.iss) { verifieIss(t); dessineIss(); }
  for (const av of avions) {
    av.theta += av.sens * omega * av.facteurVit * dt;
    dessineAvion(av, t);
  }
}
function lanceAnimation() {
  ajusteFlotte();
  if (!boucleActive && (avions.length || reglages.iss)) {
    boucleActive = true;
    dernierT = 0;
    requestAnimationFrame(anime);
  } else if (!avions.length && !reglages.iss) {
    ctx.clearRect(0, 0, calque.width, calque.height);
  }
}

// ------------------------------------------------------------
//  Panneau de reglages
// ------------------------------------------------------------
const engrenage = document.getElementById("engrenage");
const panneau = document.getElementById("panneau");
const champs = [...document.querySelectorAll("#panneau [data-cle]")];
document.getElementById("version").textContent = "Version " + VERSION;

function sauve() {
  try { localStorage.setItem(CLE_STOCKAGE, JSON.stringify(reglages)); } catch (e) { /* ignore */ }
  // reglages retires de l'URL : au rechargement ils ecraseraient ceux gardes
  const p = new URLSearchParams(location.search);
  for (const cle in DEFAUTS) p.delete(cle);
  history.replaceState(null, "", location.pathname + (p.toString() ? "?" + p : ""));
}

function decimales(pas) {
  const s = String(pas);
  return s.includes(".") ? s.length - s.indexOf(".") - 1 : 0;
}
function afficheChamp(el) {
  const cle = el.dataset.cle;
  if (el.type === "checkbox") el.checked = !!reglages[cle];
  else el.value = reglages[cle];
  const sortie = el.parentElement.querySelector("output");
  if (sortie) sortie.textContent = Number(reglages[cle]).toFixed(decimales(el.step || 1));
}

function applique(cle) {
  if (cle.startsWith("avion")) {
    if (cle === "avions") lanceAnimation();
    return;
  }
  if (cle.startsWith("iss")) {
    if (cle === "iss") lanceAnimation();
    return;
  }
  rendu(true);
}

for (const el of champs) {
  afficheChamp(el);
  el.addEventListener("input", () => {
    const cle = el.dataset.cle;
    reglages[cle] = el.type === "checkbox" ? (el.checked ? 1 : 0)
      : el.type === "color" ? el.value : parseFloat(el.value);
    afficheChamp(el);
    sauve();
    applique(cle);
  });
}

function lienComplet() {
  const p = new URLSearchParams();
  for (const cle in DEFAUTS) if (reglages[cle] !== DEFAUTS[cle]) p.set(cle, reglages[cle]);
  return location.origin + location.pathname + (p.toString() ? "?" + p : "");
}
const bLien = document.getElementById("bLien");
const texteLien = bLien.textContent;
bLien.addEventListener("click", async () => {
  const lien = lienComplet();
  try {
    await navigator.clipboard.writeText(lien);
    bLien.textContent = bLien.dataset.ok;
  } catch (e) {
    window.prompt("", lien);
  }
  setTimeout(() => { bLien.textContent = texteLien; }, 1800);
});
document.getElementById("bDefaut").addEventListener("click", () => {
  Object.assign(reglages, DEFAUTS);
  for (const el of champs) afficheChamp(el);
  sauve();
  lanceAnimation();
  rendu(true);
});
document.getElementById("bFermer").addEventListener("click", () => panneau.classList.remove("ouvert"));
engrenage.addEventListener("click", () => panneau.classList.toggle("ouvert"));

// ------------------------------------------------------------
//  Gestes : un doigt / bouton gauche = faire tourner le globe ; molette ou
//  pincement = taille (autour du curseur / des doigts) ; clic droit, milieu,
//  Maj+glisser ou deux doigts = deplacer ; double clic / double tape =
//  taille et position par defaut.
// ------------------------------------------------------------
const TAILLE_MIN = 0.15, TAILLE_MAX = 4, CENTRE_MIN = -1, CENTRE_MAX = 2;
const bornes = (x, a, b) => Math.max(a, Math.min(b, x));
const pointeurs = new Map();                       // id -> {x, y, mode, x0, y0, t0}
const CHAMPS_VUE = ["lat", "lon", "taille", "cx", "cy"];
let minuterieSauvegarde = 0, dernierTape = null;

function metAJourVue() {
  reglages.taille = bornes(reglages.taille, TAILLE_MIN, TAILLE_MAX);
  reglages.cx = bornes(reglages.cx, CENTRE_MIN, CENTRE_MAX);
  reglages.cy = bornes(reglages.cy, CENTRE_MIN, CENTRE_MAX);
  reglages.lat = bornes(reglages.lat, -90, 90);
  reglages.lon = ((reglages.lon + 180) % 360 + 360) % 360 - 180;
  for (const el of champs) if (CHAMPS_VUE.includes(el.dataset.cle)) afficheChamp(el);
  demandeRendu();
  clearTimeout(minuterieSauvegarde);
  minuterieSauvegarde = setTimeout(sauve, 400);
}

const rayonCss = () => reglages.taille * Math.min(toile.clientWidth, toile.clientHeight) / 2;

function tourne(dx, dy) {
  const R = rayonCss();
  const coslat = Math.max(Math.cos(reglages.lat * Math.PI / 180), 0.3);     // pres des poles, 1 px ne vaut plus 1 px de longitude
  reglages.lat += dy / R * 180 / Math.PI;
  reglages.lon -= dx / (R * coslat) * 180 / Math.PI;
  metAJourVue();
}
function deplace(dx, dy) {
  reglages.cx += dx / toile.clientWidth;
  reglages.cy += dy / toile.clientHeight;
  metAJourVue();
}
// la taille change autour du point (fx, fy) de l'ecran, qui reste fixe
function zoome(fx, fy, ratio) {
  const t = bornes(reglages.taille * ratio, TAILLE_MIN, TAILLE_MAX);
  ratio = t / reglages.taille;
  const l = toile.clientWidth, h = toile.clientHeight;
  reglages.cx = (fx + (reglages.cx * l - fx) * ratio) / l;
  reglages.cy = (fy + (reglages.cy * h - fy) * ratio) / h;
  reglages.taille = t;
  metAJourVue();
}
function recentre() {
  reglages.taille = DEFAUTS.taille;
  reglages.cx = DEFAUTS.cx;
  reglages.cy = DEFAUTS.cy;
  metAJourVue();
}

toile.addEventListener("contextmenu", (e) => e.preventDefault());
toile.addEventListener("pointerdown", (e) => {
  try { toile.setPointerCapture(e.pointerId); } catch (err) { /* pointeur deja relache */ }
  const deplacer = e.pointerType === "mouse" && (e.button !== 0 || e.shiftKey);
  pointeurs.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: e.timeStamp,
                               mode: deplacer ? "deplace" : "tourne" });
});
toile.addEventListener("pointermove", (e) => {
  const p = pointeurs.get(e.pointerId);
  if (!p) return;
  const nx = e.clientX, ny = e.clientY;
  if (pointeurs.size === 1) {
    if (p.mode === "deplace") deplace(nx - p.x, ny - p.y);
    else tourne(nx - p.x, ny - p.y);
  } else if (pointeurs.size === 2) {
    // deux doigts : le milieu entraine le globe, l'ecart change la taille
    const autre = [...pointeurs].find(([id]) => id !== e.pointerId)[1];
    const d0 = Math.hypot(p.x - autre.x, p.y - autre.y), d1 = Math.hypot(nx - autre.x, ny - autre.y);
    const m0x = (p.x + autre.x) / 2, m0y = (p.y + autre.y) / 2;
    const m1x = (nx + autre.x) / 2, m1y = (ny + autre.y) / 2;
    reglages.cx += (m1x - m0x) / toile.clientWidth;
    reglages.cy += (m1y - m0y) / toile.clientHeight;
    if (d0 > 8) zoome(m1x, m1y, d1 / d0); else metAJourVue();
  }
  p.x = nx; p.y = ny;
});
function finGeste(e) {
  const p = pointeurs.get(e.pointerId);
  if (!p) return;
  pointeurs.delete(e.pointerId);
  // double tape / double clic : deux appuis courts et immobiles, rapproches
  const court = e.type === "pointerup" && e.timeStamp - p.t0 < 300 && Math.hypot(p.x - p.x0, p.y - p.y0) < 10;
  if (!court || pointeurs.size) { dernierTape = null; return; }
  if (dernierTape && e.timeStamp - dernierTape.t < 400 && Math.hypot(p.x - dernierTape.x, p.y - dernierTape.y) < 30) {
    dernierTape = null;
    recentre();
  } else {
    dernierTape = { t: e.timeStamp, x: p.x, y: p.y };
  }
}
toile.addEventListener("pointerup", finGeste);
toile.addEventListener("pointercancel", finGeste);
toile.addEventListener("wheel", (e) => {
  e.preventDefault();
  const k = e.deltaMode === 1 ? 0.05 : (e.ctrlKey ? 0.01 : 0.0015);        // ctrlKey : pincement du pave tactile
  zoome(e.clientX, e.clientY, Math.exp(-e.deltaY * k));
}, { passive: false });

// engrenage visible seulement quand la souris bouge (fond d'ecran discret)
let minuterieEngrenage = 0;
function montreEngrenage() {
  engrenage.classList.add("visible");
  clearTimeout(minuterieEngrenage);
  minuterieEngrenage = setTimeout(() => {
    if (!panneau.classList.contains("ouvert")) engrenage.classList.remove("visible");
  }, 3000);
}
window.addEventListener("mousemove", montreEngrenage);
window.addEventListener("pointerdown", montreEngrenage);
window.addEventListener("touchstart", montreEngrenage, { passive: true });
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") panneau.classList.remove("ouvert");
  else if (e.key === "r" || e.key === "R") { panneau.classList.toggle("ouvert"); montreEngrenage(); }
});

// ------------------------------------------------------------
//  Demarrage
// ------------------------------------------------------------
async function demarre() {
  initGL();
  const [jour, nuit] = await Promise.all([chargeImage("textures/jour.jpg"), chargeImage("textures/nuit.jpg")]);
  textureCarte(0, jour);
  textureCarte(1, nuit);
  palette(nuit);
  gl.uniform1i(uni.uJour, 0);
  gl.uniform1i(uni.uNuitTex, 1);
  gl.uniform1i(uni.uLut, 2);
  gl.uniform1i(uni.uEtoiles, 3);
  pret = true;
  rendu(true);
  lanceAnimation();
  window.addEventListener("resize", () => rendu(false));
  if (!Number.isFinite(INSTANT_FIGE)) setInterval(() => rendu(false), 5000);
}

if (gl) demarre().catch((e) => erreur(String(e.message || e)));
