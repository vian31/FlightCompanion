// ============================================================
//  terre.js - Globe jour / nuit en temps reel (fond d'ecran)
//  Port WebGL2 de l'ecran TERRE de MultiClock (lib/Terre/terre_ecran.cpp,
//  reference outils/terre_simulateur.py) : meme projection orthographique,
//  memes constantes d'eclairage, sans les textes.
//
//  Trois couches superposees :
//    toile   (WebGL2, shader ci-dessous) : ciel (etoiles, galaxies, Soleil),
//            globe jour/nuit, brume
//    iss3d   (three.js) : Lune et ISS en 3D, voile de brume par-dessus ce qui
//            passe derriere le globe
//    avions  (2D) : avions, traces, etiquettes ; ce qui est derriere le globe
//            ou la Lune y est masque a la main
//  Repere de vue : x droite, y haut, z vers l'observateur, 1 = rayon du globe.
//
//  Vue : glisser = faire tourner le globe ; molette / pincement = taille ;
//  clic droit, Maj+glisser ou deux doigts = deplacer ; double clic = recentrer.
//  Reglages : panneau (bouton engrenage, visible quand la souris bouge),
//  gardes dans le navigateur (localStorage). Priorite : URL > reglages
//  gardes > defauts. Parametres d'URL = noms de DEFAUTS ci-dessous, plus
//    t   instant fige, ISO UTC (2026-10-11T16:50:00Z)
//
//  Source modulaire (index.html) ; fond.html / fond.js sont generes par
//  scripts/build_terre.mjs.
// ============================================================
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { soleilDansVue, dansVue, vecteurGeo } from "./soleil.js";

const VERSION = "4.1";
const RAD = Math.PI / 180;

const DEFAUTS = {
  lat: 43.6, lon: 1.4,          // centre de la vue, degres
  taille: 0.8,                  // diametre du globe / petit cote de l'ecran
  cx: 0.5, cy: 0.5,             // centre du globe, fraction de l'ecran
  etoiles: 600,                 // nombre d'etoiles (MAX_ETOILES au plus)
  galaxies: 6,                  // galaxies lointaines (MAX_GALAXIES au plus)
  soleilVisible: 1,             // le Soleil, dans le ciel
  soleilTaille: 1,              // 1 = disque de 0,06 rayon du globe
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
  issTaille: 1.5,               // 1 = ferme de 0,18 rayon du globe (suit le zoom)
  issLabel: 1,                  // etiquette "ISS"
  issTrace: 1,                  // trace de l'orbite (trait continu, s'estompe aux extremites)
  issCouleur: "#96c8ff",        // couleur de la trace
  issReflet: 1,                 // intensite des reflets sur les panneaux solaires
  issPrevision: 0,              // heures de trace a venir au-dela de la trace courte (0 = aucune, 12 au plus), etiquettes +4 h, +8 h...
  lune: 1,                      // Lune en orbite autour du globe
  luneTaille: 0.22,             // rayon de la Lune, en rayons du globe (reel : 0,27)
  luneDist: 1.8,                // distance au centre du globe, en rayons du globe (reel : 60)
  luneVit: 0.2,                 // tours par minute (0 = direction et phase reelles, temps reel)
  luneReel: 0,                  // 1 = vraies proportions : rayon 0,27 et distance 60 rayons terrestres
};
const CLE_STOCKAGE = "terre.reglages";
const MAX_ETOILES = 3000, MAX_GALAXIES = 12;

// Version autonome (fond.html, voir scripts/build_terre.mjs) : textures et modele
// ISS integres en data: URI par fond-assets.js, donc rien a charger en reseau
// (utile en file://, ou les navigateurs bloquent modules, fetch et textures WebGL).
const ASSETS = window.TERRE_ASSETS || {};
function binaire(uriData) {
  const bin = atob(uriData.slice(uriData.indexOf(",") + 1)), o = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i);
  return o.buffer;
}

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
uniform vec2 uSun;          // position du Soleil dans le ciel (pixels, y vers le haut)
uniform float uSunR;        // rayon du disque solaire, en rayons du globe (0 = pas de Soleil)
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

  // ---- Soleil : disque blanc, halo en trois echelles, croix de diffraction ----
  if (uSunR > 0.0) {
    vec2 ps = gl_FragCoord.xy - uSun;
    float rs = length(ps) / uR;
    float halo = 0.9 * exp(-rs / (uSunR * 2.5)) + 0.35 * exp(-rs / (uSunR * 10.0)) + 0.12 * exp(-rs / (uSunR * 40.0));
    float croix = pow(abs(cos(2.0 * atan(ps.y, ps.x))), 60.0) * exp(-rs / (uSunR * 14.0)) * 0.5;
    col += vec3(1.0, 0.92, 0.78) * (halo + croix);
    col = mix(col, vec3(1.0, 0.98, 0.93), smoothstep(uSunR * 1.15, uSunR * 0.85, rs));
  }

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
  "uBrumeLum", "uSun", "uSunR", "uJour", "uNuitTex", "uLut", "uEtoiles"];
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

// Galaxies lointaines : spirales vues sous des inclinaisons variees (noyau chaud,
// bras bleutes en spirale logarithmique, nuage de points), fixes comme les etoiles.
const GALAXIES = (() => {
  const alea = aleaGraine(11), liste = [];
  for (let i = 0; i < MAX_GALAXIES; i++) {
    liste.push({ u: 0.05 + 0.9 * alea(), v: 0.05 + 0.9 * alea(), taille: 0.012 + 0.05 * Math.pow(alea(), 1.6),
      angle: alea() * Math.PI, incl: alea() * 1.25, bras: alea() < 0.5 ? 2 : 3, graine: Math.floor(alea() * 1e9) });
  }
  return liste;
})();

