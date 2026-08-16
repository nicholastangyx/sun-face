import React, { useEffect, useRef, useState, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import './styles.css';

const DIRECTIONS = ['N','NE','E','SE','S','SW','W','NW'];
const CELL = { N:'1/2', NE:'1/3', E:'2/3', SE:'3/3', S:'3/2', SW:'3/1', W:'2/1', NW:'1/1' };
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTH_DAYS = [31,28,31,30,31,30,31,31,30,31,30,31];
const LAND = [
  [[72,-165],[70,-140],[60,-130],[52,-125],[48,-123],[35,-117],[25,-105],[18,-92],[28,-82],[45,-82],[52,-60],[62,-65],[70,-85]],
  [[12,-81],[5,-78],[-5,-80],[-18,-72],[-35,-70],[-55,-68],[-52,-58],[-35,-52],[-12,-45],[5,-50],[12,-62]],
  [[72,-10],[70,25],[62,40],[52,32],[48,20],[42,28],[36,18],[38,5],[44,-8],[55,-5],[62,-20]],
  [[36,-17],[36,10],[32,32],[22,42],[5,50],[-15,45],[-35,28],[-35,12],[-25,-5],[-5,-15],[16,-17]],
  [[72,35],[70,90],[62,145],[52,160],[42,142],[28,135],[10,120],[8,95],[20,75],[32,55],[45,38],[58,30]],
  [[-12,114],[-16,145],[-28,153],[-40,145],[-42,120],[-30,112]],
  [[82,-72],[76,-42],[62,-45],[60,-65],[70,-75]]
];
const TONES = { Golden: '#fff0bf', Neutral: '#e4e7f5', Blurple: '#b5abfc' };

function dayOfYear(m, d) {
  return MONTH_DAYS.slice(0, m - 1).reduce((a, b) => a + b, 0) + d;
}

function sunAt(latitude, month, day, solarTime) {
  const n = dayOfYear(month, day), r = Math.PI / 180;
  const declination = 23.44 * Math.sin(r * (360 / 365 * (n - 81)));
  const lat = latitude * r, dec = declination * r, hourAngle = (solarTime - 12) * 15 * r;
  const sinE = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(hourAngle);
  const elevation = Math.asin(Math.max(-1, Math.min(1, sinE))) / r;
  const azimuth = (Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat)) / r + 180 + 360) % 360;
  const rawCosH = -Math.tan(lat) * Math.tan(dec);
  const daylight = rawCosH >= 1 ? 0 : rawCosH <= -1 ? 24 : Math.acos(rawCosH) / r / 15;
  return { elevation, azimuth, sunrise: 12 - daylight, sunset: 12 + daylight, daylight };
}

