/* =========================================================================
   Rendu des instruments de l'écran d'accueil.

   Port sans jQuery de jQuery-Flight-Indicators (Sébastien Matton, GPLv3 —
   voir img/LICENSE-flight-indicators.txt et
   https://github.com/sebmatton/jQuery-Flight-Indicators). Mêmes fichiers
   SVG, mêmes formules de rotation que le plugin d'origine ; seule la
   construction du DOM et l'accès aux éléments changent (querySelector au
   lieu de jQuery), pour rester auto-contenu sans dépendance externe.
   ========================================================================= */
(function (global) {
  const BOUNDS = { pitch: 30, vario: 1.95, airspeedLow: 0, airspeedHigh: 160 };

  const MARKUP = {
    attitude: (D) => `<div class="instrument attitude">
      <img src="${D}fi_box.svg" class="background box" alt="">
      <div class="roll box">
        <img src="${D}horizon_back.svg" class="box" alt="">
        <div class="pitch box"><img src="${D}horizon_ball.svg" class="box" alt=""></div>
        <img src="${D}horizon_circle.svg" class="box" alt="">
      </div>
      <div class="mechanics box">
        <img src="${D}horizon_mechanics.svg" class="box" alt="">
        <img src="${D}fi_circle.svg" class="box" alt="">
      </div>
    </div>`,
    heading: (D) => `<div class="instrument heading">
      <img src="${D}fi_box.svg" class="background box" alt="">
      <div class="heading box"><img src="${D}heading_yaw.svg" class="box" alt=""></div>
      <div class="mechanics box">
        <img src="${D}heading_mechanics.svg" class="box" alt="">
        <img src="${D}fi_circle.svg" class="box" alt="">
      </div>
    </div>`,
    variometer: (D) => `<div class="instrument vario">
      <img src="${D}fi_box.svg" class="background box" alt="">
      <img src="${D}vertical_mechanics.svg" class="box" alt="">
      <div class="vario box"><img src="${D}fi_needle.svg" class="box" alt=""></div>
      <div class="mechanics box"><img src="${D}fi_circle.svg" class="box" alt=""></div>
    </div>`,
    turn_coordinator: (D) => `<div class="instrument turn_coordinator">
      <img src="${D}fi_box.svg" class="background box" alt="">
      <img src="${D}turn_coordinator.svg" class="box" alt="">
      <div class="turn box"><img src="${D}fi_tc_airplane.svg" class="box" alt=""></div>
      <div class="mechanics box"><img src="${D}fi_circle.svg" class="box" alt=""></div>
    </div>`,
    airspeed: (D) => `<div class="instrument airspeed">
      <img src="${D}fi_box.svg" class="background box" alt="">
      <img src="${D}speed_mechanics.svg" class="box" alt="">
      <div class="speed box"><img src="${D}fi_needle.svg" class="box" alt=""></div>
      <div class="mechanics box"><img src="${D}fi_circle.svg" class="box" alt=""></div>
    </div>`,
    altimeter: (D) => `<div class="instrument altimeter">
      <img src="${D}fi_box.svg" class="background box" alt="">
      <div class="pressure box"><img src="${D}altitude_pressure.svg" class="box" alt=""></div>
      <img src="${D}altitude_ticks.svg" class="box" alt="">
      <div class="needleSmall box"><img src="${D}fi_needle_small.svg" class="box" alt=""></div>
      <div class="needle box"><img src="${D}fi_needle.svg" class="box" alt=""></div>
      <div class="mechanics box"><img src="${D}fi_circle.svg" class="box" alt=""></div>
    </div>`
  };

  // Construit un instrument dans `el` et renvoie ses méthodes de réglage
  // (mêmes formules que _setRoll/_setPitch/... du plugin d'origine).
  function buildFlightIndicator(el, type, opts) {
    const cfg = Object.assign({
      size: 200, roll: 0, pitch: 0, turn: 0, heading: 0, vario: 0,
      airspeed: 0, altitude: 0, pressure: 1000, showBox: true, imgDir: 'img/'
    }, opts);
    const make = MARKUP[type] || MARKUP.attitude;
    el.innerHTML = make(cfg.imgDir);
    const inst = el.querySelector('div.instrument');
    inst.style.width = cfg.size + 'px';
    inst.style.height = cfg.size + 'px';
    const bg = inst.querySelector('img.box.background');
    if (bg) bg.style.display = cfg.showBox ? '' : 'none';

    const api = {
      setRoll(roll) {
        const r = inst.querySelector('div.roll');
        if (r) r.style.transform = 'rotate(' + roll + 'deg)';
      },
      setPitch(pitch) {
        if (pitch > BOUNDS.pitch) pitch = BOUNDS.pitch;
        else if (pitch < -BOUNDS.pitch) pitch = -BOUNDS.pitch;
        const p = inst.querySelector('div.roll div.pitch');
        if (p) p.style.top = (pitch * 0.7) + '%';
      },
      setHeading(heading) {
        const h = inst.querySelector('div.heading');
        if (h) h.style.transform = 'rotate(' + (-heading) + 'deg)';
      },
      setTurn(turn) {
        const t = inst.querySelector('div.turn');
        if (t) t.style.transform = 'rotate(' + turn + 'deg)';
      },
      setVario(vario) {
        if (vario > BOUNDS.vario) vario = BOUNDS.vario;
        else if (vario < -BOUNDS.vario) vario = -BOUNDS.vario;
        const v = inst.querySelector('div.vario');
        if (v) v.style.transform = 'rotate(' + (vario * 90) + 'deg)';
      },
      setAirSpeed(speed) {
        if (speed > BOUNDS.airspeedHigh) speed = BOUNDS.airspeedHigh;
        else if (speed < BOUNDS.airspeedLow) speed = BOUNDS.airspeedLow;
        const s = inst.querySelector('div.speed');
        if (s) s.style.transform = 'rotate(' + (90 + speed * 2) + 'deg)';
      },
      setAltitude(altitude) {
        const needle = 90 + (altitude % 1000) * 360 / 1000;
        const needleSmall = altitude / 10000 * 360;
        const n = inst.querySelector('div.needle');
        if (n) n.style.transform = 'rotate(' + needle + 'deg)';
        const ns = inst.querySelector('div.needleSmall');
        if (ns) ns.style.transform = 'rotate(' + needleSmall + 'deg)';
      },
      setPressure(pressure) {
        const p = inst.querySelector('div.pressure');
        if (p) p.style.transform = 'rotate(' + (2 * pressure - 1980) + 'deg)';
      }
    };

    switch (type) {
      case 'heading': api.setHeading(cfg.heading); break;
      case 'variometer': api.setVario(cfg.vario); break;
      case 'turn_coordinator': api.setTurn(cfg.turn); break;
      case 'airspeed': api.setAirSpeed(cfg.airspeed); break;
      case 'altimeter': api.setAltitude(cfg.altitude); api.setPressure(cfg.pressure); break;
      default: api.setRoll(cfg.roll); api.setPitch(cfg.pitch);
    }
    return api;
  }

  global.buildFlightIndicator = buildFlightIndicator;
})(window);