function dessineGalaxie(g, x, y, rayon, gal, dpr) {
  const alea = aleaGraine(gal.graine);
  g.save();
  g.translate(x, y);
  g.rotate(gal.angle);
  g.scale(1, Math.cos(gal.incl) * 0.85 + 0.15);                      // disque vu plus ou moins de profil
  g.globalCompositeOperation = "lighter";
  const noyau = g.createRadialGradient(0, 0, 0, 0, 0, rayon * 0.9);
  noyau.addColorStop(0, "rgba(255, 238, 205, 0.9)");
  noyau.addColorStop(0.18, "rgba(255, 220, 170, 0.45)");
  noyau.addColorStop(0.55, "rgba(150, 170, 255, 0.12)");
  noyau.addColorStop(1, "rgba(120, 150, 255, 0)");
  g.fillStyle = noyau;
  g.beginPath(); g.arc(0, 0, rayon * 0.9, 0, 2 * Math.PI); g.fill();
  const n = Math.round(rayon * 7);
  for (let i = 0; i < n; i++) {
    const r = rayon * Math.pow(alea(), 0.75);
    const th = (r / rayon) * 3.4 + (i % gal.bras) * 2 * Math.PI / gal.bras + (alea() + alea() + alea() - 1.5) * 0.45;
    const t = r / rayon;
    g.fillStyle = `rgba(${Math.round(255 - 125 * t)}, ${Math.round(225 - 55 * t)}, 255, ${(0.1 + 0.3 * alea() * (1 - 0.5 * t)).toFixed(3)})`;
    g.fillRect(r * Math.cos(th), r * Math.sin(th), dpr * 0.9, dpr * 0.9);
  }
  g.restore();
}

