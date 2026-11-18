/* The sky over Toronto, live (and a few other cities).
   Data: Open-Meteo forecast + air quality APIs (no key needed), fetched with fetch() as JSON.
   The data changes: the words on the page, the sky and sun/moon, clouds, rain/snow, haze, the temperature
   colour, and (optional) sound. You can switch city, units, scrub through the next 24 hours, and
   turn sound on. Nothing is hard-coded: if the weather changes, the page changes. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var CITIES = [
    { name: "Toronto", lat: 43.6532, lon: -79.3832, sky: "towers" },
    { name: "Lahore", lat: 31.5497, lon: 74.3436, sky: "mosque" },
    { name: "London", lat: 51.5072, lon: -0.1276, sky: "blocks" },
    { name: "Tokyo", lat: 35.6762, lon: 139.6503, sky: "blocks" },
    { name: "Sydney", lat: -33.8688, lon: 151.2093, sky: "blocks" },
    { name: "Cairo", lat: 30.0444, lon: 31.2357, sky: "blocks" }
  ];
  var city = CITIES[0], imperial = false, data = null, offset = 0, fetchedAt = 0, playTimer = null;
  var CURRENT_VARS = "temperature_2m,apparent_temperature,relative_humidity_2m,is_day,precipitation,weather_code,wind_speed_10m,wind_direction_10m,cloud_cover";
  var HOURLY_VARS = "temperature_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,cloud_cover,is_day,relative_humidity_2m,apparent_temperature";

  /* ---------- helpers ---------- */
  function parse(t) {                      // "2026-11-17T22:15" (local time of the city) -> parts
    var m = /(\d+)-(\d+)-(\d+)T(\d+):(\d+)/.exec(t);
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    return { dow: d.getDay(), h: +m[4], min: +m[5] };
  }
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  function clock(h) { var a = h < 12 ? "AM" : "PM"; return ((h + 11) % 12 + 1) + ":00 " + a; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function lerp(a, b, k) { return a + (b - a) * k; }
  function mix(c1, c2, k) { return [lerp(c1[0], c2[0], k), lerp(c1[1], c2[1], k), lerp(c1[2], c2[2], k)]; }
  function rgb(c, a) { return "rgba(" + Math.round(c[0]) + "," + Math.round(c[1]) + "," + Math.round(c[2]) + "," + (a === undefined ? 1 : a) + ")"; }
  function compass(deg) { return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8]; }

  var CODES = [
    [[0], "Clear sky"], [[1], "Mostly clear"], [[2], "Partly cloudy"], [[3], "Overcast"], [[45, 48], "Fog"],
    [[51, 53, 55, 56, 57], "Drizzle"], [[61, 63, 65, 66, 67], "Rain"], [[71, 73, 75, 77], "Snow"],
    [[80, 81, 82], "Rain showers"], [[85, 86], "Snow showers"], [[95, 96, 99], "Thunderstorm"]
  ];
  function condText(code) { for (var i = 0; i < CODES.length; i++) if (CODES[i][0].indexOf(code) > -1) return CODES[i][1]; return "Unknown"; }
  function isSnow(code) { return [71, 73, 75, 77, 85, 86].indexOf(code) > -1; }
  function aqiLabel(a) {
    if (a == null) return "no data";
    return a <= 50 ? "Good" : a <= 100 ? "Moderate" : a <= 150 ? "Unhealthy for some" : a <= 200 ? "Unhealthy" : a <= 300 ? "Very unhealthy" : "Hazardous";
  }
  function feelWord(t) { return t < 0 ? "freezing" : t < 10 ? "cold" : t < 18 ? "cool" : t < 26 ? "mild" : t < 33 ? "warm" : t < 40 ? "hot" : "scorching"; }

  /* ---------- fetch ---------- */
  function getJSON(url) {
    var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, 12000);
    return fetch(url, { signal: ctl.signal }).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }, function (e) { clearTimeout(timer); throw e; });
  }
  function load() {
    var q = "latitude=" + city.lat + "&longitude=" + city.lon + "&timezone=auto&forecast_days=2";
    var wUrl = "https://api.open-meteo.com/v1/forecast?" + q + "&current=" + CURRENT_VARS + "&hourly=" + HOURLY_VARS;
    var aUrl = "https://air-quality-api.open-meteo.com/v1/air-quality?" + q + "&current=us_aqi,pm2_5&hourly=us_aqi,pm2_5";
    var wanted = city;
    $("loading").hidden = false; $("error").hidden = true;
    return Promise.all([getJSON(wUrl), getJSON(aUrl).catch(function () { return null; })]).then(function (res) {
      if (wanted !== city) return;                       // user switched city while loading
      data = { w: res[0], a: res[1] }; fetchedAt = Date.now(); $("updated").textContent = "Updated just now";
      $("loading").hidden = true; $("content").hidden = false;
      var base = baseIndex();
      $("hour").max = Math.max(0, Math.min(23, data.w.hourly.time.length - 1 - base));
      offset = Math.min(offset, +$("hour").max); $("hour").value = offset;
      drawSpark(); render();
    }).catch(function (e) {
      if (wanted !== city) return;
      $("loading").hidden = true;
      if (data) { $("updated").textContent = "Could not refresh (" + e.message + "). Showing the last data."; return; }
      $("content").hidden = true; $("error").hidden = false;
      $("errorMsg").textContent = "Could not load live weather (" + (e.name === "AbortError" ? "timed out" : e.message) + "). Check your connection and try again.";
    });
  }
  function baseIndex() {                                  // index of the current hour in the hourly arrays
    var key = data.w.current.time.slice(0, 13);
    var i = data.w.hourly.time.findIndex(function (t) { return t.slice(0, 13) === key; });
    return i < 0 ? 0 : i;
  }

  /* ---------- the state the page shows: now, or an hour ahead ---------- */
  function stateAt(k) {
    var w = data.w, h = w.hourly, i = baseIndex() + k, c = w.current, a = data.a, s;
    if (k === 0) {
      s = { time: c.time, temp: c.temperature_2m, feels: c.apparent_temperature, hum: c.relative_humidity_2m, wind: c.wind_speed_10m,
            dir: c.wind_direction_10m, precip: c.precipitation, code: c.weather_code, cloud: c.cloud_cover, day: c.is_day === 1 };
    } else {
      s = { time: h.time[i], temp: h.temperature_2m[i], feels: h.apparent_temperature[i], hum: h.relative_humidity_2m[i], wind: h.wind_speed_10m[i],
            dir: h.wind_direction_10m[i], precip: h.precipitation[i], code: h.weather_code[i], cloud: h.cloud_cover[i], day: h.is_day[i] === 1 };
    }
    s.aqi = null; s.pm = null;
    if (a && a.hourly) {
      var j = a.hourly.time.findIndex(function (t) { return t.slice(0, 13) === s.time.slice(0, 13); });
      if (j > -1) { s.aqi = a.hourly.us_aqi[j]; s.pm = a.hourly.pm2_5[j]; }
      if (k === 0 && a.current && a.current.us_aqi != null) { s.aqi = a.current.us_aqi; s.pm = a.current.pm2_5; }
    }
    return s;
  }

  /* ---------- text and numbers ---------- */
  function tempOut(c) { return Math.round(imperial ? c * 9 / 5 + 32 : c); }
  function windOut(k) { return Math.round(imperial ? k * 0.621371 : k); }
  function render() {
    if (!data) return;
    var s = stateAt(offset), p = parse(s.time);
    $("title").textContent = city.name + (offset === 0 ? " right now" : ", " + DAYS[p.dow] + " " + clock(p.h));
    document.title = (offset === 0 ? "The sky over " + city.name + ", live" : city.name + " at " + clock(p.h));
    $("temp").textContent = tempOut(s.temp); $("tempUnit").textContent = imperial ? "°F" : "°C";
    $("cond").textContent = condText(s.code) + (s.day ? "" : ", night");
    $("feels").textContent = "Feels like " + tempOut(s.feels) + "°";
    $("hum").textContent = Math.round(s.hum) + "%";
    $("wind").innerHTML = windOut(s.wind) + " " + (imperial ? "mph" : "km/h") + '<span class="sub">from the ' + compass(s.dir) + "</span>";
    $("rain").textContent = s.precip > 0 ? s.precip.toFixed(1) + " mm" : "None";
    $("aqi").innerHTML = (s.aqi == null ? "--" : Math.round(s.aqi)) + '<span class="sub">' + aqiLabel(s.aqi) + (s.pm != null ? ", PM2.5 " + Math.round(s.pm) : "") + "</span>";
    $("hourLabel").textContent = offset === 0 ? "Now" : "+" + offset + "h, " + DAYS[p.dow] + " " + clock(p.h);

    var bits = ["It is " + feelWord(s.temp) + " in " + city.name + ", " + condText(s.code).toLowerCase() + "."];
    if (s.aqi != null && s.aqi > 100) bits.push("The air is " + aqiLabel(s.aqi).toLowerCase() + " (AQI " + Math.round(s.aqi) + "), so the sky looks hazy.");
    else if (s.aqi != null) bits.push("The air is " + aqiLabel(s.aqi).toLowerCase() + ".");
    if (s.wind >= 25) bits.push("It is windy.");
    if (s.precip > 0) bits.push("There is " + (isSnow(s.code) ? "snow" : "rain") + " falling.");
    $("story").textContent = bits.join(" ");

    var STOPS = [[-10, 210], [5, 185], [15, 45], [25, 38], [35, 22], [45, 8]], hue = STOPS[STOPS.length - 1][1];   // cold = blue, mild = gold, hot = red
    for (var q = 0; q < STOPS.length - 1; q++) {
      if (s.temp <= STOPS[q + 1][0]) { hue = lerp(STOPS[q][1], STOPS[q + 1][1], clamp((s.temp - STOPS[q][0]) / (STOPS[q + 1][0] - STOPS[q][0]), 0, 1)); break; }
    }
    document.documentElement.style.setProperty("--warm", "hsl(" + Math.round(hue) + ",88%," + (hue > 150 ? 66 : 60) + "%)");
    moveSpark();
    setScene(s, p);
    setSound(s);
  }

  /* sparkline of the next 24 hours' temperatures, with a marker for the hour you chose */
  var sparkMin = 0, sparkMax = 1, sparkN = 24;
  function drawSpark() {
    var h = data.w.hourly.temperature_2m, b = baseIndex(), vals = h.slice(b, b + 24);
    sparkN = vals.length; sparkMin = Math.min.apply(null, vals); sparkMax = Math.max.apply(null, vals);
    var span = sparkMax - sparkMin || 1;
    var pts = vals.map(function (v, i) { return (i / Math.max(1, vals.length - 1) * 240).toFixed(1) + "," + (44 - (v - sparkMin) / span * 38).toFixed(1); });
    $("spark").innerHTML = '<polyline points="' + pts.join(" ") + '"/><line id="mark" x1="0" x2="0" y1="0" y2="48"/>';
  }
  function moveSpark() { var m = $("mark"); if (m) { var x = offset / Math.max(1, sparkN - 1) * 240; m.setAttribute("x1", x); m.setAttribute("x2", x); } }

  /* ---------- the sky (canvas) ---------- */
  var cv = $("sky"), g = cv.getContext("2d"), W = 0, H = 0, T = {}, C = { day: 1, dusk: 0, cloud: 0.3, rain: 0, snow: 0, wind: 5, haze: 0, flash: 0, sunPos: 0.5 };
  var clouds = [], drops = [], stars = [];
  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2); W = innerWidth; H = innerHeight;
    cv.width = W * dpr; cv.height = H * dpr; g.setTransform(dpr, 0, 0, dpr, 0, 0);
    clouds = []; for (var i = 0; i < 16; i++) clouds.push({ x: Math.random() * W, y: H * (0.06 + Math.random() * 0.4), s: 0.6 + Math.random() * 1.1, v: 0.5 + Math.random() * 0.8 });
    stars = []; for (i = 0; i < 90; i++) stars.push({ x: Math.random() * W, y: Math.random() * H * 0.55, r: Math.random() * 1.3 + 0.2, p: Math.random() * 6 });
  }
  function setScene(s, p) {
    var hr = p.h + p.min / 60;
    T.day = s.day ? 1 : 0;
    T.dusk = Math.max(0, 1 - Math.min(Math.abs(hr - 6), Math.abs(hr - 18)) / 1.3);      // orange near sunrise/sunset
    T.cloud = s.cloud / 100;
    var snow = isSnow(s.code), amt = clamp(s.precip / 3, 0, 1);
    T.rain = !snow && s.precip > 0 ? Math.max(0.2, amt) : 0;
    T.snow = snow && s.precip > 0 ? Math.max(0.25, amt) : 0;
    T.wind = s.wind;
    T.haze = s.aqi == null ? 0 : clamp(s.aqi / 300, 0, 1);
    T.thunder = s.code >= 95 ? 1 : 0;
    T.sunPos = s.day ? clamp((hr - 6) / 12, 0, 1) : ((hr >= 18 ? hr - 18 : hr + 6) / 12);
    T.fog = [45, 48].indexOf(s.code) > -1 ? 1 : 0;
  }
  T = { day: 1, dusk: 0, cloud: 0.3, rain: 0, snow: 0, wind: 5, haze: 0, thunder: 0, sunPos: 0.5, fog: 0 };
  C.fog = 0;

  var DAY_TOP = [70, 135, 212], DAY_BOT = [190, 225, 246], NIGHT_TOP = [7, 12, 38], NIGHT_BOT = [30, 46, 92],
      DUSK_TOP = [92, 80, 150], DUSK_BOT = [246, 150, 90], GREY_D = [122, 132, 146], GREY_N = [32, 36, 52], HAZE = [188, 150, 96];
  function draw(t) {
    for (var k in T) C[k] = lerp(C[k] === undefined ? T[k] : C[k], T[k], 0.04);
    var top = mix(NIGHT_TOP, DAY_TOP, C.day), bot = mix(NIGHT_BOT, DAY_BOT, C.day);
    top = mix(top, DUSK_TOP, C.dusk * 0.7); bot = mix(bot, DUSK_BOT, C.dusk * 0.8);
    var grey = mix(GREY_N, GREY_D, C.day), dull = clamp(C.cloud * 0.55 + (C.rain + C.snow) * 0.3 + C.thunder * 0.2 + C.fog * 0.4, 0, 0.85);
    top = mix(top, grey, dull); bot = mix(bot, grey, dull * 0.8);
    var gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, rgb(top)); gr.addColorStop(1, rgb(bot));
    g.fillStyle = gr; g.fillRect(0, 0, W, H);

    if (C.day < 0.6) {                                    // stars (fade out with cloud)
      var sa = (1 - C.day / 0.6) * (1 - C.cloud * 0.9);
      stars.forEach(function (s) { g.fillStyle = "rgba(255,255,240," + (sa * (0.5 + 0.5 * Math.sin(t / 900 + s.p))).toFixed(2) + ")"; g.beginPath(); g.arc(s.x, s.y, s.r, 0, 6.3); g.fill(); });
    }
    // sun by day, moon by night, moving across the sky with the time
    var sx = W * (0.1 + 0.8 * C.sunPos), sy = H * 0.62 - Math.sin(C.sunPos * Math.PI) * H * 0.5, vis = 1 - C.cloud * 0.7 - C.fog * 0.3;
    if (T.day) { g.fillStyle = "rgba(255,226,140," + (0.22 * vis).toFixed(2) + ")"; g.beginPath(); g.arc(sx, sy, 70, 0, 6.3); g.fill();
      g.fillStyle = "rgba(255,240,190," + clamp(vis + 0.15, 0, 1) + ")"; g.beginPath(); g.arc(sx, sy, 28, 0, 6.3); g.fill(); }
    else { g.fillStyle = "rgba(235,240,255," + clamp(vis + 0.1, 0, 1) + ")"; g.beginPath(); g.arc(sx, sy, 22, 0, 6.3); g.fill();
      g.fillStyle = rgb(top); g.beginPath(); g.arc(sx + 9, sy - 4, 20, 0, 6.3); g.fill(); }

    // clouds: how many and how dark come from cloud cover and rain; speed comes from wind
    var n = Math.round(C.cloud * clouds.length), speed = reduce ? 0 : (0.12 + C.wind * 0.045);
    for (var i = 0; i < n; i++) {
      var c = clouds[i]; c.x += speed * c.v; if (c.x > W + 160) c.x = -160;
      var col = mix(mix([255, 255, 255], grey, 0.35 + (C.rain + C.snow) * 0.4), [255, 200, 150], C.dusk * 0.4), a = 0.35 + C.cloud * 0.4;
      if (!T.day) col = mix(col, [60, 66, 90], 0.7);
      g.fillStyle = rgb(col, a);
      for (var b = 0; b < 4; b++) { g.beginPath(); g.ellipse(c.x + b * 34 * c.s, c.y + (b % 2) * 8 * c.s, 48 * c.s, 24 * c.s, 0, 0, 6.3); g.fill(); }
    }
    skyline(C.day, top);

    // rain and snow
    var want = Math.round((C.rain * 320 + C.snow * 160) * (reduce ? 0.3 : 1));
    while (drops.length < want) drops.push({ x: Math.random() * W, y: Math.random() * -H, v: 0.7 + Math.random() * 0.6, o: Math.random() });
    drops.length = Math.min(drops.length, want);
    var slant = clamp(C.wind / 40, 0, 1.2) * 8;
    drops.forEach(function (d) {
      if (C.snow > C.rain) { d.y += 1 + d.v * 1.2; d.x += Math.sin(t / 700 + d.o * 9) * 0.5 + slant * 0.1; g.fillStyle = "rgba(255,255,255,.85)"; g.beginPath(); g.arc(d.x, d.y, 1.8, 0, 6.3); g.fill(); }
      else { d.y += 11 * d.v; d.x += slant * d.v; g.strokeStyle = "rgba(200,220,255,.55)"; g.lineWidth = 1.2; g.beginPath(); g.moveTo(d.x, d.y); g.lineTo(d.x - slant * 0.7, d.y - 14); g.stroke(); }
      if (d.y > H) { d.y = -10; d.x = Math.random() * W; }
    });

    // haze from air quality: the worse the AQI the thicker and browner
    if (C.haze > 0.02 || C.fog > 0.02) {
      var ha = clamp(C.haze * 0.8 + C.fog * 0.5, 0, 0.85), hz = g.createLinearGradient(0, H * 0.2, 0, H);
      hz.addColorStop(0, rgb(HAZE, ha * 0.5)); hz.addColorStop(1, rgb(HAZE, ha)); g.fillStyle = hz; g.fillRect(0, 0, W, H);
    }
    if (C.thunder > 0.5 && !reduce) {                    // lightning flashes
      if (Math.random() < 0.006) C.flash = 1;
      if (C.flash > 0.02) { g.fillStyle = "rgba(255,255,255," + (C.flash * 0.5).toFixed(2) + ")"; g.fillRect(0, 0, W, H); C.flash *= 0.85; }
    }
    requestAnimationFrame(draw);
  }

  function skyline(day, skyTop) {
    var base = H, col = mix([8, 14, 34], [26, 34, 60], day), u = Math.min(W / 1100, 1.2) * (H < 600 ? 0.8 : 1);
    g.fillStyle = rgb(col);
    if (city.sky !== "mosque") {
      var x = 0, seed = 7;
      while (x < W) { seed = (seed * 9301 + 49297) % 233280; var w = 36 + seed % 50, h = 60 + (seed % 170) * u; g.fillRect(x, base - h, w, h); x += w + 4; }
      if (city.sky !== "towers") return;
      var cx = W * 0.72; g.fillRect(cx - 4, base - 330 * u, 8, 330 * u); g.beginPath(); g.ellipse(cx, base - 250 * u, 20, 9, 0, 0, 6.3); g.fill();
      return;
    }
    // mosque skyline: three domes, four minarets, a long wall
    var cx2 = W * 0.7, s = 1.25 * u;
    g.fillRect(cx2 - 330 * s, base - 70 * s, 660 * s, 70 * s);
    function dome(x, r) { g.beginPath(); g.arc(x, base - 70 * s, r * s, Math.PI, 0); g.fill(); g.fillRect(x - 3, base - 70 * s - r * s - 16 * s, 6, 16 * s); }
    dome(cx2, 76); dome(cx2 - 150 * s, 50); dome(cx2 + 150 * s, 50);
    [-310, -230, 230, 310].forEach(function (dx) {
      var x = cx2 + dx * s; g.fillRect(x - 9 * s, base - 215 * s, 18 * s, 150 * s);
      g.beginPath(); g.arc(x, base - 215 * s, 9 * s, Math.PI, 0); g.fill(); g.fillRect(x - 2, base - 235 * s, 4, 14 * s);
    });
    g.fillRect(0, base - 26 * s, W, 26 * s);
  }

  /* ---------- sound: wind and rain made from filtered noise, a soft tone that follows the temperature ---------- */
  var ac = null, snd = null, soundOn = false;
  function buildSound() {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    var buf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate), d = buf.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    function noise() { var s = ac.createBufferSource(); s.buffer = buf; s.loop = true; s.start(); return s; }
    var master = ac.createGain(); master.gain.value = 0.9; master.connect(ac.destination);
    var wind = ac.createBiquadFilter(); wind.type = "bandpass"; wind.Q.value = 0.7; var wg = ac.createGain(); wg.gain.value = 0;
    noise().connect(wind); wind.connect(wg); wg.connect(master);
    var rain = ac.createBiquadFilter(); rain.type = "highpass"; rain.frequency.value = 2200; var rg = ac.createGain(); rg.gain.value = 0;
    noise().connect(rain); rain.connect(rg); rg.connect(master);
    var tone = ac.createOscillator(), tone2 = ac.createOscillator(), tg = ac.createGain(); tg.gain.value = 0.035;
    tone.type = tone2.type = "sine"; tone.connect(tg); tone2.connect(tg); tg.connect(master); tone.start(); tone2.start();
    snd = { master: master, wind: wind, wg: wg, rg: rg, tone: tone, tone2: tone2, tg: tg };
  }
  function setSound(s) {
    if (!snd || !soundOn) return;
    var t = ac.currentTime, SCALE = [0, 2, 4, 7, 9];               // pentatonic: temperature picks the note
    var step = Math.round(clamp((s.temp + 10) / 55, 0, 1) * 14), note = SCALE[step % 5] + 12 * Math.floor(step / 5);
    var f = 196 * Math.pow(2, note / 12);
    snd.tone.frequency.setTargetAtTime(f, t, 0.4); snd.tone2.frequency.setTargetAtTime(f * 1.5, t, 0.4);
    snd.wind.frequency.setTargetAtTime(250 + s.wind * 14, t, 0.5);
    snd.wg.gain.setTargetAtTime(clamp(s.wind / 60, 0.02, 0.6), t, 0.5);
    snd.rg.gain.setTargetAtTime(s.precip > 0 && !isSnow(s.code) ? clamp(0.08 + s.precip / 8, 0.08, 0.5) : 0, t, 0.5);
  }
  $("soundBtn").addEventListener("click", function () {
    soundOn = !soundOn;
    this.setAttribute("aria-pressed", soundOn); this.textContent = soundOn ? "Sound on" : "Sound off";
    if (soundOn) { if (!ac) buildSound(); ac.resume(); snd.master.gain.setTargetAtTime(0.9, ac.currentTime, 0.2); if (data) setSound(stateAt(offset)); }
    else if (snd) snd.master.gain.setTargetAtTime(0, ac.currentTime, 0.2);
  });

  /* ---------- controls ---------- */
  var cityBox = $("cities");
  CITIES.forEach(function (c) {
    var b = document.createElement("button"); b.type = "button"; b.textContent = c.name; b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", c === city); b.dataset.name = c.name;
    b.addEventListener("click", function () {
      city = c; offset = 0; $("hour").value = 0; stopPlay(); data = null;
      [].forEach.call(cityBox.children, function (x) { x.setAttribute("aria-checked", x === b); });
      $("content").hidden = true; $("title").textContent = c.name + " right now"; load();
    });
    cityBox.appendChild(b);
  });
  $("unitBtn").addEventListener("click", function () {
    imperial = !imperial; this.setAttribute("aria-pressed", imperial); this.textContent = imperial ? "°F · mph" : "°C · km/h"; render();
  });
  $("hour").addEventListener("input", function () { offset = +this.value; render(); });
  function stopPlay() { clearInterval(playTimer); playTimer = null; $("playBtn").textContent = "Play"; $("playBtn").setAttribute("aria-label", "Play the next 24 hours"); }
  $("playBtn").addEventListener("click", function () {
    if (playTimer) { stopPlay(); return; }
    this.textContent = "Pause"; this.setAttribute("aria-label", "Pause");
    if (offset >= +$("hour").max) { offset = 0; }
    playTimer = setInterval(function () {
      offset++; $("hour").value = offset; render();
      if (offset >= +$("hour").max) stopPlay();
    }, 900);
  });
  $("refreshBtn").addEventListener("click", function () { load(); });
  $("retryBtn").addEventListener("click", function () { load(); });
  setInterval(function () { if (!document.hidden) load(); }, 10 * 60 * 1000);          // refresh every 10 minutes
  setInterval(function () {
    if (!fetchedAt) return; var m = Math.floor((Date.now() - fetchedAt) / 60000);
    $("updated").textContent = "Updated " + (m < 1 ? "just now" : m + " min ago");
  }, 15000);

  addEventListener("resize", resize); resize();
  requestAnimationFrame(draw);
  load();
})();
