// ============================================================
//  terre.js - Globe jour / nuit en temps reel (fond d'ecran)
//  Port WebGL2 de l'ecran TERRE de MultiClock (lib/Terre/terre_ecran.cpp,
//  reference outils/terre_simulateur.py) : meme projection orthographique,
//  memes constantes d'eclairage, sans les textes.
//
//  Parametres d'URL (tous facultatifs) :
//    lat, lon     centre de la vue en degres          (43.6  1.4)
//    taille       diametre du globe / petit cote ecran (0.8)
//    cx, cy       centre du globe, fraction de l'ecran (0.5  0.5)
//    nuit         luminosite de la face cachee         (0.5)
//    etoiles      0 = sans etoiles                     (1)
//    crepuscule   1 = lignes -6 / -12 / -18 deg        (0)
//    t            instant fige, ISO UTC (2026-10-11T16:50:00Z)
// ============================================================
import { soleilDansVue } from "./soleil.js";
import { ETOILES } from "./etoiles.js";

const params = new URLSearchParams(location.search);
const nombre = (nom, defaut) => {
  const v = parseFloat(params.get(nom));
  return Number.isFinite(v) ? v : defaut;
};
const LAT0 = nombre("lat", 43.6), LON0 = nombre("lon", 1.4);
const TAILLE = nombre("taille", 0.8);
const CX = nombre("cx", 0.5), CY = nombre("cy", 0.5);
const LUMIERE_NUIT = nombre("nuit", 0.5);
const AVEC_ETOILES = nombre("etoiles", 1) !== 0;
const CREPUSCULE = nombre("crepuscule", 0) !== 0;
const INSTANT_FIGE = params.has("t") ? Date.parse(params.get("t")) : NaN;

const toile = document.getElementById("toile");
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
uniform float uNuit;        // luminosite de la face cachee
uniform float uCrep;        // lignes de crepuscule
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

  // ---- fond : memes lois que le firmware, distances en rayons ----
  vec3 col = vec3(3.0, 6.0, 18.0);
  float th = clamp(1.0 - (rho - uR) / (uR * (230.0 / 96.0)), 0.0, 1.0);
  col += th * th * vec3(8.0, 22.0, 58.0);
  float vy = 1.0 - gl_FragCoord.y / uRes.y;
  col += vy * vy * vy * vec3(2.0, 6.0, 16.0);
  col /= 255.0;
  col = max(col, texture(uEtoiles, vec2(gl_FragCoord.x / uRes.x, vy)).rgb);

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

  // jour : Lambert adouci + voile atmospherique vers le limbe
  vec3 jr = textureGrad(uJour, uv, duv_dx, duv_dy).rgb * 255.0;
  float ecl = 0.35 + 0.65 * sqrt(max(L, 0.0));
  float qq = 1.0 - pz;
  float voile = qq * qq * sqrt(qq) * 0.55 * clamp(3.0 * L + 0.3, 0.0, 1.0);
  vec3 jour = jr * ecl * (1.0 - voile) + vec3(120.0, 170.0, 255.0) * voile;

  // nuit : luminance -> palette (couleur moyenne reelle du niveau) x gain
  vec3 nt = textureGrad(uNuitTex, uv, duv_dx, duv_dy).rgb;
  float lum = floor(clamp((nt.r + nt.g + nt.b) / 3.0 * 255.0, 0.0, 255.0));
  vec3 lut = texelFetch(uLut, ivec2(int(lum), 0), 0).rgb * 255.0;
  float gain = (0.55 + 1.05 * clamp((lum - 40.0) / 80.0, 0.0, 1.0)) * uNuit;
  vec3 nuit = lut * gain;

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
  col = mix(col, pix / 255.0, couv);

  // ---- lisere atmospherique, cote eclaire ----
  float lis = clamp(1.0 - (rho - uR) / (uR * (6.0 / 96.0)), 0.0, 1.0);
  float bord = clamp(dot(p / max(rho, 1.0), uSv.xy) + 0.3, 0.0, 1.0);
  float w = lis * bord * 0.7 * step(uR - 0.5, rho);
  col = mix(col, vec3(110.0, 165.0, 255.0) / 255.0, w);

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