function dessineEtoiles(l, h, dpr) {
  const c = document.createElement("canvas");
  c.width = l; c.height = h;
  const g = c.getContext("2d");
  g.fillStyle = "#000";
  g.fillRect(0, 0, l, h);
  const ng = Math.min(MAX_GALAXIES, Math.max(0, Math.round(reglages.galaxies)));
  for (let i = 0; i < ng; i++) {
    const gal = GALAXIES[i];
    dessineGalaxie(g, gal.u * l, gal.v * h, gal.taille * Math.min(l, h), gal, dpr);
  }
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
  const cle = [l, h, dpr, reglages.etoiles, reglages.galaxies].join("|");
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
  gl.uniform2f(uni.uP, reglages.lat * RAD, reglages.lon * RAD);
  gl.uniform3f(uni.uSv, soleil[0], soleil[1], soleil[2]);
  gl.uniform1f(uni.uOmbre, reglages.ombre);
  gl.uniform1f(uni.uVilles, reglages.villes);
  gl.uniform1f(uni.uCrep, reglages.crepuscule ? 1 : 0);
  gl.uniform3f(uni.uBrume, brume[0], brume[1], brume[2]);
  gl.uniform1f(uni.uBrumeEp, Math.max(0.05, reglages.brumeEp));
  gl.uniform1f(uni.uBrumeLum, reglages.brume ? reglages.brumeLum : 0);
  // Soleil : projete a 6 rayons dans sa direction ; s'il est de notre cote du globe
  // (on le verrait devant la Terre), on le repousse au-dela du disque, du cote eclaire
  let dx = soleil[0] * 6, dy = soleil[1] * 6;
  const longueur = Math.hypot(dx, dy);
  if (soleil[2] > 0 && longueur < 1.7) {
    const [ux, uy] = longueur < 1e-3 ? [-0.6, 0.8] : [dx / longueur, dy / longueur];
    dx = ux * 1.7; dy = uy * 1.7;
  }
  gl.uniform2f(uni.uSun, cx + R * dx, h - cy + R * dy);
  gl.uniform1f(uni.uSunR, reglages.soleilVisible ? 0.06 * reglages.soleilTaille : 0);
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

// Trace lisse : petits segments a bouts plats (pas de capuchons qui se
// superposent, donc ni perles ni surintensites aux raccords), un point
// toutes les quelques dizaines de secondes, alpha propre a chaque point.
// pts : [{x, y, vis, a}]
function traceLisse(pts, rgb, largeur) {
  ctx.lineWidth = largeur;
  ctx.lineCap = "butt";
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], q = pts[i];
    if (!p.vis || !q.vis) continue;
    const alpha = (p.a + q.a) / 2;
    if (alpha < 0.004) continue;
    ctx.strokeStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha.toFixed(3)})`;
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
  }
}

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
const SEGMENTS_TRAINEE = 60;

function dessineAvion(av, t) {
  const { cx, cy, R, dpr } = vue;
  const ecran = (P) => [cx + R * P[0], cy - R * P[1]];
  const P = positionAvion(av, av.theta);
  const allume = eclaire(P);

  // trainee : un trait lisse qui s'efface vers l'arriere
  const taille = 16 * reglages.avionTaille * dpr;
  const pts = [];
  for (let i = 0; i <= SEGMENTS_TRAINEE; i++) {
    const Q = i === 0 ? P : positionAvion(av, av.theta - av.sens * LONGUEUR_TRAINEE * i / SEGMENTS_TRAINEE);
    const [x, y] = ecran(Q);
    pts.push({ x, y, vis: !cache(Q) && !derriereLune(Q), a: (allume ? 0.5 : 0.25) * Math.pow(1 - i / SEGMENTS_TRAINEE, 1.5) });
  }
  traceLisse(pts, [225, 235, 255], Math.max(1, taille * 0.1));
  if (cache(P) || derriereLune(P)) return;

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

// ------------------------------------------------------------
//  Prevision a 24 h : orbite circulaire ajustee sur les positions de l'API
//  (plan orbital = moyenne des normales, vitesse angulaire par moindres
//  carres), propagee dans le repere inertiel avec la regression du noeud due
//  a l'aplatissement de la Terre (J2, -5 deg/jour pour l'ISS), puis ramenee au
//  repere terrestre par la rotation de la Terre. Quelques degres d'erreur
//  possibles en fin de journee (frottement, excentricite) : c'est une
//  tendance, pas une ephemeride.
// ------------------------------------------------------------
const NOEUD_ISS = -1.005e-6;              // rad/s, regression du noeud ascendant
const gmst = (ms) => (((280.46061837 + 360.98564736629 * (ms / 86400000 - 10957.5)) % 360) + 360) % 360 * RAD;
function rotZ(v, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
}
let modeleOrbite = null, previsionPts = null;

function ajusteOrbite(pos) {
  if (pos.length < 3) return null;
  const t0 = pos[0].t;
  const w = pos.map((p) => rotZ(vecteurGeo(p.lat, p.lon), gmst(p.t)));       // repere inertiel
  let n = [0, 0, 0];
  for (let i = 0; i + 1 < w.length; i++) {
    const c = vectoriel(w[i], w[i + 1]);
    n = [n[0] + c[0], n[1] + c[1], n[2] + c[2]];
  }
  n = normalise(n);
  const k = w[0][0] * n[0] + w[0][1] * n[1] + w[0][2] * n[2];
  const a = normalise([w[0][0] - k * n[0], w[0][1] - k * n[1], w[0][2] - k * n[2]]);
  const b = vectoriel(n, a);
  let prec = 0, dt = [], ph = [];
  for (let i = 0; i < w.length; i++) {
    let f = Math.atan2(w[i][0] * b[0] + w[i][1] * b[1] + w[i][2] * b[2], w[i][0] * a[0] + w[i][1] * a[1] + w[i][2] * a[2]);
    while (f - prec > Math.PI) f -= 2 * Math.PI;
    while (f - prec < -Math.PI) f += 2 * Math.PI;
    prec = f;
    dt.push((pos[i].t - t0) / 1000); ph.push(f);
  }
  const moy = (x) => x.reduce((u, v) => u + v, 0) / x.length;
  const mt = moy(dt), mp = moy(ph);
  let num = 0, den = 0;
  for (let i = 0; i < dt.length; i++) { num += (dt[i] - mt) * (ph[i] - mp); den += (dt[i] - mt) ** 2; }
  if (!(den > 0)) return null;
  // la regression du noeud, comptee deux fois sinon, ajoute n.z * NOEUD a la vitesse mesuree dans le plan fixe
  const om = num / den - NOEUD_ISS * n[2];
  return { t0, a, b, om, phi0: mp - om * mt, d: 1 + moy(pos.map((p) => p.alt)) / RAYON_TERRE_KM };
}

// vecteur unitaire terrestre (x, y, z) de l'ISS a l'instant ms selon le modele
function positionModele(m, ms) {
  const dt = (ms - m.t0) / 1000, f = m.phi0 + m.om * dt;
  const c = Math.cos(f), s = Math.sin(f);
  const v = [c * m.a[0] + s * m.b[0], c * m.a[1] + s * m.b[1], c * m.a[2] + s * m.b[2]];
  return rotZ(rotZ(v, NOEUD_ISS * dt), -gmst(ms));
}

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
  modeleOrbite = ajusteOrbite(pos);
  previsionPts = null;
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
  const d = 1 + (A.alt + (B.alt - A.alt) * f) / RAYON_TERRE_KM;
  const P = dansVue(w, reglages.lat, reglages.lon);
  return [P[0] * d, P[1] * d, P[2] * d];
}

const PAS_PREVISION = 120000, HEURES_MAX = 12, NB_TRANCHES = 8;
function dessinePrevision(ms) {
  const m = modeleOrbite, { cx, cy, R, dpr } = vue;
  // points precalcules toutes les 2 min, regeneres toutes les 20 min
  if (!previsionPts || previsionPts.modele !== m || ms - previsionPts.debut > 20 * 60000 || ms < previsionPts.debut) {
    const n = (HEURES_MAX * 60 + 30) / 2 + 1, xyz = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) xyz.set(positionModele(m, ms + i * PAS_PREVISION), i * 3);
    previsionPts = { modele: m, debut: ms, n, xyz };
  }
  const proj = (x, y, z) => dansVue([x, y, z], reglages.lat, reglages.lon).map((c) => c * m.d);
  const ecran = (Q) => [cx + R * Q[0], cy - R * Q[1]];

  const rgb = couleurRvb(reglages.issCouleur);
  const debut = ms;                                                              // trace de maintenant a maintenant + h
  const fin = ms + Math.max(0, Math.min(HEURES_MAX, reglages.issPrevision)) * 3600000;
  const tranches = Array.from({ length: NB_TRANCHES }, () => []);
  let prec = proj(...positionModele(m, debut));
  const i0 = Math.floor((debut - previsionPts.debut) / PAS_PREVISION) + 1;
  for (let i = i0; i < previsionPts.n; i++) {
    const t = previsionPts.debut + i * PAS_PREVISION;
    if (t > fin) break;
    const Q = proj(previsionPts.xyz[i * 3], previsionPts.xyz[i * 3 + 1], previsionPts.xyz[i * 3 + 2]);
    if (!cache(prec) && !cache(Q) && !derriereLune(Q)) {
      const tr = Math.min(NB_TRANCHES - 1, Math.floor((t - debut) / (fin - debut) * NB_TRANCHES));
      tranches[tr].push(ecran(prec), ecran(Q));
    }
    prec = Q;
  }
  ctx.lineWidth = Math.max(1, dpr);
  ctx.lineCap = "butt";
  tranches.forEach((seg, tr) => {
    if (!seg.length) return;
    ctx.strokeStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${(0.7 * (1 - 0.65 * (tr + 0.5) / NB_TRANCHES)).toFixed(3)})`;
    ctx.beginPath();
    for (let i = 0; i < seg.length; i += 2) { ctx.moveTo(seg[i][0], seg[i][1]); ctx.lineTo(seg[i + 1][0], seg[i + 1][1]); }
    ctx.stroke();
  });

  // reperes toutes les 4 h
  ctx.font = `bold ${16 * dpr}px sans-serif`;
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0, 0, 0, 0.85)";
  ctx.shadowBlur = 4 * dpr;
  for (let k = 1; k <= HEURES_MAX / 4; k++) {
    const t = ms + k * 4 * 3600000;
    if (t < debut || t > fin) continue;
    const Q = proj(...positionModele(m, t));
    if (cache(Q) || derriereLune(Q)) continue;
    const [x, y] = ecran(Q);
    ctx.fillStyle = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
    ctx.beginPath(); ctx.arc(x, y, 3 * dpr, 0, 2 * Math.PI); ctx.fill();
    ctx.fillText(`+${4 * k} h`, x + 7 * dpr, y - 7 * dpr);
  }
  ctx.shadowBlur = 0;
}

