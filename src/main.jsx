import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import './styles.css';

const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const monthDays = [31,28,31,30,31,30,31,31,30,31,30,31];

function dayOfYear(month, day) { return monthDays.slice(0, month - 1).reduce((a, b) => a + b, 0) + day; }

function sunAt(latitude, longitude, month, day, solarTime) {
  const n = dayOfYear(month, day);
  const radians = Math.PI / 180;
  const declination = 23.44 * Math.sin(radians * (360 / 365 * (n - 81)));
  const lat = latitude * radians;
  const dec = declination * radians;
  const hourAngle = (solarTime - 12) * 15 * radians;
  const sinElevation = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(hourAngle);
  const elevation = Math.asin(THREE.MathUtils.clamp(sinElevation, -1, 1)) / radians;
  const azimuth = (Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat)) / radians + 180 + 360) % 360;
  const rawCosH = -Math.tan(lat) * Math.tan(dec);
  const daylight = rawCosH >= 1 ? 0 : rawCosH <= -1 ? 24 : Math.acos(rawCosH) / radians / 15;
  const sunrise = 12 - daylight;
  return { elevation, azimuth, sunrise, solarNoon: 12, sunset: 12 + daylight, daylight };
}

function formatTime(value) {
  const totalMinutes = Math.round(value * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

const landMasses = [
  { name: 'North America', points: [[72,-165],[70,-140],[60,-130],[52,-125],[48,-123],[35,-117],[25,-105],[18,-92],[28,-82],[45,-82],[52,-60],[62,-65],[70,-85]] },
  { name: 'South America', points: [[12,-81],[5,-78],[-5,-80],[-18,-72],[-35,-70],[-55,-68],[-52,-58],[-35,-52],[-12,-45],[5,-50],[12,-62]] },
  { name: 'Europe', points: [[72,-10],[70,25],[62,40],[52,32],[48,20],[42,28],[36,18],[38,5],[44,-8],[55,-5],[62,-20]] },
  { name: 'Africa', points: [[36,-17],[36,10],[32,32],[22,42],[5,50],[-15,45],[-35,28],[-35,12],[-25,-5],[-5,-15],[16,-17]] },
  { name: 'Asia', points: [[72,35],[70,90],[62,145],[52,160],[42,142],[28,135],[10,120],[8,95],[20,75],[32,55],[45,38],[58,30]] },
  { name: 'Australia', points: [[-12,114],[-16,145],[-28,153],[-40,145],[-42,120],[-30,112]] },
  { name: 'Greenland', points: [[82,-72],[76,-42],[62,-45],[60,-65],[70,-75]] }
];

function pointOnGlobe(latitude, longitude, radius) {
  const lat = THREE.MathUtils.degToRad(latitude);
  const lon = THREE.MathUtils.degToRad(longitude);
  return new THREE.Vector3(Math.cos(lat) * Math.cos(lon) * radius, Math.sin(lat) * radius, Math.cos(lat) * Math.sin(lon) * radius);
}

function createLandPatch(points) {
  const center = points.reduce((sum, [lat, lon]) => ({ lat: sum.lat + lat, lon: sum.lon + lon }), { lat: 0, lon: 0 });
  center.lat /= points.length; center.lon /= points.length;
  const centerLat = THREE.MathUtils.degToRad(center.lat);
  const shape = new THREE.Shape();
  points.forEach(([lat, lon], index) => {
    const x = THREE.MathUtils.degToRad(lon - center.lon) * Math.cos(centerLat) * 1.35;
    const y = THREE.MathUtils.degToRad(lat - center.lat) * 1.35;
    if (index === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  });
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.018, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.008, bevelSegments: 1 });
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#a6dc45', roughness: 0.9, metalness: 0.02 }));
  const normal = pointOnGlobe(center.lat, center.lon, 1).normalize();
  mesh.position.copy(pointOnGlobe(center.lat, center.lon, 1.355));
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
  mesh.castShadow = true;
  return mesh;
}

function Globe({ onSelect }) {
  const mount = useRef(null);
  const sceneRef = useRef({});
  const [dragging, setDragging] = useState(false);
  const pointer = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const el = mount.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0b1018');
    const camera = new THREE.PerspectiveCamera(32, el.clientWidth / el.clientHeight, 0.1, 100);
    camera.position.set(0, 0.2, 4.1);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);
    const group = new THREE.Group();
    const globe = new THREE.Mesh(new THREE.SphereGeometry(1.35, 48, 32), new THREE.MeshStandardMaterial({ color: '#078bd0', roughness: 0.7, metalness: 0.02 }));
    group.add(globe);
    landMasses.forEach(({ points }) => group.add(createLandPatch(points)));
    const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(1.42, 48, 32), new THREE.MeshBasicMaterial({ color: '#62b7c5', transparent: true, opacity: 0.09, side: THREE.BackSide }));
    group.add(atmosphere);
    const latMat = new THREE.LineBasicMaterial({ color: '#90d6d0', transparent: true, opacity: 0.16 });
    for (let lat = -60; lat <= 60; lat += 30) {
      const r = Math.cos(THREE.MathUtils.degToRad(lat)) * 1.355;
      const y = Math.sin(THREE.MathUtils.degToRad(lat)) * 1.355;
      const points = Array.from({ length: 65 }, (_, i) => new THREE.Vector3(Math.cos(i / 64 * Math.PI * 2) * r, y, Math.sin(i / 64 * Math.PI * 2) * r));
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), latMat));
    }
    for (let lon = 0; lon < 180; lon += 30) {
      const points = Array.from({ length: 65 }, (_, i) => { const a = i / 64 * Math.PI * 2; return new THREE.Vector3(Math.sin(a) * 1.355 * Math.cos(THREE.MathUtils.degToRad(lon)), Math.cos(a) * 1.355, Math.sin(a) * 1.355 * Math.sin(THREE.MathUtils.degToRad(lon))); });
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), latMat));
    }
    scene.add(group);
    scene.add(new THREE.AmbientLight('#9eced0', 1.5));
    const key = new THREE.DirectionalLight('#fff1c5', 2.2); key.position.set(-3, 2, 4); scene.add(key);
    sceneRef.current = { scene, camera, renderer, group, globe };
    const resize = () => { camera.aspect = el.clientWidth / el.clientHeight; camera.updateProjectionMatrix(); renderer.setSize(el.clientWidth, el.clientHeight); };
    window.addEventListener('resize', resize);
    let frame; const animate = () => { frame = requestAnimationFrame(animate); renderer.render(scene, camera); }; animate();
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', resize); renderer.dispose(); el.removeChild(renderer.domElement); };
  }, []);

  const onPointerDown = (event) => { setDragging(false); pointer.current = { x: event.clientX, y: event.clientY }; mount.current.setPointerCapture(event.pointerId); };
  const onPointerMove = (event) => { if (!mount.current.hasPointerCapture(event.pointerId)) return; const dx = event.clientX - pointer.current.x; const dy = event.clientY - pointer.current.y; if (Math.abs(dx) + Math.abs(dy) > 3) setDragging(true); sceneRef.current.group.rotation.y += dx * 0.006; sceneRef.current.group.rotation.x = THREE.MathUtils.clamp(sceneRef.current.group.rotation.x + dy * 0.004, -0.8, 0.8); pointer.current = { x: event.clientX, y: event.clientY }; };
  const onPointerUp = (event) => { if (!dragging) { const rect = mount.current.getBoundingClientRect(); const x = (event.clientX - rect.left) / rect.width * 2 - 1; const y = -((event.clientY - rect.top) / rect.height * 2 - 1); const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(x, y), sceneRef.current.camera); if (ray.intersectObject(sceneRef.current.globe).length) { const hit = ray.intersectObject(sceneRef.current.globe)[0].point.clone(); const local = sceneRef.current.group.worldToLocal(hit); const latitude = THREE.MathUtils.radToDeg(Math.asin(local.y / 1.35)); const longitude = THREE.MathUtils.radToDeg(Math.atan2(local.z, local.x)); onSelect({ latitude, longitude }); } } mount.current.releasePointerCapture(event.pointerId); };
  return <div className="globe-canvas" ref={mount} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />;
}

