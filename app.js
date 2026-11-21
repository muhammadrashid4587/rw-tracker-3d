// RW Tracker — procedural Three.js study.
// Units: 1 unit = 1 mm. Pod 58 x 42 mm per the approved design-study sketch.
// Dimensions are design parameters, NOT measured facts about the physical unit.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

const ACCENT = 0xE4572E;
const params = new URLSearchParams(location.search);
const RECORD = params.get('record') === '1';
const FRAMES = Math.max(1, parseInt(params.get('frames') || '120', 10));
const FRAME = Math.max(0, parseInt(params.get('frame') || '0', 10));
const REDUCED = !RECORD && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const canvas = document.getElementById('scene');
const stage = document.getElementById('stage');
const labelsEl = document.getElementById('labels');
const explodeInput = document.getElementById('explode');
const explodeVal = document.getElementById('explodeVal');

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
} catch (e) {
  document.getElementById('fallback').style.display = 'grid';
  throw e;
}
renderer.setPixelRatio(RECORD ? 1 : Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x131311);
scene.fog = new THREE.Fog(0x131311, 300, 620);

// ---- procedural studio environment map (PMREM) ----
// A tiny studio: warm softbox upper-left, cool strip right, rim strip behind,
// faint accent strip low-front, dark floor below. No external HDR, no AI images.
// This is what makes the PBR materials read as photographed, not rendered.
function buildEnvironment() {
  const env = new THREE.Scene();
  const panel = (color, intensity, w, h, pos) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }));
    m.position.set(pos[0], pos[1], pos[2]);
    m.lookAt(0, 0, 0);
    env.add(m);
  };
  panel(0xfff1dd, 22, 130, 95, [-85, 115, 65]);   // warm key softbox
  panel(0xcfe0f2, 12, 75, 120, [115, 45, 45]);    // cool strip, right
  panel(0xffffff, 9, 170, 45, [0, 35, -130]);     // rim strip, behind
  panel(0xE4572E, 5, 45, 9, [0, -25, 95]);        // faint accent strip, low front
  const fl = new THREE.Mesh(new THREE.PlaneGeometry(500, 500),
    new THREE.MeshBasicMaterial({ color: 0x0a0a09 }));
  fl.rotation.x = -Math.PI / 2; fl.position.y = -85; env.add(fl);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(env, 0.04);
  pmrem.dispose();
  return rt.texture;
}
scene.environment = buildEnvironment();
scene.environmentIntensity = 0.6;

const camera = new THREE.PerspectiveCamera(30, 2, 1, 2000);
camera.position.set(95, 55, 140);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, -26, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.minDistance = 70;
controls.maxDistance = 320;
controls.minPolarAngle = 0.35;
controls.maxPolarAngle = 1.85;
controls.autoRotate = !RECORD && !REDUCED;
controls.autoRotateSpeed = 0.7;

// ---- lights: warm studio key, cool fill, strong rim for separation ----
// The env map carries the ambient; these lights shape the product.
scene.add(new THREE.HemisphereLight(0xdfe6ea, 0x1a1a18, 0.35));
const key = new THREE.DirectionalLight(0xffe9c9, 3.0);
key.position.set(-90, 130, 80);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -120; key.shadow.camera.right = 120;
key.shadow.camera.top = 120; key.shadow.camera.bottom = -120;
key.shadow.camera.far = 500; key.shadow.bias = -0.0004;
scene.add(key);
const fill = new THREE.DirectionalLight(0xbfd0e0, 1.2); // cool fill, right
fill.position.set(110, 30, 60);
scene.add(fill);
const rim = new THREE.DirectionalLight(0xffffff, 2.2); // strong rim, back
rim.position.set(20, 60, -130);
scene.add(rim);
// warm pool light low-front, lifts the sensor ring side
const poolLight = new THREE.PointLight(0xffd9b0, 0.5, 320, 1.6);
poolLight.position.set(-20, -30, 110);
scene.add(poolLight);