function dessineIss(P) {
  const ms = instant();
  if (!P) return;
  const { cx, cy, R, dpr } = vue;
  const ecran = (Q) => [cx + R * Q[0], cy - R * Q[1]];

  if (reglages.issTrace) {
    // 24 min passees, 30 min a venir, un point toutes les 30 s ; trait continu fin.
    // La fenetre de positions connues peut etre plus courte : on trace ce qu'on a.
    const pts = [];
    for (let m = -24 * 2; m <= 30 * 2; m++) {
      const min = m / 2;
      const Q = issDansVue(ms + m * 30000);
      if (!Q) continue;
      const [x, y] = ecran(Q);
      const a = min <= 0 ? 0.08 + 0.77 * (min + 24) / 24 : 0.85 - 0.77 * min / 30;     // plein a la station
      pts.push({ x, y, vis: !cache(Q) && !derriereLune(Q), a });
    }
    traceLisse(pts, couleurRvb(reglages.issCouleur), Math.max(1, dpr));
  }
  if (reglages.issPrevision > 0 && modeleOrbite) dessinePrevision(ms);
  if (cache(P) || derriereLune(P)) return;

  if (reglages.issLabel) {
    const longueur = ECHELLE_ISS * reglages.issTaille * R;      // envergure de la ferme a l'ecran
    const [x, y] = ecran(P);
    ctx.font = `bold ${16 * dpr}px sans-serif`;
    ctx.textBaseline = "middle";
    ctx.fillStyle = eclaire(P) ? "rgba(205, 225, 255, 0.95)" : "rgba(120, 140, 185, 0.9)";
    ctx.shadowColor = "rgba(0, 0, 0, 0.8)";
    ctx.shadowBlur = 4 * dpr;
    ctx.fillText("ISS", x + 8 * dpr + 0.42 * longueur, y - 6 * dpr - 0.3 * longueur);
    ctx.shadowBlur = 0;
  }
}

// ------------------------------------------------------------
//  Modele 3D de l'ISS (three.js) : modele NASA "International Space Station
//  (ISS) (A)" (domaine public, nasa/NASA-3D-Resources), retravaille dans
//  models/iss.glb : repere orbital (X avant, Y ferme, Z nadir), envergure de
//  la ferme = 1, ailes solaires separees du corps pour pouvoir les tourner
//  autour de la ferme et leur faire suivre le Soleil, comme les vraies.
//  Rendu sur un canvas a part, camera orthographique calee sur le globe
//  (1 unite = rayon du globe) ; une sphere invisible de rayon 1 ecrit la
//  profondeur pour cacher la station derriere la Terre. Taille = fraction du
//  rayon du globe : le zoom la change donc comme le reste.
// ------------------------------------------------------------
const ECHELLE_ISS = 0.18;             // envergure de la ferme / rayon du globe, pour issTaille = 1
const canvas3d = document.getElementById("iss3d");
let rendu3d = null, scene3d, camera3d, groupeIss = null, ailesIss, lumSoleil, lumTerre, matPanneaux, eclat;
let sceneLune, lune = null, lumLune, lumTerreLune, ambLune, sceneVoile, matVoile;