function HouseScene({ state, sun, onBack }) {
  const mount = useRef(null);
  useEffect(() => {
    const el = mount.current, scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(34, el.clientWidth / el.clientHeight, .1, 100), renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    camera.position.set(5.6, 4.2, 6.6); camera.lookAt(0, .7, 0); renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(el.clientWidth, el.clientHeight); renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.outputColorSpace = THREE.SRGBColorSpace; el.appendChild(renderer.domElement);
    const ambient = new THREE.HemisphereLight('#9cc8d0', '#1c2430', .8); scene.add(ambient);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(24, 24), new THREE.MeshStandardMaterial({ color: '#273640', roughness: 1 })); ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
    const house = new THREE.Group(); house.rotation.y = THREE.MathUtils.degToRad(directions.indexOf(state.orientation) * 45); scene.add(house);
    const wall = new THREE.Mesh(new THREE.BoxGeometry(2.8, 1.7, 2.3), new THREE.MeshStandardMaterial({ color: '#e9d5b7', roughness: .85 })); wall.position.y = .95; wall.castShadow = true; wall.receiveShadow = true; house.add(wall);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(2.05, 1.25, 4), new THREE.MeshStandardMaterial({ color: '#b9654e', roughness: .85 })); roof.rotation.y = Math.PI / 4; roof.position.y = 2.42; roof.castShadow = true; house.add(roof);
    const door = new THREE.Mesh(new THREE.BoxGeometry(.5, .9, .04), new THREE.MeshStandardMaterial({ color: '#5a4034' })); door.position.set(0, .58, 1.17); house.add(door);
    for (const x of [-.85, .85]) { const window = new THREE.Mesh(new THREE.BoxGeometry(.52, .45, .04), new THREE.MeshStandardMaterial({ color: '#85c5cc', emissive: '#1f525e', emissiveIntensity: .3 })); window.position.set(x, 1.2, 1.17); house.add(window); }
    const compass = new THREE.Mesh(new THREE.RingGeometry(3.5, 3.56, 32), new THREE.MeshBasicMaterial({ color: '#9be4d8', transparent: true, opacity: .48, side: THREE.DoubleSide })); compass.rotation.x = -Math.PI / 2; compass.position.y = .012; scene.add(compass);
    const sunDistance = 5.5, elev = THREE.MathUtils.degToRad(Math.max(sun.elevation, 5)), azi = THREE.MathUtils.degToRad(sun.azimuth); const light = new THREE.DirectionalLight('#fff0bf', sun.elevation > 0 ? 3 : .05); light.position.set(Math.sin(azi) * Math.cos(elev) * sunDistance, Math.sin(elev) * sunDistance, Math.cos(azi) * Math.cos(elev) * sunDistance); light.castShadow = true; light.shadow.mapSize.set(2048, 2048); light.shadow.camera.left = -5; light.shadow.camera.right = 5; light.shadow.camera.top = 5; light.shadow.camera.bottom = -5; scene.add(light);
    const sunMesh = new THREE.Mesh(new THREE.SphereGeometry(.16, 16, 16), new THREE.MeshBasicMaterial({ color: '#ffd27a' })); sunMesh.position.copy(light.position); scene.add(sunMesh);
    const resize = () => { camera.aspect = el.clientWidth / el.clientHeight; camera.updateProjectionMatrix(); renderer.setSize(el.clientWidth, el.clientHeight); }; window.addEventListener('resize', resize); let frame; const animate = () => { frame = requestAnimationFrame(animate); renderer.render(scene, camera); }; animate(); return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', resize); renderer.dispose(); el.removeChild(renderer.domElement); };
  }, [state.orientation, sun]);
  return <div className="scene-wrap"><div ref={mount} className="house-canvas" /><button className="back-button" onClick={onBack}>← change location</button><div className="scene-label"><span className="live-dot" /> live sunlight preview</div></div>;
}

