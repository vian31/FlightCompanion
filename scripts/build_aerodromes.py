#!/usr/bin/env python3
"""Convertit la réponse brute de BASULM `listall` en aerodromes.json compact.

Bibliothèque standard uniquement.

Usage : build_aerodromes.py LISTALL.json aerodromes.json

Format de sortie :
{
  "meta": {"source", "attribution", "maj", "count"},
  "terrains": { "<code_terrain>": {...}, ... }
}
- Indexé sur `code_terrain` (jamais sur `id`, qui change à chaque
  modification acceptée). Triés par code : diffs git stables.
- `maj` = date_modif la plus récente des données (et non l'heure du
  run) : le fichier ne change pas tant que BASULM ne change pas.
- Champs vides omis. Coordonnées en degrés décimaux, altitude en pieds,
  pistes en mètres.
- Exclus : bases « fermées définitivement » et toute donnée de contact
  (nom, mail, téléphone, adresse : données personnelles de particuliers).

Clés d'un terrain : nom, type, lat, lon, alt (ft), ville, dep, pays
(si autre que France), radio, pistes [{nature, larg, long, orient,
pref}], classes, carb, fac, consignes, infos, web, statut, gest, maj.
"""
import json
import re
import sys

ATTRIBUTION = "Source : Fédération Française d'ULM – BASULM"
COORD_RE = re.compile(
    r"^([NSEW])\s*(\d+)(?:\s+(\d+)(?:\s+(\d+(?:[.,]\d+)?))?)?$", re.I)
NUM_RE = re.compile(r"^\s*(\d+(?:[.,]\d+)?)\s*(ft|m)?\s*$", re.I)


def txt(v):
    return v.strip() if isinstance(v, str) else ""


def coord(v):
    """'N 44 36 12' -> 44.60333 ; None si illisible."""
    m = COORD_RE.match(txt(v))
    if not m:
        return None
    h, d, mn, s = m.groups()
    val = int(d) + int(mn or 0) / 60 + float((s or "0").replace(",", ".")) / 3600
    return round(-val if h.upper() in "SW" else val, 5)


def altitude_ft(v):
    """'3772 ft' -> 3772 ; '330' -> 330 ; '120 m' -> 394 ; None si vide."""
    m = NUM_RE.match(txt(v))
    if not m:
        return None
    n = float(m.group(1).replace(",", "."))
    if (m.group(2) or "ft").lower() == "m":
        n *= 3.28084
    return round(n)


def number(v):
    t = txt(v)
    return int(t) if t.isdigit() else t


def classes(v):
    if isinstance(v, list):
        out = [txt(str(c)) for c in v]
    else:
        out = [c.strip() for c in re.split(r"[,;]", txt(v))]
    return [c for c in out if c]


def pistes(t):
    out = []
    for i in (1, 2):
        p = {
            "nature": txt(t.get(f"nature_piste_{i}")),
            "larg": number(t.get(f"largeur_piste_{i}")),
            "long": number(t.get(f"longueur_piste_{i}")),
            "orient": txt(t.get(f"orientation_piste_{i}")),
            "pref": txt(t.get(f"orientation_pref_{i}")),
        }
        if p["orient"].lower() == "inconnue":
            p["orient"] = ""
        p = {k: v for k, v in p.items() if v not in ("", None)}
        if p:
            out.append(p)
    return out


def convert(t):
    rec = {
        "nom": txt(t.get("toponyme")),
        "type": txt(t.get("type_terrain")),
        "lat": coord(t.get("latitude")),
        "lon": coord(t.get("longitude")),
        "alt": altitude_ft(t.get("altitude")),
        "ville": txt(t.get("ville_postale")) or txt(t.get("ville")),
        "dep": txt(t.get("departement")),
        "pays": "" if txt(t.get("pays")).lower() == "france" else txt(t.get("pays")),
        "radio": txt(t.get("radio")),
        "pistes": pistes(t),
        "classes": classes(t.get("classes")),
        "carb": txt(t.get("carburant")),
        "fac": txt(t.get("facilities")),
        "consignes": txt(t.get("consignes")),
        "infos": txt(t.get("infos")),
        "web": txt(t.get("site_web")),
        "statut": txt(t.get("statut")),
        "gest": txt(t.get("gestionnaire")),
        "maj": txt(t.get("date_modif"))[:10],
    }
    return {k: v for k, v in rec.items() if v not in ("", None, [])}


def build(data):
    terrains, ignores = {}, {"fermes": 0, "sans_code": 0, "sans_coord": 0}
    for t in data.get("liste", []):
        code = txt(t.get("code_terrain")).upper()
        if not code:
            ignores["sans_code"] += 1
            continue
        if "fermée définitivement" in txt(t.get("type_terrain")).lower():
            ignores["fermes"] += 1
            continue
        rec = convert(t)
        if "lat" not in rec or "lon" not in rec:
            ignores["sans_coord"] += 1
            print(f"avertissement : {code} sans coordonnées lisibles, ignoré",
                  file=sys.stderr)
            continue
        old = terrains.get(code)
        if old and old.get("maj", "") >= rec.get("maj", ""):
            continue  # doublon de code : on garde le plus récent
        terrains[code] = rec
    terrains = dict(sorted(terrains.items()))
    meta = {
        "source": "BASULM",
        "attribution": ATTRIBUTION,
        "maj": max((r.get("maj", "") for r in terrains.values()), default=""),
        "count": len(terrains),
    }
    meta = {k: v for k, v in meta.items() if v != ""}
    return {"meta": meta, "terrains": terrains}, ignores


def main():
    if len(sys.argv) != 3:
        print("Usage : build_aerodromes.py LISTALL.json aerodromes.json",
              file=sys.stderr)
        sys.exit(2)
    with open(sys.argv[1], encoding="utf-8") as f:
        data = json.load(f)
    if data.get("status") != "ok" or not isinstance(data.get("liste"), list):
        print("ERREUR : listall invalide (status != ok ou liste absente)",
              file=sys.stderr)
        sys.exit(1)
    out, ign = build(data)
    if not out["terrains"]:
        print("ERREUR : aucun terrain exploitable", file=sys.stderr)
        sys.exit(1)
    with open(sys.argv[2], "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    print(f"aerodromes.json : {out['meta']['count']} terrains sur "
          f"{len(data['liste'])} ; ignorés : {ign['fermes']} fermés, "
          f"{ign['sans_coord']} sans coordonnées, {ign['sans_code']} sans code")


if __name__ == "__main__":
    main()