function init3d() {
  rendu3d = new THREE.WebGLRenderer({ canvas: canvas3d, alpha: true, antialias: true });
  rendu3d.setPixelRatio(1);                                         // la taille du tampon suit deja le dpr
  rendu3d.setClearColor(0x000000, 0);
  rendu3d.autoClear = false;                                        // deux scenes (Lune puis ISS) sur le meme tampon de profondeur
  scene3d = new THREE.Scene();
  camera3d = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 400);
  camera3d.position.set(0, 0, 150);                                  // la Lune a l'echelle reelle est a 60 rayons
  const occulteur = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), new THREE.MeshBasicMaterial({ colorWrite: false }));
  occulteur.renderOrder = -1;
  scene3d.add(occulteur);
  scene3d.add(new THREE.AmbientLight(0xaab8d8, 0.55));
  lumSoleil = new THREE.DirectionalLight(0xfff4e0, 3.2);
  lumTerre = new THREE.DirectionalLight(0x8fb4ff, 0);               // lumiere renvoyee par la Terre
  scene3d.add(lumSoleil, lumTerre);
  initLune();
  initVoile();
  (ASSETS.iss ? new Promise((ok, ko) => new GLTFLoader().parse(binaire(ASSETS.iss), "", ok, ko))
    : new GLTFLoader().loadAsync("models/iss.glb")).then((gltf) => {
    groupeIss = new THREE.Group();
    // panneaux : verre sombre tres lisse (lobe speculaire etroit du Soleil) ; le reste : metal mat
    matPanneaux = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color().setRGB(0.03, 0.09, 0.42), metalness: 0.35, roughness: 0.3,
      clearcoat: 0.8, clearcoatRoughness: 0.12, side: THREE.DoubleSide, emissive: 0x6fa0ff, emissiveIntensity: 0,
    });
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      if (o.material.name === "ISSSolarPanels") o.material = matPanneaux;
      else { o.material.metalness = 0.15; o.material.roughness = 0.55; }
    });
    // eclat : halo additif quand un panneau renvoie le Soleil vers l'observateur
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    const deg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    deg.addColorStop(0, "rgba(255,255,255,1)"); deg.addColorStop(0.25, "rgba(200,225,255,0.45)");
    deg.addColorStop(1, "rgba(160,200,255,0)");
    g.fillStyle = deg; g.fillRect(0, 0, 64, 64);
    eclat = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(c), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
    scene3d.add(eclat);
    ailesIss = gltf.scene.getObjectByName("ailes");
    groupeIss.add(gltf.scene);
    scene3d.add(groupeIss);
  }).catch((e) => console.warn("modele ISS : " + e.message));
}

function majIss3d(P, Q, allume) {
  // repere orbital dans la vue : Z vers la Terre, X vers l'avant, Y = Z ^ X (normale a l'orbite)
  const nP = Math.hypot(P[0], P[1], P[2]);
  const Z = [-P[0] / nP, -P[1] / nP, -P[2] / nP];
  let X = [Q[0] - P[0], Q[1] - P[1], Q[2] - P[2]];
  const k = X[0] * Z[0] + X[1] * Z[1] + X[2] * Z[2];
  X = normalise([X[0] - k * Z[0], X[1] - k * Z[1], X[2] - k * Z[2]]);
  const Y = vectoriel(Z, X);
  groupeIss.position.set(P[0], P[1], P[2]);
  groupeIss.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(
    new THREE.Vector3(...X), new THREE.Vector3(...Y), new THREE.Vector3(...Z)));
  groupeIss.scale.setScalar(ECHELLE_ISS * reglages.issTaille);

  // les ailes se tournent autour de la ferme (axe Y du modele) pour presenter leur face au Soleil
  const sx = soleil[0] * X[0] + soleil[1] * X[1] + soleil[2] * X[2];
  const sz = soleil[0] * Z[0] + soleil[1] * Z[1] + soleil[2] * Z[2];
  if (ailesIss && Math.hypot(sx, sz) > 1e-3) ailesIss.rotation.y = Math.atan2(-sz, sx);

  // reflet : un panneau plan de normale n renvoie le Soleil dans la direction
  // r = 2(n.S)n - S. L'observateur est vu comme un point a 3 rayons du centre du
  // globe (et non a l'infini) pour que l'eclat depende aussi de la position de la
  // station dans le disque. Eclat d'autant plus fort que r s'aligne sur la visee.
  const nx = sx / Math.hypot(sx, sz) || 0, nz = sz / Math.hypot(sx, sz) || 0;
  const n = [nx * X[0] + nz * Z[0], nx * X[1] + nz * Z[1], nx * X[2] + nz * Z[2]];
  const ns = n[0] * soleil[0] + n[1] * soleil[1] + n[2] * soleil[2];
  const r = [2 * ns * n[0] - soleil[0], 2 * ns * n[1] - soleil[1], 2 * ns * n[2] - soleil[2]];
  const vue3 = normalise([-P[0], -P[1], 3 - P[2]]);
  const align = r[0] * vue3[0] + r[1] * vue3[1] + r[2] * vue3[2];
  const t = Math.max(0, Math.min(1, (align - 0.55) / 0.45));
  const glint = allume ? t * t * (3 - 2 * t) * reglages.issReflet : 0;
  if (matPanneaux) matPanneaux.emissiveIntensity = Math.min(1.2, glint * 1.2);
  if (eclat) {
    eclat.position.set(P[0], P[1], P[2] + 0.02);
    eclat.scale.setScalar(ECHELLE_ISS * reglages.issTaille * 1.1);
    eclat.material.opacity = Math.min(1, glint * 0.9);
  }

  lumSoleil.position.set(soleil[0] * 5, soleil[1] * 5, soleil[2] * 5);
  lumSoleil.intensity = allume ? 3.2 : 0;
  // face a la Terre eclairee : lumiere bleutee venant d'en bas
  const jourSous = Math.max(0, Math.min(1, ((P[0] * soleil[0] + P[1] * soleil[1] + P[2] * soleil[2]) / nP + 0.2) / 0.8));
  lumTerre.position.set(-Z[0] * -5, -Z[1] * -5, -Z[2] * -5);
  lumTerre.intensity = 0.9 * jourSous;
}

