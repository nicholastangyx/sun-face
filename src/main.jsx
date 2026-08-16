import React, { useEffect, useRef, useState, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as topojson from 'topojson-client';
import landTopo from 'world-atlas/land-110m.json';
import './styles.css';

const DIRECTIONS = ['N','NE','E','SE','S','SW','W','NW'];
const CELL = { N:'1/2', NE:'1/3', E:'2/3', SE:'3/3', S:'3/2', SW:'3/1', W:'2/1', NW:'1/1' };
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTH_DAYS = [31,28,31,30,31,30,31,31,30,31,30,31];
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
  if (rawCosH >= 1) return { elevation, azimuth, sunrise: null, sunset: null, daylight: 0, polarNight: true, polarDay: false };
  if (rawCosH <= -1) return { elevation, azimuth, sunrise: 0, sunset: 24, daylight: 24, polarNight: false, polarDay: true };
  const halfDaylight = Math.acos(rawCosH) / r / 15;
  return { elevation, azimuth, sunrise: 12 - halfDaylight, sunset: 12 + halfDaylight, daylight: halfDaylight * 2, polarNight: false, polarDay: false };
}

function formatTime(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const t = Math.round(v * 60), h = Math.floor(t / 60), m = t % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function gpt(la, lo, rad) {
  const a = THREE.MathUtils.degToRad(la), b = THREE.MathUtils.degToRad(lo);
  // Greenwich faces the camera (+Z), with east on the viewer's right.
  return new THREE.Vector3(Math.cos(a) * Math.sin(b) * rad, Math.sin(a) * rad, Math.cos(a) * Math.cos(b) * rad);
}

// Shared land material (created once, reused for all polygons)
const LAND_MAT = new THREE.MeshStandardMaterial({ color: '#8b7fd0', roughness: 0.7, metalness: 0.04, side: THREE.DoubleSide });

// Build a sphere-projected mesh from a GeoJSON ring [[lon,lat], ...]
function geoRingMesh(ring) {
  if (ring.length < 3) return null;
  // Skip rings that cross the antimeridian — centroid-offset approach breaks for them
  let previousLongitude = ring[0][0];
  const continuousRing = ring.map(([longitude, latitude], index) => {
    let continuousLongitude = longitude;
    if (index) {
      while (continuousLongitude - previousLongitude > 180) continuousLongitude -= 360;
      while (continuousLongitude - previousLongitude < -180) continuousLongitude += 360;
    }
    previousLongitude = continuousLongitude;
    return [continuousLongitude, latitude];
  });
  // Centre the ring to reduce floating-point spread inside ShapeGeometry
  let clon = 0, clat = 0;
  continuousRing.forEach(([lon, lat]) => { clon += lon; clat += lat; });
  clon /= continuousRing.length; clat /= continuousRing.length;
  const shape = new THREE.Shape();
  continuousRing.forEach(([lon, lat], i) => {
    if (i === 0) shape.moveTo(lon - clon, lat - clat);
    else shape.lineTo(lon - clon, lat - clat);
  });
  // Triangulate in lon/lat space then subdivide so every vertex lands on the sphere
  let tri = Array.from(new THREE.ShapeGeometry(shape).toNonIndexed().attributes.position.array);
  for (let pass = 0; pass < 3; pass++) {
    const next = [];
    for (let i = 0; i < tri.length; i += 9) {
      const a = [tri[i], tri[i+1]], b = [tri[i+3], tri[i+4]], d = [tri[i+6], tri[i+7]];
      const ab = [(a[0]+b[0])/2,(a[1]+b[1])/2], bd = [(b[0]+d[0])/2,(b[1]+d[1])/2], da = [(d[0]+a[0])/2,(d[1]+a[1])/2];
      [[a,ab,da],[ab,b,bd],[da,bd,d],[ab,bd,da]].forEach(t => t.forEach(v => next.push(v[0],v[1],0)));
    }
    tri = next;
  }
  const out = [], nrm = [];
  for (let i = 0; i < tri.length; i += 9) {
    // The Greenwich-centred projection preserves lon/lat winding, so front
    // faces remain outward for correct land lighting.
    for (const j of [i, i + 3, i + 6]) {
      const v = gpt(tri[j + 1] + clat, tri[j] + clon, 1.385); // gpt(lat, lon, r)
      out.push(v.x, v.y, v.z); nrm.push(...v.clone().normalize().toArray());
    }
  }
  if (out.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return new THREE.Mesh(geo, LAND_MAT);
}

// Decode TopoJSON land-110m → Three.js meshes added to a Group
function buildLandGroup() {
  const group = new THREE.Group();
  const landFC = topojson.feature(landTopo, landTopo.objects.land);
  const features = landFC.type === 'FeatureCollection' ? landFC.features : [landFC];
  features.forEach(({ geometry }) => {
    if (!geometry) return;
    const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    polys.forEach(([outerRing]) => {
      const mesh = geoRingMesh(outerRing);
      if (mesh) group.add(mesh);
    });
  });
  return group;
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
    group.add(buildLandGroup());
    group.add(new T.Mesh(
      new T.SphereGeometry(1.46, 48, 32),
      new T.MeshBasicMaterial({ color: '#9184d9', transparent: true, opacity: 0.1, side: T.BackSide })
    ));

    const grat = new T.Group();
    const lineMat = new T.LineBasicMaterial({ color: '#b5abfc', transparent: true, opacity: 0.14 });
    for (let lat = -60; lat <= 60; lat += 30) {
      const ps = Array.from({ length: 97 }, (_, i) => gpt(lat, i / 96 * 360, 1.356));
      grat.add(new T.Line(new T.BufferGeometry().setFromPoints(ps), lineMat));
    }
    for (let lon = 0; lon < 180; lon += 30) {
      const ps = Array.from({ length: 97 }, (_, i) => gpt(i / 96 * 360 - 90, lon, 1.356));
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
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(el);

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
            longitude: T.MathUtils.radToDeg(Math.atan2(local.x, local.z))
          });
        }
      }
      el.releasePointerCapture(e.pointerId);
    };

    return () => {
      cancelAnimationFrame(ctx.current.animFrame);
      resizeObserver.disconnect();
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
    new GLTFLoader().load('/models/large-building.glb', ({ scene: building }) => {
      building.updateMatrixWorld(true);
      const bounds = new T.Box3().setFromObject(building);
      const size = bounds.getSize(new T.Vector3());
      const center = bounds.getCenter(new T.Vector3());
      building.position.set(-center.x, -bounds.min.y, -center.z);
      building.scale.setScalar(4.5 / Math.max(size.x, size.z));
      building.traverse(node => {
        if (!node.isMesh) return;
        node.castShadow = true;
        node.receiveShadow = true;
      });
      house.add(building);
    }, undefined, error => console.error('Unable to load building model', error));

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
    const zoom = e => {
      e.preventDefault();
      cam.dist = THREE.MathUtils.clamp(cam.dist + e.deltaY * 0.012, 5.5, 16);
      placeCamera();
    };
    el.addEventListener('wheel', zoom, { passive: false });

    const resize = () => {
      if (!el.clientWidth) return;
      camera.aspect = el.clientWidth / el.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(el.clientWidth, el.clientHeight);
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(el);

    const animate = () => { ctx.current.animFrame = requestAnimationFrame(animate); renderer.render(scene, camera); };
    animate();

    ctx.current = { el, scene, camera, renderer, house, light, sunMesh, glow, arc, arcKey: null };

    return () => {
      cancelAnimationFrame(ctx.current.animFrame);
      resizeObserver.disconnect();
      el.removeEventListener('wheel', zoom);
      house.traverse(node => {
        if (!node.isMesh) return;
        node.geometry.dispose();
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        materials.forEach(material => material.dispose());
      });
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
    const isDaylight = sun.elevation > 0;
    c.light.intensity = isDaylight ? 3 : 0.05;
    c.sunMesh.position.copy(p);
    c.glow.position.copy(p);
    c.sunMesh.visible = isDaylight;
    c.glow.visible = isDaylight;

    const arcKey = `${month}-${day}-${latitude.toFixed(2)}`;
    if (c.arcKey !== arcKey) {
      c.arcKey = arcKey;
      while (c.arc.children.length) {
        const child = c.arc.children.pop();
        child.geometry.dispose();
        child.material.dispose();
      }
      const pts = [];
      if (!sun.polarNight) {
        const step = (sun.sunset - sun.sunrise) / 48;
        for (let t = sun.sunrise; t <= sun.sunset + step / 2; t += step) {
          const a = sunAt(latitude, month, day, t);
          pts.push(sunPos(a.elevation, a.azimuth, 5.5));
        }
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
  const hasDaylight = sun.daylight > 0;

  useEffect(() => {
    if (sun.polarNight) {
      setPlaying(false);
      return;
    }
    setTime(t => Math.min(Math.max(t, sun.sunrise), sun.sunset));
  }, [latitude, month, day, sun.polarNight, sun.sunrise, sun.sunset]);

  useEffect(() => {
    if (!playing || !hasDaylight) return;
    const id = setInterval(() => setTime(t => {
      const next = t + 0.05;
      if (next >= sun.sunset) { setPlaying(false); return sun.sunset; }
      return next;
    }), 50);
    return () => clearInterval(id);
  }, [playing, hasDaylight, sun.sunset]);

  const chooseMonth = val => {
    const m = Number(val);
    setMonth(m); setDay(d => Math.min(d, MONTH_DAYS[m - 1])); setPlaying(false); setTime(12);
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
    <div id="top" className="sf-app">

      {/* Nav */}
      <nav className="sf-nav">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginRight: 'auto' }}>
          <span style={{ width: 11, height: 11, borderRadius: '50%', background: 'linear-gradient(90deg,#9184d9 50%,transparent 50%)', boxShadow: '0 0 14px rgba(145,132,217,.6)', display: 'inline-block' }} />
          <span style={{ fontWeight: 500, fontSize: 15, letterSpacing: '.22em' }}>SUNFACE</span>
        </div>
        <span style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: '#9397ab' }}>{navStatus}</span>
        <a href="#study" style={{ fontSize: 13, fontWeight: 500, color: '#9184d9', border: '1px solid #9184d9', borderRadius: 8, padding: '5px 12px', textDecoration: 'none', display: 'inline-block' }}>Study the light</a>
      </nav>

      {/* Landing */}
      <section className="sf-hero">
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
        <div className="sf-globe-panel">
          <Globe location={location} onSelect={pickLocation} />
          <div style={{ position: 'absolute', inset: 'auto 0 0 0', display: 'flex', justifyContent: 'space-between', fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', color: '#75798c', pointerEvents: 'none' }}>
            <span>earth / 3D</span>
            <span>{location ? 'location set' : 'latitude + longitude'}</span>
          </div>
        </div>
      </section>

      {/* Study */}
      <section id="study" className="sf-study">
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 22, paddingBottom: 22, marginBottom: 34, background: 'linear-gradient(to right, transparent, rgba(233,233,237,.16) 48px, rgba(233,233,237,.16) calc(100% - 48px), transparent) no-repeat bottom / 100% 1px' }}>
          <div>
            <p style={{ fontSize: 11, letterSpacing: '.14em', textTransform: 'uppercase', color: '#9184d9', margin: '0 0 11px' }}>02 / study the light</p>
            <h2 style={{ fontSize: 'clamp(28px,3.2vw,42px)', fontWeight: 500, letterSpacing: '-.025em', margin: 0, fontFamily: 'inherit' }}>{coords}</h2>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#d2cefd', border: '1px solid rgba(233,233,237,.16)', borderRadius: 8, padding: '7px 12px', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {MONTHS[month - 1]} {day}
          </div>
        </div>

        <div className="sf-study-grid">

          {/* Controls */}
          <aside className="sf-controls" style={{ display: 'flex', flexDirection: 'column', gap: 22, background: '#232532', borderRadius: 14, padding: 22, boxShadow: '0 0 0 1px #3f424d' }}>

            {/* Day of year */}
            <div>
              <label style={{ display: 'block', fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: '#9397ab', marginBottom: 11 }}>Day of the year</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <select value={month} onChange={e => chooseMonth(e.target.value)} style={{ flex: 1, minHeight: 36, padding: '6px 10px', fontFamily: 'inherit', fontSize: 14, color: '#e9e9ed', background: '#161826', border: '1px solid rgba(233,233,237,.16)', borderRadius: 8, cursor: 'pointer' }}>
                  {MONTHS.map((m, i) => <option value={i+1} key={m}>{m}</option>)}
                </select>
                <input type="number" min="1" max={MONTH_DAYS[month-1]} value={day} onChange={e => { setDay(Math.max(1, Math.min(MONTH_DAYS[month-1], Number(e.target.value)))); setPlaying(false); setTime(12); }} style={{ width: 68, minHeight: 36, padding: '6px 10px', fontFamily: 'inherit', fontSize: 14, color: '#e9e9ed', background: '#161826', border: '1px solid rgba(233,233,237,.16)', borderRadius: 8 }} />
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
              <input className="sun-range" type="range" min={sun.sunrise ?? 0} max={sun.sunset ?? 24} step=".05" value={time} disabled={!hasDaylight} onChange={e => { setTime(Number(e.target.value)); setPlaying(false); }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, letterSpacing: '.06em', textTransform: 'uppercase', color: '#75798c', marginTop: 8 }}>
                <span>{sun.polarDay ? 'midnight sun' : sun.polarNight ? 'no sunrise' : `${formatTime(sun.sunrise)} sunrise`}</span>
                <span>{sun.polarDay ? '24 h daylight' : sun.polarNight ? 'no sunset' : `${formatTime(sun.sunset)} sunset`}</span>
              </div>
              <button disabled={!hasDaylight} onClick={() => setPlaying(p => {
                if (!p && time >= sun.sunset) setTime(sun.sunrise);
                return !p;
              })} className="sf-btn-play" style={{ width: '100%', marginTop: 17, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, cursor: hasDaylight ? 'pointer' : 'not-allowed', fontFamily: 'inherit', fontWeight: 500, fontSize: 14, color: '#9184d9', background: 'transparent', border: '1px solid #9184d9', borderRadius: 8, padding: '9px 12px' }}>
                {playing ? 'Pause sunlight' : 'Play sunlight'}
              </button>
            </div>

            <p style={{ fontSize: 11, lineHeight: 1.6, color: '#75798c', margin: 0 }}>
              Local solar time. An educational model — real shade also depends on trees, terrain, windows and weather.
            </p>
          </aside>

          {/* House 3D */}
          <div className="sf-house-panel" style={{ position: 'relative', minHeight: 660, borderRadius: 14, overflow: 'hidden', background: 'linear-gradient(160deg,#1d2032,#141625 72%)', boxShadow: '0 0 0 1px #3f424d' }}>
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
      <section className="sf-stats" style={{ background: 'linear-gradient(120deg,#262a60,#353b80)', padding: 45 }}>
        <div className="sf-stats-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 22 }}>
          {[
            { label: 'Sunrise', value: sun.polarNight ? '—' : sun.polarDay ? '00:00' : formatTime(sun.sunrise) },
            { label: 'Solar noon', value: '12:00' },
            { label: 'Sunset', value: sun.polarNight ? '—' : sun.polarDay ? '24:00' : formatTime(sun.sunset) },
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
      <footer className="sf-footer">
        <span>sunface / 2026</span>
        <span>light is a place you can visit</span>
      </footer>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