function App() {
  const [location, setLocation] = useState(null); const [month, setMonth] = useState(1); const [day, setDay] = useState(15); const [orientation, setOrientation] = useState('S'); const [time, setTime] = useState(12); const [playing, setPlaying] = useState(false);
  const latitude = location?.latitude ?? 51.5; const longitude = location?.longitude ?? -0.1;
  const sun = useMemo(() => sunAt(latitude, longitude, month, day, time), [latitude, longitude, month, day, time]);
  useEffect(() => { if (!playing) return; const id = setInterval(() => setTime((t) => { const next = t + .05; if (next >= sun.sunset) { setPlaying(false); return sun.sunset; } return next; }), 50); return () => clearInterval(id); }, [playing, sun.sunset]);
  const chooseDate = (value) => { const nextMonth = Number(value); setMonth(nextMonth); setDay(Math.min(day, monthDays[nextMonth - 1])); setTime(12); };
  return <main><header><div className="brand"><span className="brand-mark">◒</span><span>SUNFACE</span></div><span className="eyebrow">a small instrument for understanding light</span></header>{!location ? <section className="landing"><div className="intro"><p className="kicker">01 / choose a place</p><h1>Where does<br /><em>the light</em> land?</h1><p className="lead">Pick a point on Earth. Then turn a house, turn the year, and watch the sun move through it.</p><div className="hint"><span>↗</span> drag to rotate · click to select</div></div><div className="globe-panel"><Globe onSelect={setLocation} /><div className="globe-caption"><span>earth / 3D</span><span>latitude + longitude</span></div></div></section> : <section className="simulator"><div className="sim-header"><div><p className="kicker">02 / study the light</p><h2>{location.latitude.toFixed(2)}° {location.latitude >= 0 ? 'N' : 'S'} <span>·</span> {Math.abs(location.longitude).toFixed(2)}° {location.longitude >= 0 ? 'E' : 'W'}</h2></div><div className="date-chip">{months[month - 1]} {day}</div></div><HouseScene state={{ orientation }} sun={sun} onBack={() => setLocation(null)} /><aside className="controls"><div className="control-block"><label>day of the year</label><div className="date-row"><select value={month} onChange={e => chooseDate(e.target.value)}>{months.map((m, i) => <option value={i + 1} key={m}>{m}</option>)}</select><input type="number" min="1" max={monthDays[month - 1]} value={day} onChange={e => { setDay(Math.max(1, Math.min(monthDays[month - 1], Number(e.target.value)))); setTime(12); }} /></div></div><div className="control-block"><label>house facing</label><div className="direction-grid">{directions.map(d => <button className={orientation === d ? 'selected' : ''} onClick={() => setOrientation(d)} key={d}>{d}</button>)}</div></div><div className="control-block time-block"><div className="time-heading"><label>solar time</label><strong>{formatTime(time)}</strong></div><input className="range" type="range" min={Math.max(0, sun.sunrise)} max={Math.min(24, sun.sunset)} step=".05" value={time} onChange={e => { setTime(Number(e.target.value)); setPlaying(false); }} /><div className="range-labels"><span>{formatTime(sun.sunrise)} sunrise</span><span>{formatTime(sun.sunset)} sunset</span></div><button className="play" onClick={() => setPlaying(!playing)}>{playing ? 'Ⅱ  pause sunlight' : '▶  play sunlight'}</button></div><div className="metrics"><div><span>sun altitude</span><strong>{Math.max(0, sun.elevation).toFixed(1)}°</strong></div><div><span>sun direction</span><strong>{Math.round(sun.azimuth)}°</strong></div><div><span>daylight</span><strong>{sun.daylight.toFixed(1)} hrs</strong></div></div><p className="note">Times shown are local solar time. This is an educational model — real shade also depends on trees, terrain, windows and weather.</p></aside></section>}<footer><span>sunface / 2026</span><span>light is a place you can visit</span></footer></main>;
}