// ------------------------------------------------------------
//  Lune : position reelle (serie abregee de Meeus ch. 47, ~0,3 deg) ou
//  accelere : la direction reelle est tournee autour du pole de l'ecliptique
//  de luneExtra radians, qui croit de luneVit tours par minute - les phases
//  defilent alors comme dans le mois reel, en accelere. La Lune est placee a
//  luneDist rayons du globe (pas a l'echelle) et garde la meme face vers la
//  Terre (rotation synchrone). Texture : mosaique couleur LRO/LROC, relief
//  LOLA (NASA SVS, CGI Moon Kit). Eclairee par le meme Soleil que la Terre,
//  eclipsee quand elle passe dans l'ombre du globe.
// ------------------------------------------------------------
let luneExtra = 0;
const LUNE_REELLE = { rayon: 1737.4 / RAYON_TERRE_KM, distance: 384400 / RAYON_TERRE_KM };   // en rayons terrestres
let lunePos = null;                                  // {x, y, z, r} de la Lune a l'ecran (unites : rayon du globe)
let tailleAvantReel = 0;
const OBLIQUITE = 23.439291 * RAD;
const POLE_ECLIPTIQUE = [0, -Math.sin(OBLIQUITE), Math.cos(OBLIQUITE)];       // repere inertiel

function luneEci(ms) {
  const T = (ms / 86400000 - 10957.5) / 36525;
  const Lp = 218.3164477 + 481267.88123421 * T, D = 297.8501921 + 445267.1114034 * T;
  const M = 357.5291092 + 35999.0502909 * T, Mp = 134.9633964 + 477198.8675055 * T;
  const F = 93.2720950 + 483202.0175233 * T;
  const s = (x) => Math.sin(x * RAD);
  const lon = (Lp + 6.288774 * s(Mp) + 1.274027 * s(2 * D - Mp) + 0.658314 * s(2 * D) + 0.213618 * s(2 * Mp)
    - 0.185116 * s(M) - 0.114332 * s(2 * F) + 0.058793 * s(2 * D - 2 * Mp) + 0.057066 * s(2 * D - M - Mp)
    + 0.053322 * s(2 * D + Mp) + 0.045758 * s(2 * D - M) - 0.040923 * s(M - Mp) - 0.034720 * s(D)
    - 0.030383 * s(M + Mp)) * RAD;
  const lat = (5.128122 * s(F) + 0.280602 * s(Mp + F) + 0.277693 * s(Mp - F) + 0.173237 * s(2 * D - F)
    + 0.055413 * s(2 * D - Mp + F) + 0.046271 * s(2 * D - Mp - F) + 0.032573 * s(2 * D + F)) * RAD;
  const cb = Math.cos(lat), sb = Math.sin(lat), cl = Math.cos(lon), sl = Math.sin(lon);
  return [cb * cl, cb * sl * Math.cos(OBLIQUITE) - sb * Math.sin(OBLIQUITE), cb * sl * Math.sin(OBLIQUITE) + sb * Math.cos(OBLIQUITE)];
}
function tourneAutour(v, k, a) {                    // Rodrigues
  const c = Math.cos(a), s = Math.sin(a), kv = k[0] * v[0] + k[1] * v[1] + k[2] * v[2], kxv = vectoriel(k, v);
  return [v[0] * c + kxv[0] * s + k[0] * kv * (1 - c), v[1] * c + kxv[1] * s + k[1] * kv * (1 - c),
          v[2] * c + kxv[2] * s + k[2] * kv * (1 - c)];
}
// direction de la Lune et pole de l'ecliptique dans le repere de vue
function luneDansVue(ms) {
  const eci = tourneAutour(luneEci(ms), POLE_ECLIPTIQUE, luneExtra);
  const th = gmst(ms);
  return { m: dansVue(rotZ(eci, -th), reglages.lat, reglages.lon), pole: dansVue(rotZ(POLE_ECLIPTIQUE, -th), reglages.lat, reglages.lon) };
}

