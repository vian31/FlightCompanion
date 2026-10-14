#!/usr/bin/env python3
"""Récupère les terrains ULM de la base BASULM (FFPLUM), API v1.3.

Bibliothèque standard uniquement. La clé est lue dans la variable
d'environnement BASULM_API_KEY ; elle n'est jamais affichée, y compris
dans les messages d'erreur.

Déroulé : `about` (test de la clé), puis UN SEUL appel `listall`. La
doc demande de ne pas dépasser un listall par jour. La réponse brute est
écrite telle quelle dans le fichier passé en argument (mode exploration :
rien n'est commité).

Pour la suite (aerodromes.json, pas encore codé) :
- indexer les terrains sur `code_terrain`, jamais sur `id` (l'id change à
  chaque modification acceptée) ;
- métadonnées du JSON : attribution « Source : Fédération Française
  d'ULM – BASULM ».

Usage : BASULM_API_KEY=... python3 scripts/fetch_basulm.py SORTIE.json
"""
import json
import os
import sys
import urllib.error
import urllib.request

BASE = "https://basulm.ffplum.fr/getbasulm/get/basulm/"
# La doc exige un User-Agent non vide.
USER_AGENT = "FlightCompanion-basulm-fetch/1.0"
TIMEOUT = 120  # listall dépasse 2 Mo


def fail(msg, key):
    # Filet de sécurité : la clé ne sort jamais, même par accident.
    print("ERREUR : " + msg.replace(key, "***"), file=sys.stderr)
    sys.exit(1)


def call(action, key):
    """Appelle une action ; renvoie (octets bruts, JSON décodé)."""
    req = urllib.request.Request(
        BASE + action,
        method="GET",
        headers={
            "Authorization": "api_key " + key,
            "User-Agent": USER_AGENT,
            "Cache-Control": "no-cache",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        fail(f"{action} : HTTP {e.code} {e.reason}", key)
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        fail(f"{action} : réseau ({type(e).__name__})", key)
    try:
        data = json.loads(raw)
    except ValueError:
        fail(f"{action} : réponse non JSON", key)
    if not isinstance(data, dict) or data.get("status") != "ok":
        code = data.get("error_code", "?") if isinstance(data, dict) else "?"
        desc = data.get("error_description", "") if isinstance(data, dict) else ""
        fail(f"{action} : status ko ({code}) {desc}", key)
    return raw, data


def main():
    if len(sys.argv) != 2:
        print("Usage : fetch_basulm.py SORTIE.json", file=sys.stderr)
        sys.exit(2)
    out = sys.argv[1]
    key = os.environ.get("BASULM_API_KEY", "").strip()
    if not key:
        print("ERREUR : variable BASULM_API_KEY absente ou vide", file=sys.stderr)
        sys.exit(1)

    _, about = call("about", key)
    print(f"about : ok, API version {about.get('version', '?')}")

    raw, data = call("listall", key)  # un seul appel par exécution
    with open(out, "wb") as f:
        f.write(raw)

    liste = data.get("liste")
    n = len(liste) if isinstance(liste, list) else "?"
    print(f"listall : ok, count={data.get('count', '?')}, {n} terrains, "
          f"{len(raw)} octets -> {out}")
    if isinstance(liste, list) and liste and isinstance(liste[0], dict):
        print("champs du premier terrain : " + ", ".join(liste[0].keys()))


if __name__ == "__main__":
    main()
