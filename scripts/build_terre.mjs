// Construit la version autonome de la page Terre (fond d'ecran, ouverture en file://) :
//   terre/fond.js         terre.js + three.js + GLTFLoader + soleil.js, un seul script classique
//   terre/fond-assets.js  textures et modele ISS en data: URI
//   terre/fond.html       index.html sans importmap ni module, avec ces deux scripts
// Usage (depuis la racine du depot) :  npm i --no-save esbuild && node scripts/build_terre.mjs
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";

const dossier = new URL("../terre/", import.meta.url).pathname;
await build({
  entryPoints: [dossier + "terre.js"],
  outfile: dossier + "fond.js",
  bundle: true, minify: true, format: "iife", target: "es2017", legalComments: "none",
  alias: { three: dossier + "lib/three.module.min.js", "three/addons": dossier + "lib/jsm" },
});

const uri = (fichier, mime) => `data:${mime};base64,` + readFileSync(dossier + fichier).toString("base64");
writeFileSync(dossier + "fond-assets.js", "window.TERRE_ASSETS = " + JSON.stringify({
  jour: uri("textures/jour.jpg", "image/jpeg"),
  nuit: uri("textures/nuit.jpg", "image/jpeg"),
  iss: uri("models/iss.glb", "model/gltf-binary"),
}) + ";\n");

let html = readFileSync(dossier + "index.html", "utf8");
const avant = html.length;
// Chargeur ES3 : sur un moteur trop ancien (Internet Explorer) on affiche le
// message au lieu de charger un script qui y provoquerait des erreurs de syntaxe.
const chargeur = '<script>\nif (window.Promise && window.Symbol && window.addEventListener) {\n' +
  '  document.write(\'<script src="fond-assets.js"><\\/script><script src="fond.js"><\\/script>\');\n' +
  '} else { terreMessage(TERRE_OBSOLETE); }\n</script>';
html = html.replace(/<script nomodule>[\s\S]*?<\/script>\s*/, "")
  .replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, "")
  .replace(/<script type="module" src="terre\.js[^"]*"><\/script>/, chargeur);
if (html.length === avant || !html.includes("fond.js")) throw new Error("index.html : balises de script introuvables");
writeFileSync(dossier + "fond.html", html);
console.log("fond.html, fond.js, fond-assets.js ecrits");