// Voile atmospherique : la meme lueur que le halo du globe (shader de fond),
// ajoutee par-dessus les objets 3D qui passent DERRIERE la Terre (Lune, ISS) ;
// un plan a z = 0 ne passe le test de profondeur que devant eux, et le facteur
// d'alpha de destination l'empeche de s'ajouter au fond deja eclaire.
function initVoile() {
  matVoile = new THREE.ShaderMaterial({
    uniforms: { uSv: { value: new THREE.Vector2() }, uBrume: { value: new THREE.Vector3() },
                uEp: { value: 1 }, uLum: { value: 1 } },
    vertexShader: "varying vec2 vXY; void main() { vXY = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `varying vec2 vXY; uniform vec2 uSv; uniform vec3 uBrume; uniform float uEp, uLum;
      void main() {
        float rho = length(vXY), h = max(rho - 1.0, 0.0);
        float halo = 0.50 * exp(-h / (0.016 * uEp)) + 0.30 * exp(-h / (0.05 * uEp)) + 0.14 * exp(-h / (0.16 * uEp));
        float cote = smoothstep(-0.35, 0.7, dot(vXY / max(rho, 1e-4), uSv));
        gl_FragColor = vec4(uBrume * halo * cote * 0.85 * uLum, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstAlphaFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  sceneVoile = new THREE.Scene();
  sceneVoile.add(new THREE.Mesh(new THREE.PlaneGeometry(400, 400), matVoile));
}

function initLune() {
  sceneLune = new THREE.Scene();
  const occulteur = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), new THREE.MeshBasicMaterial({ colorWrite: false }));
  occulteur.renderOrder = -1;
  sceneLune.add(occulteur);
  ambLune = new THREE.AmbientLight(0x6a7aa0, 0.05);
  lumLune = new THREE.DirectionalLight(0xfff6e8, 2.6);
  lumTerreLune = new THREE.DirectionalLight(0x6f9cff, 0);           // lumiere de la Terre sur la face cachee
  sceneLune.add(ambLune, lumLune, lumTerreLune);
  Promise.all([chargeImage(ASSETS.lune || "textures/lune.jpg"), chargeImage(ASSETS.luneRelief || "textures/lune_relief.jpg")])
    .then(([im, rel]) => {
      const tex = new THREE.Texture(im), bump = new THREE.Texture(rel);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(8, rendu3d.capabilities.getMaxAnisotropy());
      tex.needsUpdate = bump.needsUpdate = true;
      lune = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64),
        new THREE.MeshStandardMaterial({ map: tex, bumpMap: bump, bumpScale: 2.5, roughness: 1, metalness: 0 }));
      sceneLune.add(lune);
    }).catch((e) => console.warn("Lune : " + e.message));
}

function majLune(ms) {
  const { m, pole } = luneDansVue(ms);
  const reel = reglages.luneReel, d = reel ? LUNE_REELLE.distance : reglages.luneDist, r = reel ? LUNE_REELLE.rayon : reglages.luneTaille;
  lune.position.set(m[0] * d, m[1] * d, m[2] * d);
  lune.scale.setScalar(r);
  lunePos = { x: m[0] * d, y: m[1] * d, z: m[2] * d, r };
  // face cachee tournee vers l'avant : l'axe x de la texture (longitude 0) pointe vers la Terre,
  // le nord lunaire vers le pole de l'ecliptique
  const X = [-m[0], -m[1], -m[2]];
  const k = pole[0] * X[0] + pole[1] * X[1] + pole[2] * X[2];
  const Y = normalise([pole[0] - k * X[0], pole[1] - k * X[1], pole[2] - k * X[2]]);
  const Z = vectoriel(X, Y);
  lune.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(
    new THREE.Vector3(...X), new THREE.Vector3(...Y), new THREE.Vector3(...Z)));

  // eclipse : le centre passe-t-il dans le cone d'ombre du globe ? (le Soleil a un
  // rayon apparent de 0,00465 rad : l'ombre se resserre avec la distance)
  const ps = m[0] * soleil[0] + m[1] * soleil[1] + m[2] * soleil[2];
  let eclairement = 1;
  if (ps < 0) {
    const perp = d * Math.sqrt(Math.max(0, 1 - ps * ps));
    const ombre = Math.max(0.1, 1 - d * 0.00465);
    const t = Math.max(0, Math.min(1, (perp - (ombre - r)) / (2 * r)));          // penombre sur un diametre lunaire
    eclairement = t * t * (3 - 2 * t);
  }
  lumLune.position.set(soleil[0] * 5, soleil[1] * 5, soleil[2] * 5);
  lumLune.intensity = 2.6 * eclairement;
  ambLune.color.setRGB(0.42 + 0.58 * eclairement, 0.48 + 0.2 * eclairement, 0.63);  // cuivre dans l'ombre
  ambLune.intensity = 0.05 + 0.3 * (1 - eclairement);
  // la Terre eclaire la face cachee : pleine vue de la Lune quand la Lune est vers le Soleil (nouvelle lune)
  lumTerreLune.position.set(-m[0] * 5, -m[1] * 5, -m[2] * 5);
  lumTerreLune.intensity = 0.22 * (1 + ps) / 2 * eclairement;
}

// Une image 3D : Lune puis ISS sur le meme tampon de profondeur
function dessine3d(P, Q, allume, ms) {
  if (!rendu3d) init3d();
  const { l, h, cx, cy, R } = vue;
  if (canvas3d.width !== l || canvas3d.height !== h) rendu3d.setSize(l, h, false);
  camera3d.left = -cx / R; camera3d.right = (l - cx) / R;
  camera3d.top = cy / R; camera3d.bottom = -(h - cy) / R;
  camera3d.updateProjectionMatrix();
  rendu3d.clear();
  lunePos = null;
  if (reglages.lune && lune) { majLune(ms); rendu3d.render(sceneLune, camera3d); }
  if (reglages.iss && P && groupeIss) { majIss3d(P, Q, allume); rendu3d.render(scene3d, camera3d); }
  const b = couleurRvb(reglages.brumeTeinte);
  matVoile.uniforms.uSv.value.set(soleil[0], soleil[1]);
  matVoile.uniforms.uBrume.value.set(b[0] / 255, b[1] / 255, b[2] / 255);
  matVoile.uniforms.uEp.value = Math.max(0.05, reglages.brumeEp);
  matVoile.uniforms.uLum.value = reglages.brume ? reglages.brumeLum : 0;
  rendu3d.render(sceneVoile, camera3d);
}