function formatTime(v) {
  const t = Math.round(v * 60), h = Math.floor(t / 60), m = t % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function gpt(la, lo, rad) {
  const a = THREE.MathUtils.degToRad(la), b = THREE.MathUtils.degToRad(lo);
  return new THREE.Vector3(Math.cos(a) * Math.cos(b) * rad, Math.sin(a) * rad, Math.cos(a) * Math.sin(b) * rad);
}

function buildLandMesh(points) {
  const c = points.reduce((s, p) => ({ lat: s.lat + p[0], lon: s.lon + p[1] }), { lat: 0, lon: 0 });
  c.lat /= points.length; c.lon /= points.length;
  const shape = new THREE.Shape();
  points.forEach((p, i) => { const x = p[1] - c.lon, y = p[0] - c.lat; if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y); });
  shape.closePath();
  let tri = Array.from(new THREE.ShapeGeometry(shape).toNonIndexed().attributes.position.array);
  for (let pass = 0; pass < 4; pass++) {
    const next = [];
    for (let i = 0; i < tri.length; i += 9) {
      const a = [tri[i], tri[i+1]], b = [tri[i+3], tri[i+4]], d = [tri[i+6], tri[i+7]];
      const ab = [(a[0]+b[0])/2,(a[1]+b[1])/2], bd = [(b[0]+d[0])/2,(b[1]+d[1])/2], da = [(d[0]+a[0])/2,(d[1]+a[1])/2];
      [[a,ab,da],[ab,b,bd],[da,bd,d],[ab,bd,da]].forEach(t => t.forEach(v => next.push(v[0],v[1],0)));
    }
    tri = next;
  }
  const out = [], nrm = [];
  for (let i = 0; i < tri.length; i += 3) {
    const v = gpt(c.lat + tri[i+1], c.lon + tri[i], 1.385);
    const n = v.clone().normalize();
    out.push(v.x, v.y, v.z); nrm.push(n.x, n.y, n.z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#8b7fd0', roughness: 0.7, metalness: 0.04, side: THREE.DoubleSide }));
}

function sunPos(elevDeg, aziDeg, d) {
  const elev = THREE.MathUtils.degToRad(Math.max(elevDeg, 5)), azi = THREE.MathUtils.degToRad(aziDeg);
  return new THREE.Vector3(Math.sin(azi) * Math.cos(elev) * d, Math.sin(elev) * d, Math.cos(azi) * Math.cos(elev) * d);
}

function Globe({ location, onSelect }) {
  const mount = useRef(null);
  const ctx = useRef({});

  useEffect(() => {
    const el = mount.current;
    const T = THREE;
    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(32, el.clientWidth / el.clientHeight, 0.1, 100);
    camera.position.set(0, 0.2, 4.1);
    const renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.domElement.style.display = 'block';
    el.appendChild(renderer.domElement);

    const group = new T.Group();
    const globe = new T.Mesh(
      new T.SphereGeometry(1.35, 64, 40),
      new T.MeshStandardMaterial({ color: '#1a1c2a', roughness: 0.95, metalness: 0.02 })
    );
    group.add(globe);
    LAND.forEach(points => group.add(buildLandMesh(points)));
    group.add(new T.Mesh(
      new T.SphereGeometry(1.46, 48, 32),
      new T.MeshBasicMaterial({ color: '#9184d9', transparent: true, opacity: 0.1, side: T.BackSide })
    ));

    const grat = new T.Group();
    const lineMat = new T.LineBasicMaterial({ color: '#b5abfc', transparent: true, opacity: 0.14 });
    for (let lat = -60; lat <= 60; lat += 30) {
      const r = Math.cos(T.MathUtils.degToRad(lat)) * 1.356, y = Math.sin(T.MathUtils.degToRad(lat)) * 1.356;
      const ps = Array.from({ length: 97 }, (_, i) => new T.Vector3(Math.cos(i/96*Math.PI*2)*r, y, Math.sin(i/96*Math.PI*2)*r));
      grat.add(new T.Line(new T.BufferGeometry().setFromPoints(ps), lineMat));
    }
    for (let lon = 0; lon < 180; lon += 30) {
      const ps = Array.from({ length: 97 }, (_, i) => { const a = i/96*Math.PI*2; return new T.Vector3(Math.sin(a)*1.356*Math.cos(T.MathUtils.degToRad(lon)), Math.cos(a)*1.356, Math.sin(a)*1.356*Math.sin(T.MathUtils.degToRad(lon))); });
      grat.add(new T.Line(new T.BufferGeometry().setFromPoints(ps), lineMat));
    }
    group.add(grat);

    const marker = new T.Mesh(new T.SphereGeometry(0.035, 16, 16), new T.MeshBasicMaterial({ color: '#d2cefd' }));
    marker.visible = false; group.add(marker);
    const halo = new T.Mesh(new T.RingGeometry(0.06, 0.075, 32), new T.MeshBasicMaterial({ color: '#9184d9', transparent: true, opacity: 0.8, side: T.DoubleSide }));
    halo.visible = false; group.add(halo);

    scene.add(group);
    scene.add(new T.AmbientLight('#9397ab', 0.35));
    const key = new T.DirectionalLight('#f3f5fe', 1.5); key.position.set(-3, 2, 4); scene.add(key);
    const rim = new T.DirectionalLight('#9184d9', 0.8); rim.position.set(3.5, -1, -2.5); scene.add(rim);

    const frameGlobe = () => {
      const half = Math.tan(T.MathUtils.degToRad(camera.fov) / 2);
      // 1.50 = just above atmosphere radius (1.46) — globe fills the panel closely
      camera.position.setLength(1.50 / Math.min(half, half * camera.aspect));
      camera.lookAt(0, 0, 0);
    };
    frameGlobe();
    // Re-frame after first paint in case layout dimensions settled
    requestAnimationFrame(() => {
      if (!el.clientWidth) return;
      camera.aspect = el.clientWidth / el.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(el.clientWidth, el.clientHeight);
      frameGlobe();
    });

    ctx.current = { scene, camera, renderer, group, globe, grat, marker, halo, spin: true };

    const animate = () => {
      ctx.current.animFrame = requestAnimationFrame(animate);
      if (ctx.current.spin) ctx.current.group.rotation.y += 0.0012;
      renderer.render(scene, camera);
    };
    animate();

    const resize = () => {
      if (!el.clientWidth) return;
      camera.aspect = el.clientWidth / el.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(el.clientWidth, el.clientHeight);
      frameGlobe();
    };
    window.addEventListener('resize', resize);

    let dragging = false, px = 0, py = 0;
    el.onpointerdown = e => { dragging = false; px = e.clientX; py = e.clientY; ctx.current.spin = false; el.setPointerCapture(e.pointerId); };
    el.onpointermove = e => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      const dx = e.clientX - px, dy = e.clientY - py;
      if (Math.abs(dx) + Math.abs(dy) > 3) dragging = true;
      ctx.current.group.rotation.y += dx * 0.006;
      ctx.current.group.rotation.x = T.MathUtils.clamp(ctx.current.group.rotation.x + dy * 0.004, -0.8, 0.8);
      px = e.clientX; py = e.clientY;
    };
    el.onpointerup = e => {
      if (!dragging) {
        const rect = el.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width * 2 - 1;
        const y = -((e.clientY - rect.top) / rect.height * 2 - 1);
        const ray = new T.Raycaster(); ray.setFromCamera(new T.Vector2(x, y), ctx.current.camera);
        const hits = ray.intersectObject(ctx.current.globe);
        if (hits.length) {
          const local = ctx.current.group.worldToLocal(hits[0].point.clone());
          onSelect({
            latitude: T.MathUtils.radToDeg(Math.asin(local.y / 1.35)),
            longitude: T.MathUtils.radToDeg(Math.atan2(local.z, local.x))
          });
        }
      }
      el.releasePointerCapture(e.pointerId);
    };

    return () => {
      cancelAnimationFrame(ctx.current.animFrame);
      window.removeEventListener('resize', resize);
      renderer.dispose();
      if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement);
    };
  }, []);

  useEffect(() => {
    const c = ctx.current;
    if (!c.marker) return;
    c.marker.visible = !!location;
    c.halo.visible = !!location;
    if (!location) return;
    const p = gpt(location.latitude, location.longitude, 1.415);
    c.marker.position.copy(p);
    c.halo.position.copy(p);
    c.halo.lookAt(0, 0, 0);
  }, [location]);

  return <div ref={mount} style={{ height: '100%', cursor: 'grab', touchAction: 'none' }} />;
}