function AppDesigned() {
  const [location, setLocation] = useState(null);
  const [month, setMonth] = useState(1);
  const [day, setDay] = useState(15);
  const [orientation, setOrientation] = useState('S');
  const [time, setTime] = useState(12);
  const [playing, setPlaying] = useState(false);
  const latitude = location?.latitude ?? 51.5;
  const longitude = location?.longitude ?? -0.1;
  const sun = useMemo(() => sunAt(latitude, longitude, month, day, time), [latitude, longitude, month, day, time]);
  useEffect(() => {
    if (!playing) return undefined;
    const id = setInterval(() => setTime((current) => {
      const next = current + 0.05;
      if (next >= sun.sunset) { setPlaying(false); return sun.sunset; }
      return next;
    }), 50);
    return () => clearInterval(id);
  }, [playing, sun.sunset]);
  const chooseDate = (value) => {
    const nextMonth = Number(value);
    setMonth(nextMonth);
    setDay(Math.min(day, monthDays[nextMonth - 1]));
    setTime(12);
  };
  const resetLocation = () => { setLocation(null); setPlaying(false); };
  const coordLabel = location ? `${location.latitude.toFixed(2)}° ${location.latitude >= 0 ? 'N' : 'S'} · ${Math.abs(location.longitude).toFixed(2)}° ${location.longitude >= 0 ? 'E' : 'W'}` : 'no location picked';
  const facingCells = ['NW', 'N', 'NE', 'W', 'facing', 'E', 'SW', 'S', 'SE'];

  return <main id="top">
    <header>
      <div className="brand"><span className="brand-mark">◒</span><span>SUNFACE</span></div>
      <div className="header-actions"><span className="nav-status">{coordLabel}</span><button className="header-cta" onClick={() => location ? resetLocation() : document.getElementById('location-picker')?.scrollIntoView({ behavior: 'smooth' })}>{location ? 'Change the place' : 'Study the light'}</button></div>
    </header>
    {!location ? <section className="landing" id="location-picker">
      <div className="intro"><p className="kicker">01 / choose a place</p><h1>Where does <span className="accent-word">the light</span> land?</h1><p className="lead">Pick a point on Earth. Then turn a house, turn the year, and watch the sun move through it.</p><div className="hint"><span className="hint-line" /> drag to rotate · click to select</div></div>
      <div className="globe-panel"><Globe onSelect={setLocation} /><div className="globe-caption"><span>earth / 3D</span><span>latitude + longitude</span></div></div>
    </section> : <section className="simulator" id="study">
      <div className="sim-header"><div><p className="kicker">02 / study the light</p><h2>{coordLabel}</h2></div><div className="date-chip">{months[month - 1]} {day}</div></div>
      <aside className="controls">
        <div className="control-block"><label>day of the year</label><div className="date-row"><select value={month} onChange={e => chooseDate(e.target.value)}>{months.map((m, i) => <option value={i + 1} key={m}>{m}</option>)}</select><input type="number" min="1" max={monthDays[month - 1]} value={day} onChange={e => { setDay(Math.max(1, Math.min(monthDays[month - 1], Number(e.target.value)))); setTime(12); }} /></div></div>
        <div className="control-block"><label>house facing</label><div className="direction-grid designed-direction-grid">{facingCells.map((cell, index) => cell === 'facing' ? <div className="facing-readout" key={cell}><span>facing</span><strong>{orientation}</strong></div> : <button className={orientation === cell ? 'selected' : ''} onClick={() => setOrientation(cell)} key={`${cell}-${index}`}>{cell}</button>)}</div></div>
        <div className="control-block time-block"><div className="time-heading"><label>solar time</label><strong>{formatTime(time)}</strong></div><input className="range" type="range" min={Math.max(0, sun.sunrise)} max={Math.min(24, sun.sunset)} step=".05" value={time} onChange={e => { setTime(Number(e.target.value)); setPlaying(false); }} /><div className="range-labels"><span>{formatTime(sun.sunrise)} sunrise</span><span>{formatTime(sun.sunset)} sunset</span></div><button className="play" onClick={() => setPlaying(!playing)}>{playing ? 'Ⅱ  pause sunlight' : '▶  play sunlight'}</button></div>
        <div className="metrics"><div><span>sun altitude</span><strong>{Math.max(0, sun.elevation).toFixed(1)}°</strong></div><div><span>sun direction</span><strong>{Math.round(sun.azimuth)}°</strong></div><div><span>daylight</span><strong>{sun.daylight.toFixed(1)} hrs</strong></div></div>
        <p className="note">Local solar time. An educational model — real shade also depends on trees, terrain, windows and weather.</p>
      </aside>
      <HouseScene state={{ orientation }} sun={sun} onBack={resetLocation} />
    </section>}
    <footer><span>sunface / 2026</span><span>light is a place you can visit</span></footer>
  </main>;
}

createRoot(document.getElementById('root')).render(<AppDesigned />);