// Le calque 2D (avions, traces) est au-dessus du canvas 3D : on y masque a la main
// ce qui est derriere la Lune. Q : vecteur de la vue, en rayons du globe.
function derriereLune(Q) {
  if (!lunePos) return false;
  const dx = Q[0] - lunePos.x, dy = Q[1] - lunePos.y, d2 = dx * dx + dy * dy;
  return d2 < lunePos.r * lunePos.r && Q[2] < lunePos.z + Math.sqrt(lunePos.r * lunePos.r - d2);
}

// ------------------------------------------------------------
//  Boucle d'animation du calque (avions + ISS)
// ------------------------------------------------------------
let dernierT = 0, boucleActive = false;
function anime(t) {
  if (!avions.length && !reglages.iss && !reglages.lune) {
    ctx.clearRect(0, 0, calque.width, calque.height);
    if (rendu3d) rendu3d.clear();
    boucleActive = false;
    return;
  }
  requestAnimationFrame(anime);
  if (t - dernierT < 33) return;                        // ~30 images / s suffisent
  const dt = dernierT ? Math.min(0.2, (t - dernierT) / 1000) : 0;
  dernierT = t;
  const omega = 2 * Math.PI * reglages.avionVit / 60;
  ctx.clearRect(0, 0, calque.width, calque.height);
  luneExtra += 2 * Math.PI * reglages.luneVit / 60 * dt;
  const ms = instant();
  const P = reglages.iss ? issDansVue(ms) : null;
  if (reglages.iss || reglages.lune || rendu3d) dessine3d(P, P && (issDansVue(ms + 20000) || P), P && eclaire(P), ms);
  if (reglages.iss) { verifieIss(t); dessineIss(P); }
  for (const av of avions) {
    av.theta += av.sens * omega * av.facteurVit * dt;
    dessineAvion(av, t);
  }
}
function lanceAnimation() {
  ajusteFlotte();
  if (!boucleActive && (avions.length || reglages.iss || reglages.lune)) {
    boucleActive = true;
    dernierT = 0;
    requestAnimationFrame(anime);
  } else if (!avions.length && !reglages.iss && !reglages.lune) {
    ctx.clearRect(0, 0, calque.width, calque.height);
    if (rendu3d) rendu3d.clear();
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
  if (cle.startsWith("lune")) {
    if (cle === "lune") lanceAnimation();
    if (cle === "luneReel") ajusteVuePourLune();
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
const TAILLE_MIN = 0.005, TAILLE_MAX = 4, CENTRE_MIN = -1, CENTRE_MAX = 2;
const bornes = (x, a, b) => Math.max(a, Math.min(b, x));
const pointeurs = new Map();                       // id -> {x, y, mode, x0, y0, t0}
let minuterieSauvegarde = 0, dernierTape = null;

function metAJourVue() {
  reglages.taille = bornes(reglages.taille, TAILLE_MIN, TAILLE_MAX);
  reglages.cx = bornes(reglages.cx, CENTRE_MIN, CENTRE_MAX);
  reglages.cy = bornes(reglages.cy, CENTRE_MIN, CENTRE_MAX);
  reglages.lat = bornes(reglages.lat, -90, 90);
  reglages.lon = ((reglages.lon + 180) % 360 + 360) % 360 - 180;
  demandeRendu();
  clearTimeout(minuterieSauvegarde);
  minuterieSauvegarde = setTimeout(sauve, 400);
}

// Proportions reelles : l'orbite lunaire (60 rayons) doit tenir a l'ecran, donc on
// reduit le globe ; on retrouve la taille d'avant en decochant.
function ajusteVuePourLune() {
  if (reglages.luneReel) {
    if (reglages.taille > 0.05) tailleAvantReel = reglages.taille;
    reglages.taille = 0.92 / LUNE_REELLE.distance;
    reglages.cx = reglages.cy = 0.5;
  } else if (tailleAvantReel) {
    reglages.taille = tailleAvantReel;
  }
  metAJourVue();
}

const rayonCss = () => reglages.taille * Math.min(toile.clientWidth, toile.clientHeight) / 2;

function tourne(dx, dy) {
  const R = rayonCss();
  const coslat = Math.max(Math.cos(reglages.lat * RAD), 0.3);     // pres des poles, 1 px ne vaut plus 1 px de longitude
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
  const [jour, nuit] = await Promise.all([chargeImage(ASSETS.jour || "textures/jour.jpg"), chargeImage(ASSETS.nuit || "textures/nuit.jpg")]);
  textureCarte(0, jour);
  textureCarte(1, nuit);
  palette(nuit);
  gl.uniform1i(uni.uJour, 0);
  gl.uniform1i(uni.uNuitTex, 1);
  gl.uniform1i(uni.uLut, 2);
  gl.uniform1i(uni.uEtoiles, 3);
  modeleOrbite = ajusteOrbite(issPos);
  pret = true;
  rendu(true);
  lanceAnimation();
  window.addEventListener("resize", () => rendu(false));
  if (!Number.isFinite(INSTANT_FIGE)) setInterval(() => rendu(false), 5000);
}

if (gl) demarre().catch((e) => erreur(String(e.message || e)));