function HouseScene({ orientation, sun, latitude, month, day }) {
  const mount = useRef(null);
  const ctx = useRef({});

  useEffect(() => {
    const el = mount.current;
    const T = THREE;
    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(34, el.clientWidth / el.clientHeight, 0.1, 100);
    const renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = T.PCFSoftShadowMap;
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.domElement.style.display = 'block';
    el.appendChild(renderer.domElement);

    scene.add(new T.HemisphereLight('#b2b6ca', '#161826', 0.75));

    const ground = new T.Mesh(new T.PlaneGeometry(28, 28), new T.MeshStandardMaterial({ color: '#232532', roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

    const grid = new T.GridHelper(28, 28, '#3f424d', '#292b31');
    grid.position.y = 0.004; grid.material.transparent = true; grid.material.opacity = 0.35; scene.add(grid);

    const house = new T.Group(); scene.add(house);
    const wall = new T.Mesh(new T.BoxGeometry(2.8, 1.7, 2.3), new T.MeshStandardMaterial({ color: '#cfd3e5', roughness: 0.9 }));
    wall.position.y = 0.95; wall.castShadow = true; wall.receiveShadow = true; house.add(wall);
    const roof = new T.Mesh(new T.ConeGeometry(2.05, 1.25, 4), new T.MeshStandardMaterial({ color: '#5d5294', roughness: 0.8 }));
    roof.rotation.y = Math.PI / 4; roof.position.y = 2.42; roof.castShadow = true; house.add(roof);
    const door = new T.Mesh(new T.BoxGeometry(0.5, 0.9, 0.04), new T.MeshStandardMaterial({ color: '#423a6a' }));
    door.position.set(0, 0.58, 1.17); house.add(door);
    [-0.85, 0.85].forEach(x => {
      const w = new T.Mesh(new T.BoxGeometry(0.52, 0.45, 0.04), new T.MeshStandardMaterial({ color: '#d2cefd', emissive: '#9184d9', emissiveIntensity: 0.35 }));
      w.position.set(x, 1.2, 1.17); house.add(w);
    });
    const facing = new T.Mesh(new T.ConeGeometry(0.14, 0.4, 3), new T.MeshBasicMaterial({ color: '#9184d9' }));
    facing.rotation.x = Math.PI / 2; facing.position.set(0, 0.06, 2.2); house.add(facing);

    const compass = new T.Mesh(new T.RingGeometry(3.5, 3.53, 64), new T.MeshBasicMaterial({ color: '#9184d9', transparent: true, opacity: 0.42, side: T.DoubleSide }));
    compass.rotation.x = -Math.PI / 2; compass.position.y = 0.012; scene.add(compass);

    const arc = new T.Group(); scene.add(arc);

    const light = new T.DirectionalLight('#fff0bf', 3);
    light.castShadow = true; light.shadow.mapSize.set(2048, 2048);
    light.shadow.camera.left = -6; light.shadow.camera.right = 6;
    light.shadow.camera.top = 6; light.shadow.camera.bottom = -6;
    scene.add(light);

    const sunMesh = new T.Mesh(new T.SphereGeometry(0.17, 20, 20), new T.MeshBasicMaterial({ color: '#fff0bf' }));
    scene.add(sunMesh);
    const glow = new T.Mesh(new T.SphereGeometry(0.42, 20, 20), new T.MeshBasicMaterial({ color: '#9184d9', transparent: true, opacity: 0.22 }));
    scene.add(glow);

    const cam = { theta: Math.atan2(5.6, 6.6), phi: 0.55, dist: 9.6 };
    const placeCamera = () => {
      camera.position.set(
        Math.sin(cam.theta) * Math.cos(cam.phi) * cam.dist,
        Math.sin(cam.phi) * cam.dist,
        Math.cos(cam.theta) * Math.cos(cam.phi) * cam.dist
      );
      camera.lookAt(0, 0.7, 0);
    };
    placeCamera();

    el.style.cursor = 'grab'; el.style.touchAction = 'none';
    let px = 0, py = 0;
    el.onpointerdown = e => { px = e.clientX; py = e.clientY; el.style.cursor = 'grabbing'; el.setPointerCapture(e.pointerId); };
    el.onpointermove = e => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      cam.theta -= (e.clientX - px) * 0.007;
      cam.phi = THREE.MathUtils.clamp(cam.phi + (e.clientY - py) * 0.005, 0.12, 1.35);
      px = e.clientX; py = e.clientY; placeCamera();
    };
    el.onpointerup = e => { el.style.cursor = 'grab'; el.releasePointerCapture(e.pointerId); };

    const resize = () => {
      if (!el.clientWidth) return;
      camera.aspect = el.clientWidth / el.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(el.clientWidth, el.clientHeight);
    };
    window.addEventListener('resize', resize);

    const animate = () => { ctx.current.animFrame = requestAnimationFrame(animate); renderer.render(scene, camera); };
    animate();

    ctx.current = { el, scene, camera, renderer, house, light, sunMesh, glow, arc, arcKey: null };

    return () => {
      cancelAnimationFrame(ctx.current.animFrame);
      window.removeEventListener('resize', resize);
      renderer.dispose();
      if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement);
    };
  }, []);

  useEffect(() => {
    const c = ctx.current;
    if (!c.house) return;
    const T = THREE;

    c.house.rotation.y = T.MathUtils.degToRad(DIRECTIONS.indexOf(orientation) * 45);

    const p = sunPos(sun.elevation, sun.azimuth, 5.5);
    c.light.position.copy(p);
    c.light.color = new T.Color(TONES.Golden);
    c.light.intensity = sun.elevation > 0 ? 3 : 0.05;
    c.sunMesh.position.copy(p);
    c.glow.position.copy(p);

    const arcKey = `${month}-${day}-${latitude.toFixed(2)}`;
    if (c.arcKey !== arcKey) {
      c.arcKey = arcKey;
      while (c.arc.children.length) c.arc.remove(c.arc.children[0]);
      const pts = [];
      for (let t = sun.sunrise; t <= sun.sunset; t += (sun.sunset - sun.sunrise) / 48) {
        const a = sunAt(latitude, month, day, t);
        pts.push(sunPos(a.elevation, a.azimuth, 5.5));
      }
      if (pts.length > 1) {
        c.arc.add(new T.Line(
          new T.BufferGeometry().setFromPoints(pts),
          new T.LineBasicMaterial({ color: '#9184d9', transparent: true, opacity: 0.45 })
        ));
      }
    }
  }, [orientation, sun, latitude, month, day]);

  return <div ref={mount} style={{ height: '100%', minHeight: 660 }} />;
}

function App() {
  const [location, setLocation] = useState(null);
  const [month, setMonth] = useState(6);
  const [day, setDay] = useState(21);
  const [orientation, setOrientation] = useState('S');
  const [time, setTime] = useState(12);
  const [playing, setPlaying] = useState(false);

  const latitude = location?.latitude ?? 51.5;
  const sun = useMemo(() => sunAt(latitude, month, day, time), [latitude, month, day, time]);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setTime(t => {
      const next = t + 0.05;
      if (next >= sun.sunset) { setPlaying(false); return sun.sunset; }
      return next;
    }), 50);
    return () => clearInterval(id);
  }, [playing, sun.sunset]);

  const chooseMonth = val => {
    const m = Number(val);
    setMonth(m); setDay(d => Math.min(d, MONTH_DAYS[m - 1])); setTime(12);
  };

  const pickLocation = loc => {
    setLocation(loc);
    setTimeout(() => document.getElementById('study')?.scrollIntoView({ behavior: 'smooth' }), 50);
  };

  const navStatus = location
    ? `${location.latitude.toFixed(1)}° / ${location.longitude.toFixed(1)}°`
    : 'no location picked';

  const coords = location
    ? `${location.latitude.toFixed(2)}° ${location.latitude >= 0 ? 'N' : 'S'}  ·  ${Math.abs(location.longitude).toFixed(2)}° ${location.longitude >= 0 ? 'E' : 'W'}`
    : '51.50° N  ·  0.10° W';

  return (
    <div id="top" style={{ minHeight: '100vh', background: '#161826', color: '#e9e9ed', fontFamily: 'Inter, system-ui, sans-serif', overflowX: 'hidden' }}>

      {/* Nav */}
      <nav style={{ position: 'sticky', top: 0, zIndex: 20, display: 'flex', alignItems: 'center', gap: 17, padding: '14px 45px', background: 'rgba(22,24,38,.82)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)', borderBottom: '1px solid rgba(233,233,237,.08)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginRight: 'auto' }}>
          <span style={{ width: 11, height: 11, borderRadius: '50%', background: 'linear-gradient(90deg,#9184d9 50%,transparent 50%)', boxShadow: '0 0 14px rgba(145,132,217,.6)', display: 'inline-block' }} />
          <span style={{ fontWeight: 500, fontSize: 15, letterSpacing: '.22em' }}>SUNFACE</span>
        </div>
        <span style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: '#9397ab' }}>{navStatus}</span>
        <a href="#study" style={{ fontSize: 13, fontWeight: 500, color: '#9184d9', border: '1px solid #9184d9', borderRadius: 8, padding: '5px 12px', textDecoration: 'none', display: 'inline-block' }}>Study the light</a>
      </nav>

      {/* Landing */}
      <section style={{ display: 'grid', gridTemplateColumns: 'minmax(0,38%) minmax(0,1fr)', alignItems: 'center', gap: 45, padding: '56px 45px 84px', minHeight: 'calc(100vh - 56px)' }}>
        <div>
          <p style={{ fontSize: 11, letterSpacing: '.14em', textTransform: 'uppercase', color: '#9184d9', margin: '0 0 22px' }}>01 / choose a place</p>
          <h1 style={{ fontSize: 'clamp(52px,5.6vw,88px)', fontWeight: 500, lineHeight: 1.02, letterSpacing: '-.035em', margin: '0 0 22px', textWrap: 'pretty', fontFamily: 'inherit' }}>
            Where does <span style={{ color: '#9184d9' }}>the light</span> land?
          </h1>
          <p style={{ fontSize: 16, lineHeight: 1.65, maxWidth: 340, color: '#9397ab', margin: '0 0 45px' }}>
            Pick a point on Earth. Then turn a house, turn the year, and watch the sun move through it.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: '#75798c' }}>
            <span style={{ width: 22, height: 1, background: '#9184d9', display: 'inline-block', flexShrink: 0 }} />
            drag to rotate · click to select
          </div>
        </div>
        <div style={{ position: 'relative', height: 'min(640px,72vh)' }}>
          <Globe location={location} onSelect={pickLocation} />
          <div style={{ position: 'absolute', inset: 'auto 0 0 0', display: 'flex', justifyContent: 'space-between', fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', color: '#75798c', pointerEvents: 'none' }}>
            <span>earth / 3D</span>
            <span>{location ? 'location set' : 'latitude + longitude'}</span>
          </div>
        </div>
      </section>

      {/* Study */}
      <section id="study" style={{ padding: '0 45px 67px', scrollMarginTop: 70 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 22, paddingBottom: 22, marginBottom: 34, background: 'linear-gradient(to right, transparent, rgba(233,233,237,.16) 48px, rgba(233,233,237,.16) calc(100% - 48px), transparent) no-repeat bottom / 100% 1px' }}>
          <div>
            <p style={{ fontSize: 11, letterSpacing: '.14em', textTransform: 'uppercase', color: '#9184d9', margin: '0 0 11px' }}>02 / study the light</p>
            <h2 style={{ fontSize: 'clamp(28px,3.2vw,42px)', fontWeight: 500, letterSpacing: '-.025em', margin: 0, fontFamily: 'inherit' }}>{coords}</h2>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#d2cefd', border: '1px solid rgba(233,233,237,.16)', borderRadius: 8, padding: '7px 12px', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {MONTHS[month - 1]} {day}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '300px minmax(0,1fr)', gap: 22, alignItems: 'start' }}>

          {/* Controls */}
          <aside style={{ display: 'flex', flexDirection: 'column', gap: 22, background: '#232532', borderRadius: 14, padding: 22, boxShadow: '0 0 0 1px #3f424d' }}>

            {/* Day of year */}
            <div>
              <label style={{ display: 'block', fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: '#9397ab', marginBottom: 11 }}>Day of the year</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <select value={month} onChange={e => chooseMonth(e.target.value)} style={{ flex: 1, minHeight: 36, padding: '6px 10px', fontFamily: 'inherit', fontSize: 14, color: '#e9e9ed', background: '#161826', border: '1px solid rgba(233,233,237,.16)', borderRadius: 8, cursor: 'pointer' }}>
                  {MONTHS.map((m, i) => <option value={i+1} key={m}>{m}</option>)}
                </select>
                <input type="number" min="1" max={MONTH_DAYS[month-1]} value={day} onChange={e => { setDay(Math.max(1, Math.min(MONTH_DAYS[month-1], Number(e.target.value)))); setTime(12); }} style={{ width: 68, minHeight: 36, padding: '6px 10px', fontFamily: 'inherit', fontSize: 14, color: '#e9e9ed', background: '#161826', border: '1px solid rgba(233,233,237,.16)', borderRadius: 8 }} />
              </div>
            </div>

            {/* House facing */}
            <div>
              <label style={{ display: 'block', fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: '#9397ab', marginBottom: 11 }}>House facing</label>
              <div style={{ position: 'relative', display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gridTemplateRows: 'repeat(3,1fr)', gap: 5, aspectRatio: '1/1' }}>
                {DIRECTIONS.map(d => (
                  <button key={d} onClick={() => setOrientation(d)} style={{ gridArea: CELL[d], display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit', fontSize: 12, fontWeight: 500, cursor: 'pointer', borderRadius: 8, padding: 0, background: orientation === d ? 'rgba(145,132,217,.18)' : 'transparent', border: `1px solid ${orientation === d ? '#9184d9' : 'rgba(233,233,237,.14)'}`, color: orientation === d ? '#d2cefd' : '#9397ab' }}>
                    {d}
                  </button>
                ))}
                <div style={{ gridArea: '2/2', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, pointerEvents: 'none' }}>
                  <span style={{ fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', color: '#75798c' }}>facing</span>
                  <strong style={{ fontSize: 20, fontWeight: 500, color: '#d2cefd' }}>{orientation}</strong>
                </div>
              </div>
            </div>

            {/* Solar time */}
            <div>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
                <label style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: '#9397ab' }}>Solar time</label>
                <strong style={{ fontSize: 26, fontWeight: 500, letterSpacing: '-.02em', color: '#e9e9ed', fontVariantNumeric: 'tabular-nums' }}>{formatTime(time)}</strong>
              </div>
              <input className="sun-range" type="range" min={Math.max(0, sun.sunrise)} max={Math.min(24, sun.sunset)} step=".05" value={time} onChange={e => { setTime(Number(e.target.value)); setPlaying(false); }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, letterSpacing: '.06em', textTransform: 'uppercase', color: '#75798c', marginTop: 8 }}>
                <span>{formatTime(sun.sunrise)} sunrise</span>
                <span>{formatTime(sun.sunset)} sunset</span>
              </div>
              <button onClick={() => setPlaying(p => !p)} className="sf-btn-play" style={{ width: '100%', marginTop: 17, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500, fontSize: 14, color: '#9184d9', background: 'transparent', border: '1px solid #9184d9', borderRadius: 8, padding: '9px 12px' }}>
                {playing ? 'Pause sunlight' : 'Play sunlight'}
              </button>
            </div>

            <p style={{ fontSize: 11, lineHeight: 1.6, color: '#75798c', margin: 0 }}>
              Local solar time. An educational model — real shade also depends on trees, terrain, windows and weather.
            </p>
          </aside>

          {/* House 3D */}
          <div style={{ position: 'relative', minHeight: 660, borderRadius: 14, overflow: 'hidden', background: 'linear-gradient(160deg,#1d2032,#141625 72%)', boxShadow: '0 0 0 1px #3f424d' }}>
            <HouseScene orientation={orientation} sun={sun} latitude={latitude} month={month} day={day} />
            <div style={{ position: 'absolute', top: 17, left: 17, display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', color: '#9397ab', pointerEvents: 'none' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#9184d9', boxShadow: '0 0 10px #9184d9', animation: 'sunPulse 2.4s ease-in-out infinite', display: 'inline-block' }} />
              live sunlight preview
            </div>
            <a href="#top" onClick={e => { e.preventDefault(); setLocation(null); window.scrollTo({ top: 0, behavior: 'smooth' }); }} className="sf-link-change" style={{ position: 'absolute', top: 14, right: 17, fontSize: 12, fontWeight: 500, color: '#9184d9', textDecoration: 'none', border: '1px solid rgba(233,233,237,.16)', borderRadius: 8, padding: '6px 12px', background: 'rgba(22,24,38,.7)', display: 'inline-block' }}>
              Change location
            </a>
            <div style={{ position: 'absolute', left: 17, bottom: 17, right: 17, display: 'flex', gap: 22, fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', color: '#75798c', pointerEvents: 'none' }}>
              <span>house / 3D</span><span>drag to turn the view</span><span>shadow at {formatTime(time)}</span>
            </div>
          </div>
        </div>
      </section>

      {/* Stats band */}
      <section style={{ background: 'linear-gradient(120deg,#262a60,#353b80)', padding: 45 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 22 }}>
          {[
            { label: 'Sunrise', value: formatTime(sun.sunrise) },
            { label: 'Solar noon', value: '12:00' },
            { label: 'Sunset', value: formatTime(sun.sunset) },
            { label: 'Daylight', value: `${sun.daylight.toFixed(1)} h` }
          ].map(s => (
            <div key={s.label}>
              <div style={{ fontSize: 11, letterSpacing: '.12em', textTransform: 'uppercase', color: '#d2cefd', marginBottom: 8 }}>{s.label}</div>
              <div style={{ fontSize: 'clamp(30px,3.4vw,46px)', fontWeight: 500, letterSpacing: '-.03em', lineHeight: 1, color: '#f3f5fe', fontVariantNumeric: 'tabular-nums' }}>{s.value}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 22, padding: '34px 45px', fontSize: 11, letterSpacing: '.12em', textTransform: 'uppercase', color: '#75798c' }}>
        <span>sunface / 2026</span>
        <span>light is a place you can visit</span>
      </footer>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