let programme, uni = {}, texJour, texNuit, texLut, texEtoiles;

function initGL() {
  programme = gl.createProgram();
  gl.attachShader(programme, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(programme, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(programme);
  if (!gl.getProgramParameter(programme, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(programme));
  gl.useProgram(programme);
  for (const n of ["uRes", "uC", "uR", "uP", "uSv", "uNuit", "uCrep", "uJour", "uNuitTex", "uLut", "uEtoiles"])
    uni[n] = gl.getUniformLocation(programme, n);
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

// Etoiles : peintes dans un canevas 2D noir, lu comme texture par le shader
const TEINTES = [[1, 1, 1], [0.8, 0.88, 1], [1, 0.92, 0.78]];
function dessineEtoiles(l, h, cx, cy, r, dpr) {
  const c = document.createElement("canvas");
  c.width = l; c.height = h;
  const g = c.getContext("2d");
  g.fillStyle = "#000";
  g.fillRect(0, 0, l, h);
  if (AVEC_ETOILES) {
    for (const [u, v, b, te] of ETOILES) {
      const x = u * l, y = v * h;
      if (Math.hypot(x - cx, y - cy) < r * 1.12) continue;     // pas sur le globe
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
//  Rendu
// ------------------------------------------------------------
let dessine = false, derniereGeometrie = "", dernierMs = 0;

function geometrie() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const l = Math.max(1, Math.round(toile.clientWidth * dpr));
  const h = Math.max(1, Math.round(toile.clientHeight * dpr));
  return { dpr, l, h };
}

function rendu(forcer) {
  if (!dessine) return;
  const ms = Number.isFinite(INSTANT_FIGE) ? INSTANT_FIGE : Date.now();
  const { dpr, l, h } = geometrie();
  const cle = l + "x" + h + "@" + dpr;
  const moitie = Math.floor(ms / 30000);               // soleil : 0,125 deg par 30 s
  if (!forcer && cle === derniereGeometrie && moitie === dernierMs) return;

  const R = TAILLE * Math.min(l, h) / 2;
  const cx = CX * l, cy = CY * h;                       // cy du haut de l'ecran
  if (cle !== derniereGeometrie) {
    toile.width = l; toile.height = h;
    dessineEtoiles(l, h, cx, cy, R, dpr);
    derniereGeometrie = cle;
  }
  dernierMs = moitie;

  const { sv } = soleilDansVue(ms, LAT0, LON0);
  gl.viewport(0, 0, l, h);
  gl.uniform2f(uni.uRes, l, h);
  gl.uniform2f(uni.uC, cx, h - cy);
  gl.uniform1f(uni.uR, R);
  gl.uniform2f(uni.uP, LAT0 * Math.PI / 180, LON0 * Math.PI / 180);
  gl.uniform3f(uni.uSv, sv[0], sv[1], sv[2]);
  gl.uniform1f(uni.uNuit, LUMIERE_NUIT);
  gl.uniform1f(uni.uCrep, CREPUSCULE ? 1 : 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  document.title = "Terre - " + new Date(ms).toISOString().slice(0, 16) + "Z";
  window.terrePrete = true;
}

async function demarre() {
  initGL();
  const [jour, nuit] = await Promise.all([chargeImage("textures/jour.jpg"), chargeImage("textures/nuit.jpg")]);
  texJour = textureCarte(0, jour);
  texNuit = textureCarte(1, nuit);
  texLut = palette(nuit);
  gl.uniform1i(uni.uJour, 0);
  gl.uniform1i(uni.uNuitTex, 1);
  gl.uniform1i(uni.uLut, 2);
  gl.uniform1i(uni.uEtoiles, 3);
  dessine = true;
  rendu(true);
  window.addEventListener("resize", () => rendu(false));
  if (!Number.isFinite(INSTANT_FIGE)) setInterval(() => rendu(false), 5000);
}

if (gl) demarre().catch((e) => erreur(String(e.message || e)));