// ---- procedural canvas textures (no AI images, no external assets) ----
function noiseTexture(size = 128, lo = 118, hi = 168) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  // deterministic pseudo-random (seeded) so record frames are identical
  let s = 1234567;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < img.data.length; i += 4) {
    const v = lo + rnd() * (hi - lo);
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 3);
  return t;
}
// Live sensor waveform — redrawn per frame in the loop so it scrolls.
// phase 0..1 shifts every sine by a whole number of periods, so phase 1 == phase 0.
const screenCanvas = document.createElement('canvas');
screenCanvas.width = 512; screenCanvas.height = 340;
const screenCtx = screenCanvas.getContext('2d');
function drawScreen(phase = 0) {
  const g = screenCtx;
  g.fillStyle = '#0A100D'; g.fillRect(0, 0, 512, 340);
  g.strokeStyle = 'rgba(255,255,255,0.07)'; g.lineWidth = 1;
  for (let x = 0; x <= 512; x += 32) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 340); g.stroke(); }
  for (let y = 0; y <= 340; y += 34) { g.beginPath(); g.moveTo(0, y); g.lineTo(512, y); g.stroke(); }
  g.strokeStyle = '#E4572E'; g.lineWidth = 3; g.lineJoin = 'round';
  g.beginPath();
  for (let x = 0; x <= 512; x += 2) {
    const t = x / 512;
    const y = 190 - 62 * Math.sin((t + phase) * Math.PI * 6)
      - 34 * Math.sin((t + phase) * Math.PI * 13 + 1.3)
      - 12 * Math.sin((t + phase) * Math.PI * 29);
    x === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
  }
  g.stroke();
  g.fillStyle = '#EDEAE2'; g.font = '600 26px ui-monospace, Menlo, monospace';
  g.fillText('RW TRACKER', 22, 44);
  g.fillStyle = '#E4572E'; g.font = '600 22px ui-monospace, Menlo, monospace';
  g.fillText('~200 Hz', 22, 306);
  g.fillStyle = '#9A978C'; g.font = '20px ui-monospace, Menlo, monospace';
  g.fillText('<50 ms', 150, 306);
  g.fillText('BLE ●', 420, 306);
}
function screenTexture() {
  drawScreen(0);
  const t = new THREE.CanvasTexture(screenCanvas);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
function strapTexture() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#232320'; g.fillRect(0, 0, 256, 256);
  // subtle mottling
  let s = 987654; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(255,255,255,${0.015 + rnd() * 0.03})`;
    g.fillRect(rnd() * 256, rnd() * 256, 2, 2);
  }
  // stitching dashes running along the strap (u direction), near both edges
  g.strokeStyle = 'rgba(237,234,226,0.55)'; g.lineWidth = 2; g.setLineDash([10, 8]);
  for (const x of [18, 238]) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 256); g.stroke(); }
  g.setLineDash([]);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

const roughNoise = noiseTexture();
// Product-film materials: clearcoat shell, true metal hardware, matte strap.
// The env map does the work — clearcoat + metal read the studio panels.
const shellMat = new THREE.MeshPhysicalMaterial({ color: 0x35342F, roughness: 0.38, metalness: 0.22, clearcoat: 0.6, clearcoatRoughness: 0.28, roughnessMap: roughNoise, bumpMap: roughNoise, bumpScale: 0.15, envMapIntensity: 0.9 });
const darkMat = new THREE.MeshPhysicalMaterial({ color: 0x171715, roughness: 0.5, metalness: 0.3, clearcoat: 0.3, clearcoatRoughness: 0.4, roughnessMap: roughNoise, envMapIntensity: 0.8 });
const seamMat = new THREE.MeshStandardMaterial({ color: 0x080807, roughness: 0.8, metalness: 0.05 });
const bezelMat = new THREE.MeshPhysicalMaterial({ color: 0x0E0E0E, roughness: 0.28, metalness: 0.5, clearcoat: 0.8, clearcoatRoughness: 0.2, envMapIntensity: 1.0 });
const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x0B0F0E, roughness: 0.08, metalness: 0.1, clearcoat: 1.0, clearcoatRoughness: 0.08, envMapIntensity: 1.1 });
const accentMat = new THREE.MeshStandardMaterial({ color: 0xE4572E, roughness: 0.4, metalness: 0.1, emissive: ACCENT, emissiveIntensity: 0.55, envMapIntensity: 0.6 });
const ledMat = new THREE.MeshStandardMaterial({ color: 0xE4572E, roughness: 0.3, metalness: 0.1, emissive: ACCENT, emissiveIntensity: 1.6, envMapIntensity: 0.6 });
const metalMat = new THREE.MeshPhysicalMaterial({ color: 0x9A9A94, roughness: 0.26, metalness: 1.0, clearcoat: 0.25, clearcoatRoughness: 0.3, envMapIntensity: 1.25 });
const buckleMat = new THREE.MeshPhysicalMaterial({ color: 0x3C3C38, roughness: 0.34, metalness: 0.85, clearcoat: 0.4, clearcoatRoughness: 0.3, envMapIntensity: 1.0 });
const screenMat = new THREE.MeshBasicMaterial({ map: screenTexture() });
const strapTex = strapTexture();
const strapMat = new THREE.MeshStandardMaterial({ map: strapTex, color: 0xffffff, roughness: 0.88, metalness: 0.0, side: THREE.DoubleSide, envMapIntensity: 0.4 });

function shadowed(m) { m.castShadow = true; m.receiveShadow = true; return m; }

// ---- model ----
const turntable = new THREE.Group();       // rotates (turntable / record mode)
const model = new THREE.Group();           // the device, exported as-is
turntable.add(model);
scene.add(turntable);

// glossy studio floor: catches a faint reflection of the env panels and a warm
// pool of light under the device (Apple-style product-film floor)
function poolTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(256, 256, 10, 256, 256, 250);
  grad.addColorStop(0, 'rgba(255,225,190,0.55)');
  grad.addColorStop(0.35, 'rgba(255,210,170,0.18)');
  grad.addColorStop(1, 'rgba(255,210,170,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 512, 512);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const floor = new THREE.Mesh(
  new THREE.CircleGeometry(320, 64),
  new THREE.MeshStandardMaterial({ color: 0x111110, roughness: 0.32, metalness: 0.6, envMapIntensity: 0.7 })
);
floor.rotation.x = -Math.PI / 2; floor.position.y = -70; floor.receiveShadow = true;
scene.add(floor);
const pool = new THREE.Mesh(
  new THREE.PlaneGeometry(300, 300),
  new THREE.MeshBasicMaterial({ map: poolTexture(), transparent: true, opacity: 0.55, depthWrite: false })
);
pool.rotation.x = -Math.PI / 2; pool.position.y = -69.8;
scene.add(pool);

const parts = []; // {group, dir, dist, anchor, label, sub, meshes[]}
function registerPart(group, dir, dist, anchor, label, sub) {
  group.userData.basePos = group.position.clone();
  group.userData.explodeDir = dir.clone();
  group.userData.explodeDist = dist;
  const p = { group, dir, dist, anchor, label, sub, meshes: [] };
  // clone materials per part so hover emissive lift affects only that part
  group.traverse(o => { if (o.isMesh) { o.material = o.material.clone(); o.userData.part = p; p.meshes.push(o); } });
  parts.push(p);
  return p;
}

// 1 — Shell: rounded pod 58 x 12 x 42, generous fillet
const shell = new THREE.Group();
const shellMesh = shadowed(new THREE.Mesh(new RoundedBoxGeometry(58, 12, 42, 5, 4.5), shellMat));
shell.add(shellMesh);
model.add(shell);
registerPart(shell, new THREE.Vector3(0, 1, 0), 0, new THREE.Vector3(0, 6, 0), 'Shell', 'matte pod · 58 × 42 mm');
// panel-gap seam between shell halves
const seam = shadowed(new THREE.Mesh(new RoundedBoxGeometry(58.5, 1.1, 42.5, 2, 0.5), seamMat));
seam.position.y = -0.5;
shell.add(seam);

// 2 — Screen: recessed face on top (+Y), live waveform canvas texture
const screen = new THREE.Group();
// bezel as a real frame (4 bars) so the recessed screen face stays visible
function bezelBar(w, d, x, z) {
  const m = shadowed(new THREE.Mesh(new RoundedBoxGeometry(w, 1.6, d, 2, 0.7), bezelMat));
  m.position.set(x, 6.0, z); screen.add(m);
}
bezelBar(50, 3, 0, 15.5); bezelBar(50, 3, 0, -15.5);
bezelBar(3, 28, 23.5, 0); bezelBar(3, 28, -23.5, 0);
const face = new THREE.Mesh(new THREE.PlaneGeometry(46, 30), screenMat);
face.rotation.x = -Math.PI / 2; face.position.y = 6.45; screen.add(face);
// status LED — the only other accent point
const led = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 0.8, 24), ledMat);
led.position.set(24.5, 6.2, 14.5); screen.add(led);
model.add(screen);
registerPart(screen, new THREE.Vector3(0, 1, 0), 22, new THREE.Vector3(0, 7, 0), 'Screen', 'live waveform · ~200 Hz');
// LED pulse target (frozen in record mode)
const ledPulse = led.material;

// 3 — Optical sensor window, underside (-Y), accent ring
const sensor = new THREE.Group();
const ring = shadowed(new THREE.Mesh(new THREE.TorusGeometry(9, 1.3, 20, 48), accentMat));
ring.rotation.x = Math.PI / 2; ring.position.y = -6.4; sensor.add(ring);
const glass = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(8, 8, 1.2, 48), glassMat));
glass.position.y = -6.3; sensor.add(glass);
for (const dx of [-3.4, 3.4]) {
  const dot = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.6, 16),
    new THREE.MeshStandardMaterial({ color: 0x2a2f2c, roughness: 0.2, metalness: 0.3 }));
  dot.position.set(dx, -6.9, 0); sensor.add(dot);
}
model.add(sensor);
registerPart(sensor, new THREE.Vector3(0, -1, 0), 20, new THREE.Vector3(-20, -7, 0), 'Sensor window', 'optical window · accent ring');

// 4 — Side button (+X face)
const button = new THREE.Group();
const btn = shadowed(new THREE.Mesh(new RoundedBoxGeometry(3.2, 4.2, 12, 2, 1.2), darkMat));
btn.position.set(29.6, 1, 0); button.add(btn);
const btnCap = new THREE.Mesh(new RoundedBoxGeometry(0.8, 3.2, 10, 2, 0.4), bezelMat);
btnCap.position.set(31.3, 1, 0); button.add(btnCap);
model.add(button);
registerPart(button, new THREE.Vector3(1, 0, 0), 18, new THREE.Vector3(31, 1, 0), 'Side button', 'crown / action button');

// 5 — Back plate + 4 torx-style screws
const back = new THREE.Group();
const plate = shadowed(new THREE.Mesh(new RoundedBoxGeometry(52, 1.6, 36, 2, 0.8), darkMat));
plate.position.y = -6.6; back.add(plate);
for (const [sx, sz] of [[-20, -13], [20, -13], [-20, 13], [20, 13]]) {
  const screw = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(2.3, 2.3, 0.9, 24), metalMat));
  screw.position.set(sx, -7.6, sz); back.add(screw);
  // torx-style recess: six-point star approximated by a dark hex socket
  const socket = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.15, 0.4, 6), seamMat);
  socket.position.set(sx, -8.05, sz); back.add(socket);
}
model.add(back);
registerPart(back, new THREE.Vector3(0, -1, 0), 34, new THREE.Vector3(0, -8, 0), 'Back plate + screws', '4 × torx-style screws');

// 6/7 — Silicone straps: parametric ribbons curving down from each pod end
function strapRibbon(side) { // side: +1 = +Z end, -1 = -Z end
  const pts = [
    new THREE.Vector3(0, 0.5, side * 19),
    new THREE.Vector3(0, -2, side * 36),
    new THREE.Vector3(0, -13, side * 50),
    new THREE.Vector3(0, -31, side * 57),
    new THREE.Vector3(0, -50, side * 53),
    new THREE.Vector3(0, -62, side * 43),
  ];
  const curve = new THREE.CatmullRomCurve3(pts);
  const N = 44, thick = 1.35;
  const pos = [], nor = [], uv = [], idx = [];
  const centres = [], tangents = [], normals = [];
  for (let i = 0; i <= N; i++) {
    const s = i / N;
    const c = curve.getPoint(s);
    const t = curve.getTangent(s).normalize();
    // outward normal in the YZ plane (perp to tangent, pointing away from wrist centre)
    const n = new THREE.Vector3(0, -t.z, t.y).normalize();
    if (n.y > 0 && s > 0.2) n.negate(); // keep pointing outward/down, away from pod
    centres.push(c); tangents.push(t); normals.push(n);
  }
  const widthAt = s => 13 - 4.5 * s; // half-width 13 -> 8.5 mm taper
  // four strips: top, bottom, left, right — each with its own vertices/normals
  function strip(getVert, getNor, v0, v1) {
    const base = pos.length / 3;
    for (let i = 0; i <= N; i++) {
      const s = i / N, w = widthAt(s);
      const [a, b] = getVert(centres[i], normals[i], w);
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      const n = getNor(normals[i]);
      nor.push(n.x, n.y, n.z, n.x, n.y, n.z);
      uv.push(s * 5, v0, s * 5, v1);
    }
    for (let i = 0; i < N; i++) {
      const a = base + i * 2, b = a + 1, c2 = a + 2, d = a + 3;
      idx.push(a, b, c2, b, d, c2);
    }
  }
  const W = new THREE.Vector3(1, 0, 0);
  strip((c, n, w) => [c.clone().addScaledVector(n, thick).addScaledVector(W, -w),
                      c.clone().addScaledVector(n, thick).addScaledVector(W, w)],
        n => n, 0, 1);
  strip((c, n, w) => [c.clone().addScaledVector(n, -thick).addScaledVector(W, w),
                      c.clone().addScaledVector(n, -thick).addScaledVector(W, -w)],
        n => n.clone().negate(), 0, 1);
  strip((c, n, w) => [c.clone().addScaledVector(n, thick).addScaledVector(W, -w),
                      c.clone().addScaledVector(n, -thick).addScaledVector(W, -w)],
        () => new THREE.Vector3(-1, 0, 0), 0, 1);
  strip((c, n, w) => [c.clone().addScaledVector(n, -thick).addScaledVector(W, w),
                      c.clone().addScaledVector(n, thick).addScaledVector(W, w)],
        () => new THREE.Vector3(1, 0, 0), 0, 1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  const mesh = shadowed(new THREE.Mesh(geo, strapMat));
  return { mesh, curve, end: centres[N], endNormal: normals[N], endTangent: tangents[N] };
}

const strapTop = new THREE.Group(); // +Z end, carries the buckle holes
{
  const { mesh, curve } = strapRibbon(+1);
  strapTop.add(mesh);
  // buckle holes near the tip
  for (const s of [0.82, 0.87, 0.92, 0.97]) {
    const c = curve.getPoint(s), t = curve.getTangent(s);
    const n = new THREE.Vector3(0, -t.z, t.y).normalize();
    if (n.y > 0) n.negate();
    const hole = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 3.4, 20), seamMat);
    hole.position.copy(c);
    hole.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
    strapTop.add(hole);
  }
  model.add(strapTop);
}
registerPart(strapTop, new THREE.Vector3(0, 0, 1), 26, new THREE.Vector3(0, -30, 56), 'Strap', 'silicone · stitched · tapered');

const strapBottom = new THREE.Group(); // -Z end, carries the buckle
let buckleGroup;
{
  const { mesh, end, endNormal, endTangent } = strapRibbon(-1);
  strapBottom.add(mesh);
  buckleGroup = new THREE.Group();
  const frame = (w, h, d, x, y, z) => {
    const m = shadowed(new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, 0.8), buckleMat));
    m.position.set(x, y, z); buckleGroup.add(m);
  };
  // rectangular buckle frame, 24 wide (X) x 16 long, centred on the strap tip
  frame(24, 2.6, 2.6, 0, 0, 7); frame(24, 2.6, 2.6, 0, 0, -7);
  frame(2.6, 2.6, 16.6, -10.7, 0, 0); frame(2.6, 2.6, 16.6, 10.7, 0, 0);
  const pin = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 20, 16), buckleMat));
  pin.rotation.z = Math.PI / 2; pin.position.set(0, 0, 0); buckleGroup.add(pin);
  buckleGroup.position.copy(end).addScaledVector(endTangent, 1.5); // tip sits inside the frame
  // orient frame: local Z along strap tangent, local Y along strap normal
  const zAxis = endTangent.clone().normalize();
  const yAxis = endNormal.clone().normalize();
  const xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis).normalize();
  buckleGroup.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis));
  strapBottom.add(buckleGroup);
  model.add(strapBottom);
}
registerPart(strapBottom, new THREE.Vector3(0, 0, -1), 26, new THREE.Vector3(0, -52, -52), 'Buckle', 'strap buckle · pin');
// buckle is part of the strap group visually; keep its own label anchor via the same part.

// ---- cinematic loop motion ----
// Every motion is a smooth function of loop phase t in [0,1), so t=1 == t=0
// and the loop wraps invisibly: full orbit, gentle dolly, slight rise,
// scrolling waveform, LED pulse. (Apple-style product film, not a flat spin.)
let loopPhase = 0;
// Phase-0 turntable offset: the loop opens on a diagonal 3/4 view — screen
// text still readable, straps falling to the sides, not straight at the camera.
const PHASE0 = 1.35;
const CAM_BASE = { x: 95, y: 55, z: 140, r: Math.hypot(95, 140) };
function setPhase(t, angleOverride = null) {
  loopPhase = t;
  const w = Math.PI * 2;
  turntable.rotation.y = angleOverride !== null ? angleOverride : PHASE0 + w * t;
  const r = CAM_BASE.r + 10 * Math.sin(w * t);
  const s = r / CAM_BASE.r;
  camera.position.set(
    CAM_BASE.x * s,
    CAM_BASE.y + 6 * Math.sin(w * t + 1.2),
    CAM_BASE.z * s
  );
  camera.lookAt(controls.target);
  drawScreen(t);
  screenMat.map.needsUpdate = true;
  model.updateMatrixWorld(true);
}
const labelDivs = parts.map(p => {
  const d = document.createElement('div');
  d.className = 'label';
  d.innerHTML = `${p.label}<small>${p.sub}</small>`;
  labelsEl.appendChild(d);
  return d;
});

// ---- explode state ----
let explodeT = 0;
function applyExplode(t) {
  explodeT = t;
  for (const p of parts) {
    p.group.position.copy(p.group.userData.basePos)
      .addScaledVector(p.group.userData.explodeDir, p.group.userData.explodeDist * t);
  }
  explodeInput.value = String(Math.round(t * 100));
  explodeVal.textContent = `${Math.round(t * 100)}%`;
}
function setExplodeFromInput() { applyExplode(explodeInput.value / 100); }
explodeInput.addEventListener('input', setExplodeFromInput);
window.__setExplode = v => applyExplode(Math.max(0, Math.min(1, v)));
if (params.get('explode')) applyExplode(Math.max(0, Math.min(100, +params.get('explode'))) / 100);

// ---- hover highlight (raycast) ----
const ray = new THREE.Raycaster();
const pointer = new THREE.Vector2(-2, -2);
let hovered = null;
function setHover(p) {
  if (hovered === p) return;
  if (hovered) for (const m of hovered.meshes) {
    if (m.material.emissive) { m.material.emissive.setHex(m.userData.savedEmissive ?? 0x000000); m.material.emissiveIntensity = m.userData.savedIntensity ?? 0; }
    m.material = m.userData.origMat || m.material;
  }
  hovered = p;
  if (p) for (const m of p.meshes) {
    if (!m.userData.origMat) {
      m.userData.origMat = m.material;
      if (m.material.emissive) { m.userData.savedEmissive = m.material.emissive.getHex(); m.userData.savedIntensity = m.material.emissiveIntensity; }
    }
    if (m.material.emissive) {
      m.material.emissive.setHex(ACCENT);
      // savedIntensity is 1 by default even when emissive is black, so do not
      // derive the lift from it for non-emissive parts
      m.material.emissiveIntensity = m.userData.savedEmissive === 0
        ? 0.18
        : Math.min(1.6, (m.userData.savedIntensity || 0.5) * 1.25);
    }
  }
  labelDivs.forEach((d, i) => d.classList.toggle('hot', parts[i] === p));
}
canvas.addEventListener('pointermove', e => {
  const r = canvas.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
});
canvas.addEventListener('pointerleave', () => { pointer.set(-2, -2); setHover(null); });

// ---- controls: auto-rotate pause/resume, buttons ----
let userPausedSpin = REDUCED;
let idleTimer = null;
function pauseSpinTemp() {
  controls.autoRotate = false;
  clearTimeout(idleTimer);
  if (!userPausedSpin && !RECORD) idleTimer = setTimeout(() => { controls.autoRotate = true; }, 4000);
}
canvas.addEventListener('pointerdown', pauseSpinTemp);
canvas.addEventListener('wheel', pauseSpinTemp, { passive: true });
const spinBtn = document.getElementById('spinBtn');
function syncSpinBtn() { spinBtn.textContent = controls.autoRotate ? 'Pause rotation' : 'Resume rotation'; }
spinBtn.addEventListener('click', () => {
  userPausedSpin = !userPausedSpin;
  controls.autoRotate = !userPausedSpin && !RECORD;
  syncSpinBtn();
});
if (REDUCED) { controls.autoRotate = false; }
syncSpinBtn();
document.getElementById('resetBtn').addEventListener('click', () => {
  camera.position.set(95, 55, 140); controls.target.set(0, -26, 0);
  applyExplode(0); controls.update();
});

// ---- GLB export (unexploded) ----
async function exportGLB() {
  const prev = explodeT; applyExplode(0); model.updateMatrixWorld(true);
  const exporter = new GLTFExporter();
  const buf = await exporter.parseAsync(model, { binary: true });
  applyExplode(prev);
  return buf;
}
window.__exportGLB = async () => {
  const buf = await exportGLB();
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
};
document.getElementById('exportBtn').addEventListener('click', async () => {
  const buf = await exportGLB();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buf], { type: 'model/gltf-binary' }));
  a.download = 'rw-tracker.glb'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

// ---- sizing / render loop ----
function resize() {
  const w = RECORD ? 1280 : stage.clientWidth;
  const h = RECORD ? 720 : stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(() => { if (!RECORD) resize(); }).observe(stage);
resize();

const clock = new THREE.Clock();
const labelV = new THREE.Vector3();
function projectLabels() {
  const w = stage.clientWidth, h = stage.clientHeight;
  const placed = []; // anchor points already used, for de-collision
  parts.forEach((p, i) => {
    const d = labelDivs[i];
    const show = explodeT > 0.12 || hovered === p;
    if (!show) { d.classList.remove('on'); return; }
    labelV.copy(p.anchor).applyMatrix4(p.group.matrixWorld);
    labelV.project(camera);
    if (labelV.z > 1) { d.classList.remove('on'); return; }
    let x = (labelV.x * 0.5 + 0.5) * w;
    let y = (-labelV.y * 0.5 + 0.5) * h;
    // de-collide: nudge a label down while it would overlap one already placed
    for (const q of placed) {
      if (Math.abs(x - q.x) < 150 && Math.abs(y - q.y) < 42) y = q.y + 46;
    }
    placed.push({ x, y });
    d.style.left = `${x}px`;
    d.style.top = `${y}px`;
    d.classList.add('on');
  });
}
function renderFrame(timeSec) {
  // hover raycast
  if (pointer.x > -1.5) {
    ray.setFromCamera(pointer, camera);
    const hit = ray.intersectObjects(model.children, true)[0];
    setHover(hit ? hit.object.userData.part || null : null);
  }
  // LED pulse (frozen in record mode for determinism)
  ledPulse.emissiveIntensity = RECORD
    ? 1.3 + 0.7 * Math.sin(loopPhase * Math.PI * 2)
    : 1.3 + 0.7 * Math.sin(timeSec * 2.2);
  controls.update();
  renderer.render(scene, camera);
  projectLabels();
}

if (RECORD) {
  // record frames are clean full-viewport renders: hide page chrome
  for (const sel of ['header', '#controls', '.specs', 'footer', '#hud']) {
    const el = document.querySelector(sel); if (el) el.style.display = 'none';
  }
  stage.style.minHeight = '720px'; stage.style.height = '720px';
  // deterministic cinematic loop: phase = K/N drives orbit, dolly, waveform, LED
  if (params.get('angle') !== null) setPhase(0, +params.get('angle'));
  else setPhase(FRAME / FRAMES);
  renderFrame(0);
  window.__ready = true;
} else {
  turntable.rotation.y = PHASE0;
  renderer.setAnimationLoop(() => renderFrame(clock.getElapsedTime()));
  window.__ready = true;
}
// deterministic hooks used by headless frame capture (same code path as record mode)
window.__rw = {
  setAngle: a => { turntable.rotation.y = a; model.updateMatrixWorld(true); },
  setPhase: t => { setPhase(t); },
  setExplode: v => applyExplode(Math.max(0, Math.min(1, v))),
  render: () => renderFrame(0),
  ready: () => !!window.__ready,
};
