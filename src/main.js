import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  getState,
  reportOccupantOverride,
  setShadeCmd,
  setSetpointCmd,
  setLightsCmd,
  getCommands,
  applyOccupantOverride,
  endOverride,
  resetScenario,
} from './dataSource.js';

/* -----------------------------------------------------------------
 * Main Three.js simulation for the office environment.  This file
 * builds a low‑poly room with a roller shade, an air‑conditioner/
 * thermostat, and a light switch.  Clicking each device triggers
 * a sequence: the RL agent changes the device state, then the
 * occupant stands, walks to the device, overrides it back and
 * returns to the desk.  The animation system uses a queue of
 * tasks; states guard sequences so that only one runs at once.
 * The camera is locked via OrbitControls by disabling rotation,
 * panning and zooming.
 * ----------------------------------------------------------------- */

// Scene globals
let scene, camera, renderer;
let controls;
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

// Devices and click targets
let shadeGroup, shadeFabric, shadeBottomBar, shadeHandle, shadeClickTarget;
let acUnitMesh, thermMesh, thermDisplay, thermClickTarget;
let switchPlateMesh, switchLeverMesh, switchClickTarget;
let switchOn = true;

// Additional references for lighting and AC control.  The hemisphere and
// room fill lights need to be toggled when the ceiling light is
// switched off.  The ceiling fixture mesh is saved so its emissive
// colour can be adjusted.  The AC LED and grille group support
// animation when the AC is running.
let hemisphereLight, roomFillLight, ceilingFixtureMesh, sunbeamMesh;
let acLedMesh, acGrilleGroup, acAirflowGroup;
let acRunning = false;

// Pointer to the ceiling light so its intensity can be toggled with the light
// switch.  Assigned during init() when lights are created.
let ceilingLight;

// Occupant
let occupant;

// Additional environmental references
let sunLight;
let skyMesh;

// HUD and control element references.  These will be assigned in init()
let modeBadgeEl;
let valShadeEl, valThermEl, valLightsEl, valAcEl;
let valPmvEl, valTempEl, valCo2El, valLuxEl, valHumEl, valTimeEl;
// Center-column gauges + scenario readout.
let occStateEl, occIssueEl, alignScoreEl, alignMarkerEl, riskValEl, riskFillEl;
let scnNowEl, scnTotalEl, scnOverridesEl;
// Scenario / diagnosis card.
let diagIssueEl, diagPriorityEl, diagRiskEl, diagConflictEl;
// Action panel + feedback panel + end summary.
let actionsEl;
let fbPanelEl, fbVerdictEl, fbReasonEl, fbDeltaEl, fbRiskEl;
let summaryEl, sumScoreEl, sumStyleEl, sumDetailEl, sumRestartEl;

// Scene cues created in init() after the occupant is built.
let glareSprite, statusBubble;

// -------------------------------------------------------------------
// Game state — alignment scoring, scenario progression, event logging.
// All in-memory; no persistence or backend.
// -------------------------------------------------------------------
const TOTAL_SCENARIOS = 10;
const game = {
  scenario: 1,
  alignment: 100,        // 0..100 running score
  aligned: 0,            // count of accepted decisions
  misaligned: 0,         // count of overridden decisions
  overrides: 0,          // total occupant overrides
  domainConflicts: { Shading: 0, HVAC: 0, Lighting: 0 }, // where overrides happened
  actionsThisScenario: 0,
  solvedAt: 0,           // timestamp when current scenario became satisfied
  finished: false,
  lastDecision: null,    // result of the most recent player action this session
  log: [],               // structured per-action events
};

// Simulation state and animation queue
let state = 'idle';
const animations = [];

// Room dimensions and window geometry
const ROOM = { w: 8.0, d: 7.5, h: 3.6 };
const WINDOW = {
  width: 3.6,
  height: 2.05,
  bottom: 1.05,
  z: -ROOM.d / 2 + 0.06
};
const SHADE = {
  maxDrop: WINDOW.height,
  barHeight: 0.07
};

// Path waypoints for occupant navigation.  Values are chosen to
// follow the natural aisle around the desk to each device.
// Occupant pelvis heights: STAND_Y = standing, SEAT_Y = sitting on chair.
const STAND_Y = 0.92;
const SEAT_Y  = 0.59;

const POS = {
  // Raise the occupant so they sit above the chair surface and avoid
  // clipping the desk.  Shift the occupant to the right (-0.20 x) so they
  // clear the desk completely.  The seated and standing heights are
  // increased by 0.08m.
  seated:         new THREE.Vector3(-0.20, 0.84, -1.90),
  standDesk:      new THREE.Vector3(-0.20, 1.07, -1.90),
  aisle:          new THREE.Vector3( 0.85, 0.95, -1.90),
  windowApproach: new THREE.Vector3( 0.85, 0.95, WINDOW.z + 0.70),
  window:         new THREE.Vector3( 0.0,  0.95, WINDOW.z + 0.58),
  thermAisle:     new THREE.Vector3( 2.20, 0.95, -1.50),
  thermApproach:  new THREE.Vector3( 3.28, 0.95, -1.50),
  switchAisle:    new THREE.Vector3( 2.20, 0.95,  1.00),
  switchApproach: new THREE.Vector3( 3.28, 0.95,  1.00),
};

// DOM references
const statusEl = document.getElementById('status');

// Note: the scene is bootstrapped at the very bottom of this module
// (after all const declarations such as ACTIONS are initialised) so that
// init() can safely reference them without hitting a temporal-dead-zone.

function init() {
  // Create scene and camera
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xcfe1ef);

  camera = new THREE.PerspectiveCamera(
    50,
    window.innerWidth / window.innerHeight,
    0.1,
    100
  );
  // Position the camera to look directly at the window
  camera.position.set(0, 2.5, 7.5);
  camera.lookAt(0, 1.5, WINDOW.z);

  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  // OrbitControls locked (no rotation, pan or zoom).  The camera
  // target remains slightly below eye level to centre the view.
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.4, -2.1);
  controls.enableRotate = false;
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.enableDamping = false;
  controls.update();

  // Lighting: simulate natural daylight entering from the south (back) window.
  // Replace the default hemispheric and directional lights with a sky fill,
  // a sun far behind the back wall, a soft room fill and a ceiling light.
  // Save references to the sky and room lights so they can be dimmed when
  // the user turns off the light switch.  Without saving these, the room
  // remains partially lit when the switch is off.
  // Hemisphere acts as ambient skylight; intensity is driven by daylight +
  // shade position in updateDaylight.
  hemisphereLight = new THREE.HemisphereLight(0xddeeff, 0x6a7a5a, 0.30);
  scene.add(hemisphereLight);
  // Direct sun light (south-facing window). Stronger so the room is
  // visibly brighter when shade is up vs. down.
  sunLight = new THREE.DirectionalLight(0xfffbe8, 2.4);
  sunLight.position.set(-1.5, 7.0, -14.0);
  sunLight.target.position.set(0, 0.5, 1.5); // bias light into the room
  scene.add(sunLight.target);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.left = -8;
  sunLight.shadow.camera.right = 8;
  sunLight.shadow.camera.top = 8;
  sunLight.shadow.camera.bottom = -8;
  sunLight.shadow.camera.near = 1;
  sunLight.shadow.camera.far = 30;
  sunLight.shadow.bias = -0.0008;
  sunLight.shadow.normalBias = 0.02;
  sunLight.shadow.radius = 4;
  scene.add(sunLight);
  // Warm fill near the inside of the window — represents sunlight bouncing
  // off interior surfaces. Modulated by shade position.
  roomFillLight = new THREE.PointLight(0xfff4dd, 0.0, 9);
  roomFillLight.position.set(0, 1.6, WINDOW.z + 1.5);
  scene.add(roomFillLight);
  // Artificial ceiling light: only contributes when the switch is on.
  ceilingLight = new THREE.PointLight(0xfff4dd, 0.85, 7);
  ceilingLight.position.set(0, ROOM.h - 0.35, -0.5);
  scene.add(ceilingLight);

  // Sunbeam pool: a soft glowing rectangle on the floor where direct sun
  // would project through the window.  Its position drifts with time of
  // day; opacity scales with sun intensity * (1 - shade position).
  const beamGeom = new THREE.PlaneGeometry(WINDOW.width + 1.2, 4.0);
  const beamMat = new THREE.MeshBasicMaterial({
    color: 0xffe8a8,
    transparent: true,
    opacity: 0.0,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  sunbeamMesh = new THREE.Mesh(beamGeom, beamMat);
  sunbeamMesh.rotation.x = -Math.PI / 2;
  sunbeamMesh.position.set(0, 0.005, -1.2);
  scene.add(sunbeamMesh);

  // Build environment
  buildRoom();
  buildOutdoorView();
  buildWindowAndShade();
  buildFurniture();
  buildACAndThermostat();
  buildLightSwitch();
  buildPlant();
  buildBookshelf();
  buildOccupant();
  buildSceneCues();
  // Ensure the AC LED and louvres are initialised to the off state
  updateACVisual(false);

  // Event listeners
  window.addEventListener('resize', onWindowResize);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerdown', onPointerDown);

  // Assign HUD and control elements after DOM is loaded
  modeBadgeEl = document.getElementById('mode-badge');
  valShadeEl  = document.getElementById('val-shade');
  valThermEl  = document.getElementById('val-therm');
  valLightsEl = document.getElementById('val-lights');
  valAcEl     = document.getElementById('val-ac');
  valPmvEl    = document.getElementById('val-pmv');
  valTempEl   = document.getElementById('val-temp');
  valCo2El    = document.getElementById('val-co2');
  valLuxEl    = document.getElementById('val-lux');
  valHumEl    = document.getElementById('val-hum');
  valTimeEl   = document.getElementById('val-time');

  occStateEl    = document.getElementById('occ-state');
  occIssueEl    = document.getElementById('occ-issue');
  alignScoreEl  = document.getElementById('align-score');
  alignMarkerEl = document.getElementById('alignment-marker');
  riskValEl     = document.getElementById('risk-val');
  riskFillEl    = document.getElementById('risk-fill');
  scnNowEl      = document.getElementById('scn-now');
  scnTotalEl    = document.getElementById('scn-total');
  scnOverridesEl = document.getElementById('scn-overrides');

  diagIssueEl    = document.getElementById('diag-issue');
  diagPriorityEl = document.getElementById('diag-priority');
  diagRiskEl     = document.getElementById('diag-risk');
  diagConflictEl = document.getElementById('diag-conflict');

  actionsEl  = document.getElementById('actions');
  fbPanelEl   = document.getElementById('feedback-panel');
  fbVerdictEl = document.getElementById('fb-verdict');
  fbReasonEl  = document.getElementById('fb-reason');
  fbDeltaEl   = document.getElementById('fb-delta');
  fbRiskEl    = document.getElementById('fb-risk');

  summaryEl    = document.getElementById('summary-overlay');
  sumScoreEl   = document.getElementById('sum-score');
  sumStyleEl   = document.getElementById('sum-style');
  sumDetailEl  = document.getElementById('sum-detail');
  sumRestartEl = document.getElementById('sum-restart');
  if (sumRestartEl) sumRestartEl.addEventListener('click', restartSession);

  if (scnTotalEl) scnTotalEl.textContent = String(TOTAL_SCENARIOS);

  setStatus('waiting for interaction');
  // Initialise HUD with current simulation state and daylight
  const initialState = getState();
  renderActions(initialState);
  updateHUD(initialState);
  updateDaylight(initialState);
  // Debug hook — fire an override animation manually for testing.
  window.__sim = {
    forceOverride: (target) => { if (state === 'idle') startOverrideAnim(target); },
    snapshot: () => getState(),
    log: () => game.log,
    game: () => game,
    airflow: () => acAirflowGroup?.children?.map(c => ({
      color: '#' + c.material.color.getHexString(),
      opacity: c.material.opacity.toFixed(3),
    })),
    // Live head-cue state: opacity is what's actually rendered above the
    // occupant; cue is null when the occupant is comfortable.
    headCue: () => {
      const ui = deriveUiState(getState());
      return {
        opacity: statusBubble ? +statusBubble.sprite.material.opacity.toFixed(3) : null,
        cueType: ui.cueType,
        cue: ui.cueType ? CUE_VISUAL[ui.cueType] : null,
      };
    },
    ui: () => deriveUiState(getState()),
  };
}

/* -----------------------------------------------------------------
 * Scene cues: a glare marker near the window/desk and a status
 * bubble above the occupant.  Both are canvas-textured sprites so
 * they stay legible from the locked camera without cluttering the
 * room geometry.
 * ----------------------------------------------------------------- */
function makeLabelSprite() {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 160;
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.renderOrder = 998;
  function setText(text, bg) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const w = canvas.width, h = canvas.height, r = 38;
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.moveTo(r, 8); ctx.lineTo(w - r, 8);
    ctx.arcTo(w - 8, 8, w - 8, r + 8, r); ctx.lineTo(w - 8, h - r - 24);
    ctx.arcTo(w - 8, h - 24, w - r, h - 24, r); ctx.lineTo(w / 2 + 26, h - 24);
    ctx.lineTo(w / 2, h - 2); ctx.lineTo(w / 2 - 26, h - 24); ctx.lineTo(r, h - 24);
    ctx.arcTo(8, h - 24, 8, h - r - 24, r); ctx.lineTo(8, r + 8);
    ctx.arcTo(8, 8, r, 8, r); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 60px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, (h - 24) / 2 + 8);
    tex.needsUpdate = true;
  }
  return { sprite, setText };
}

function buildSceneCues() {
  // Occupant status bubble — floats above the head, follows the occupant.
  statusBubble = makeLabelSprite();
  statusBubble.sprite.scale.set(1.15, 0.36, 1);
  statusBubble.setText('Comfortable', 'rgba(47,143,91,0.92)');
  if (occupant) {
    statusBubble.sprite.position.set(0, occupant.userData.angryBaseY + 0.42, 0);
    occupant.add(statusBubble.sprite);
  }

  // Glare marker — a soft warning disc near the workstation, shown only
  // when strong daylight reaches an un-shaded window.
  const glareCanvas = document.createElement('canvas');
  glareCanvas.width = 256; glareCanvas.height = 256;
  const gctx = glareCanvas.getContext('2d');
  const grad = gctx.createRadialGradient(128, 128, 20, 128, 128, 124);
  grad.addColorStop(0, 'rgba(255,210,80,0.95)');
  grad.addColorStop(0.6, 'rgba(255,180,40,0.55)');
  grad.addColorStop(1, 'rgba(255,180,40,0)');
  gctx.fillStyle = grad;
  gctx.beginPath(); gctx.arc(128, 128, 124, 0, Math.PI * 2); gctx.fill();
  gctx.fillStyle = '#9a5b00';
  gctx.font = 'bold 92px Inter, system-ui, sans-serif';
  gctx.textAlign = 'center'; gctx.textBaseline = 'middle';
  gctx.fillText('☀', 128, 132);
  const glareTex = new THREE.CanvasTexture(glareCanvas);
  glareSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glareTex, transparent: true, opacity: 0, depthTest: false,
  }));
  glareSprite.scale.set(0.6, 0.6, 1);
  glareSprite.position.set(0.45, WINDOW.bottom + WINDOW.height * 0.5, WINDOW.z + 0.9);
  glareSprite.renderOrder = 997;
  scene.add(glareSprite);
}

/* -----------------------------------------------------------------
 * Scene construction functions
 * ----------------------------------------------------------------- */

// Builds the floor and walls.  Only left, right and front walls are
// constructed; the back wall is open where the window sits.
function buildRoom() {
  // Floor
  const floorMat = new THREE.MeshStandardMaterial({ color: 0xc5b8a5 });
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM.w, ROOM.d),
    floorMat
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Ceiling: a simple plane closing the room overhead.  Colour is a
  // warm off‑white to match the walls.  It faces downward into the room.
  const ceilingMat = new THREE.MeshStandardMaterial({ color: 0xf0eeea, roughness: 0.9 });
  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM.w, ROOM.d),
    ceilingMat
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(0, ROOM.h, 0);
  ceiling.receiveShadow = true;
  scene.add(ceiling);

  // Walls
  const wallThickness = 0.08;
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xe6edf2 });
  // Left wall
  const leftWall = new THREE.Mesh(
    new THREE.BoxGeometry(wallThickness, ROOM.h, ROOM.d),
    wallMat
  );
  leftWall.position.set(-ROOM.w / 2 + wallThickness / 2, ROOM.h / 2, 0);
  leftWall.receiveShadow = true;
  scene.add(leftWall);
  // Right wall
  const rightWall = leftWall.clone();
  rightWall.position.set(ROOM.w / 2 - wallThickness / 2, ROOM.h / 2, 0);
  scene.add(rightWall);
  // Front wall removed: dollhouse view — camera looks into the room from
  // the open front side, with the window/sun at the back wall.

  // Back wall built as 4 segments framing the window opening so the
  // outdoor landscape only shows through the window, not the whole wall.
  const backZ = -ROOM.d / 2 + wallThickness / 2;
  const winLeft   = -WINDOW.width / 2;
  const winRight  =  WINDOW.width / 2;
  const winBottom =  WINDOW.bottom;
  const winTop    =  WINDOW.bottom + WINDOW.height;
  const sideW = (ROOM.w - WINDOW.width) / 2;
  // Left jamb
  const backLeft = new THREE.Mesh(
    new THREE.BoxGeometry(sideW, ROOM.h, wallThickness), wallMat
  );
  backLeft.position.set(-ROOM.w / 2 + sideW / 2, ROOM.h / 2, backZ);
  backLeft.receiveShadow = true;
  scene.add(backLeft);
  // Right jamb
  const backRight = new THREE.Mesh(
    new THREE.BoxGeometry(sideW, ROOM.h, wallThickness), wallMat
  );
  backRight.position.set(ROOM.w / 2 - sideW / 2, ROOM.h / 2, backZ);
  backRight.receiveShadow = true;
  scene.add(backRight);
  // Header (above the window)
  const headerH = ROOM.h - winTop;
  const backHeader = new THREE.Mesh(
    new THREE.BoxGeometry(WINDOW.width, headerH, wallThickness), wallMat
  );
  backHeader.position.set(0, winTop + headerH / 2, backZ);
  backHeader.receiveShadow = true;
  scene.add(backHeader);
  // Sill (below the window)
  const backSill = new THREE.Mesh(
    new THREE.BoxGeometry(WINDOW.width, winBottom, wallThickness), wallMat
  );
  backSill.position.set(0, winBottom / 2, backZ);
  backSill.receiveShadow = true;
  scene.add(backSill);

  // Ceiling light fixture (simple box with emissive top)
  const fixture = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, 0.05, 0.35),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35 })
  );
  fixture.position.set(0, ROOM.h - 0.05, -0.4);
  scene.add(fixture);
  // Note: the overhead light fixture geometry is kept for visual appeal, but
  // lighting itself is handled by the global ceiling light in init().

  // Save the fixture mesh reference so its emissive properties can be
  // controlled when toggling the light switch.  Without this, the
  // fixture would continue to glow even when the lights are off.
  ceilingFixtureMesh = fixture;
}

// Builds a low‑poly outdoor view behind the window to give depth.
function buildOutdoorView() {
  const group = new THREE.Group();
  group.position.set(0, 0, WINDOW.z - 0.55);
  scene.add(group);
  // Sky
  // Sky plane.  Save a reference so its colour can be updated with time of day.
  skyMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(11, 5),
    new THREE.MeshBasicMaterial({ color: 0x9bd4f0 })
  );
  skyMesh.position.set(0, 2.2, -0.02);
  group.add(skyMesh);
  // Sun
  const sun = new THREE.Mesh(
    new THREE.CircleGeometry(0.28, 24),
    new THREE.MeshBasicMaterial({ color: 0xffe89a })
  );
  sun.position.set(1.25, 2.75, 0.02);
  group.add(sun);
  // Hills
  function makeHill(width, height, baseY, color) {
    const shape = new THREE.Shape();
    shape.moveTo(-width / 2, baseY);
    shape.lineTo(-width * 0.35, baseY + height * 0.55);
    shape.lineTo(-width * 0.1, baseY + height);
    shape.lineTo(width * 0.2, baseY + height * 0.58);
    shape.lineTo(width / 2, baseY);
    return new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color }));
  }
  const hill1 = makeHill(5.8, 1.15, 0.2, 0x4d7f67);
  hill1.position.set(-2.1, 1.05, 0.03);
  group.add(hill1);
  const hill2 = makeHill(6.2, 1.0, 0.12, 0x6ba07b);
  hill2.position.set(1.1, 1.0, 0.04);
  group.add(hill2);
  const hill3 = makeHill(5.0, 0.8, 0.05, 0x89b989);
  hill3.position.set(0, 0.85, 0.05);
  group.add(hill3);
  // Lake and grass
  const lake = new THREE.Mesh(
    new THREE.PlaneGeometry(7.5, 0.75),
    new THREE.MeshBasicMaterial({ color: 0x6fb3c5 })
  );
  lake.position.set(0, 0.75, 0.06);
  group.add(lake);
  const grass = new THREE.Mesh(
    new THREE.PlaneGeometry(8.5, 1.0),
    new THREE.MeshBasicMaterial({ color: 0x7aaa55 })
  );
  grass.position.set(0, 0.25, 0.07);
  group.add(grass);
  // Trees
  function makeTree(x, y, z, scale) {
    const tree = new THREE.Group();
    tree.position.set(x, y, z);
    const trunk = new THREE.Mesh(
      new THREE.BoxGeometry(scale * 0.18, scale * 0.55, 0.02),
      new THREE.MeshBasicMaterial({ color: 0x6b4d2e })
    );
    trunk.position.y = scale * 0.25;
    tree.add(trunk);
    const crown = new THREE.Mesh(
      new THREE.ConeGeometry(scale * 0.55, scale * 1.1, 7),
      new THREE.MeshBasicMaterial({ color: 0x2f6c45 })
    );
    crown.position.y = scale * 0.8;
    tree.add(crown);
    return tree;
  }
  for (let i = 0; i < 14; i++) {
    const x = -3.6 + i * 0.55;
    const y = 0.55 + Math.sin(i * 1.7) * 0.08;
    group.add(makeTree(x, y, 0.08, 0.25 + (i % 3) * 0.04));
  }
}

// Builds the window frame, glass, roller tube and shade components.
function buildWindowAndShade() {
  // Frame material
  const frameMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.35 });

  // Window top and bottom frame
  const frameThickness = 0.10;
  const frameDepth = 0.11;
  function addFrame(w, h, x, y, z) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, frameDepth),
      frameMat
    );
    mesh.position.set(x, y, z);
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
  addFrame(WINDOW.width + 0.25, frameThickness, 0, WINDOW.bottom + WINDOW.height + frameThickness / 2, WINDOW.z + 0.015);
  addFrame(WINDOW.width + 0.25, frameThickness, 0, WINDOW.bottom - frameThickness / 2, WINDOW.z + 0.015);
  // Sides
  addFrame(frameThickness, WINDOW.height + 0.2, -WINDOW.width / 2 - frameThickness / 2, WINDOW.bottom + WINDOW.height / 2, WINDOW.z + 0.015);
  addFrame(frameThickness, WINDOW.height + 0.2, WINDOW.width / 2 + frameThickness / 2, WINDOW.bottom + WINDOW.height / 2, WINDOW.z + 0.015);
  // Mullion
  addFrame(0.07, WINDOW.height + 0.05, 0, WINDOW.bottom + WINDOW.height / 2, WINDOW.z + 0.018);

  // Glass pane
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(WINDOW.width, WINDOW.height),
    new THREE.MeshPhysicalMaterial({
      color: 0xd8f2ff,
      roughness: 0.05,
      metalness: 0,
      transparent: true,
      opacity: 0.26,
      transmission: 0.18
    })
  );
  glass.position.set(0, WINDOW.bottom + WINDOW.height / 2, WINDOW.z + 0.035);
  scene.add(glass);

  // Roller tube
  const tube = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.08, WINDOW.width + 0.25, 20),
    new THREE.MeshStandardMaterial({ color: 0x6d7783, roughness: 0.4 })
  );
  tube.rotation.z = Math.PI / 2;
  tube.position.set(0, WINDOW.bottom + WINDOW.height + 0.17, WINDOW.z + 0.08);
  scene.add(tube);

  // Shade group
  shadeGroup = new THREE.Group();
  shadeGroup.position.set(0, WINDOW.bottom + WINDOW.height, WINDOW.z + 0.095);
  scene.add(shadeGroup);

  // Shade fabric: pivot at top edge (translate geometry)
  const fabricGeom = new THREE.PlaneGeometry(WINDOW.width, SHADE.maxDrop);
  fabricGeom.translate(0, -SHADE.maxDrop / 2, 0);
  // Opaque shade material so it casts a solid shadow (transparent meshes
  // produce binary, less reliable shadow maps).
  shadeFabric = new THREE.Mesh(fabricGeom, new THREE.MeshStandardMaterial({
    color: 0xe7e0d2,
    roughness: 0.95,
    side: THREE.DoubleSide
  }));
  shadeFabric.scale.y = 0.03;
  shadeFabric.castShadow = true;
  shadeFabric.receiveShadow = true;
  shadeGroup.add(shadeFabric);

  // Bottom bar of shade
  shadeBottomBar = new THREE.Mesh(
    new THREE.BoxGeometry(WINDOW.width + 0.12, SHADE.barHeight, 0.08),
    new THREE.MeshStandardMaterial({ color: 0x2c333a, roughness: 0.45 })
  );
  shadeBottomBar.castShadow = true;
  shadeBottomBar.receiveShadow = true;
  shadeGroup.add(shadeBottomBar);

  // Visible handle for user (orange bar)
  shadeHandle = new THREE.Mesh(
    new THREE.BoxGeometry(WINDOW.width + 0.18, SHADE.barHeight * 1.2, 0.05),
    new THREE.MeshStandardMaterial({ color: 0xee9955, roughness: 0.5 })
  );
  shadeHandle.position.y = -SHADE.maxDrop * shadeFabric.scale.y - SHADE.barHeight * 1.5;
  shadeGroup.add(shadeHandle);

  // Invisible click target covering shade bottom region
  shadeClickTarget = new THREE.Mesh(
    new THREE.PlaneGeometry(WINDOW.width + 0.4, SHADE.barHeight * 5),
    new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
  );
  shadeClickTarget.position.y = -SHADE.maxDrop * shadeFabric.scale.y - SHADE.barHeight * 2.5;
  shadeClickTarget.userData.clickable = 'shade';
  shadeClickTarget.rotation.x = -Math.PI / 2;
  shadeGroup.add(shadeClickTarget);

  updateShadeBar();
}

// Update bottom bar and handle positions whenever shade scale changes.
function updateShadeBar() {
  const drop = SHADE.maxDrop * shadeFabric.scale.y;
  shadeBottomBar.position.y = -drop - SHADE.barHeight / 2;
  shadeHandle.position.y = -drop - SHADE.barHeight * 1.5;
  shadeClickTarget.position.y = -drop - SHADE.barHeight * 2.5;
}

// Builds the desk, chair and laptop.  Colours are muted so that
// interactive devices stand out.
function buildFurniture() {
  // Desk surface.  Rotate the desk 90° so its long axis runs along
  // Z (front‑to‑back).  The top is narrower along X (1.05 m) and
  // deeper along Z (2.65 m).  Place the desk centre at x = -1.40.
  const top = new THREE.Mesh(
    new THREE.BoxGeometry(1.05, 0.13, 2.65),
    new THREE.MeshStandardMaterial({ color: 0x9b6b43, roughness: 0.55 })
  );
  top.position.set(-1.40, 0.78, -1.90);
  top.castShadow = true;
  top.receiveShadow = true;
  scene.add(top);
  // Desk legs: reposition to match the rotated desk footprint.  Legs are
  // set at the four corners of the new desk footprint.  Use the same
  // leg material and geometry as before.
  const legGeom = new THREE.BoxGeometry(0.09, 0.76, 0.09);
  const legMat  = new THREE.MeshStandardMaterial({ color: 0x654326, roughness: 0.65 });
  const legPositions = [
    [-1.83, 0.38, -3.12], // back left
    [-0.97, 0.38, -3.12], // back right
    [-1.83, 0.38, -0.68], // front left
    [-0.97, 0.38, -0.68], // front right
  ];
  for (const [x, y, z] of legPositions) {
    const leg = new THREE.Mesh(legGeom, legMat);
    leg.position.set(x, y, z);
    leg.castShadow = true;
    leg.receiveShadow = true;
    scene.add(leg);
  }
  // Chair
  const chair = new THREE.Group();
  // Seat: narrower and centred on the new occupant position.  A low
  // profile helps avoid leg clipping.  The seat aligns with
  // POS.seated.x and POS.seated.z so the occupant sits squarely on it.
  const seat = new THREE.Mesh(
    new THREE.BoxGeometry(0.62, 0.10, 0.62),
    new THREE.MeshStandardMaterial({ color: 0x2f3945, roughness: 0.66 })
  );
  seat.position.set(POS.seated.x, 0.54, POS.seated.z);
  seat.castShadow = true;
  seat.receiveShadow = true;
  chair.add(seat);
  // Backrest: taller and thinner, placed behind the occupant on the
  // +X side (since the occupant faces –X).  A slight lean back gives
  // visual comfort.  The back has the same material as the seat.
  const back = new THREE.Mesh(
    new THREE.BoxGeometry(0.10, 0.65, 0.62),
    seat.material
  );
  back.position.set(POS.seated.x + 0.32, 0.89, POS.seated.z);
  back.castShadow = true;
  back.receiveShadow = true;
  chair.add(back);
  // Chair legs: four slender legs.  Positions are chosen so the legs
  // support the seat corners but leave space for the occupant's feet.
  const chairLegGeom = new THREE.BoxGeometry(0.05, 0.44, 0.05);
  const chairLegMat  = new THREE.MeshStandardMaterial({ color: 0x555e6a, roughness: 0.6 });
  const legCoords = [
    [-0.48, -2.18],
    [ 0.08, -2.18],
    [-0.48, -1.62],
    [ 0.08, -1.62],
  ];
  for (const [lx, lz] of legCoords) {
    const leg = new THREE.Mesh(chairLegGeom, chairLegMat);
    leg.position.set(lx, 0.27, lz);
    leg.castShadow = true;
    leg.receiveShadow = true;
    chair.add(leg);
  }
  scene.add(chair);

  // Laptop prop on the desk.  When the desk is rotated, position the
  // laptop near the occupant side (along +Z direction) on the desk.
  const laptopBase = new THREE.Mesh(
    new THREE.BoxGeometry(0.42, 0.025, 0.32),
    new THREE.MeshStandardMaterial({ color: 0x22272e, roughness: 0.4 })
  );
  laptopBase.position.set(-1.20, 0.845, -2.10);
  laptopBase.castShadow = true;
  laptopBase.receiveShadow = true;
  scene.add(laptopBase);
  const laptopScreen = new THREE.Mesh(
    new THREE.BoxGeometry(0.025, 0.28, 0.32),
    new THREE.MeshStandardMaterial({ color: 0x1a2030, roughness: 0.35, emissive: 0x0a1520, emissiveIntensity: 0.4 })
  );
  laptopScreen.position.set(-1.42, 1.00, -2.10);
  laptopScreen.castShadow = true;
  laptopScreen.receiveShadow = true;
  scene.add(laptopScreen);
}

/*
 * Facial expression library for the occupant avatar.  Each entry is a set of
 * normalised channel values the face engine eases toward:
 *   browLZ / browRZ  brow tilt (asymmetry reads as skepticism / anger)
 *   browY            brow height (raised = worried, lowered = angry)
 *   squint           0 open … 1 eyes nearly shut
 *   cornerY          mouth corners (+ smile, − frown)
 *   open             mouth openness (panting / shouting)
 *   warm / cold      cheek flush overlay (red / blue)
 *   sweat            sweat-bead opacity
 *   tiltZ / tiltX    head tilt (sideways skepticism / lean-in or recoil)
 * Names match the OccupantExpression states the design calls for.
 */
const EXPRESSIONS = {
  neutral:            { browLZ: 0,     browRZ: 0,     browY: 0,      squint: 0.05, cornerY: 0,      open: 0,    warm: 0,   cold: 0, sweat: 0,   tiltZ: 0,     tiltX: 0 },
  skeptical_annoyed:  { browLZ: 0.45,  browRZ: -0.12, browY: 0.004,  squint: 0.30, cornerY: -0.006, open: 0,    warm: 0,   cold: 0, sweat: 0,   tiltZ: 0.12,  tiltX: 0 },
  tense_uncomfortable:{ browLZ: -0.28, browRZ: 0.28,  browY: 0.011,  squint: 0,    cornerY: -0.004, open: 0.08, warm: 0,   cold: 0, sweat: 0.15, tiltZ: 0,    tiltX: 0.05 },
  forced_smile:       { browLZ: -0.05, browRZ: 0.05,  browY: 0.008,  squint: 0.32, cornerY: 0.014,  open: 0.04, warm: 0,   cold: 0, sweat: 0,   tiltZ: 0.03,  tiltX: 0 },
  glare_discomfort:   { browLZ: 0.42,  browRZ: -0.42, browY: -0.012, squint: 0.72, cornerY: -0.006, open: 0.05, warm: 0,   cold: 0, sweat: 0.1, tiltZ: 0.05,  tiltX: -0.06 },
  too_warm:           { browLZ: -0.1,  browRZ: 0.1,   browY: 0.012,  squint: 0.40, cornerY: -0.002, open: 0.55, warm: 1,   cold: 0, sweat: 1,   tiltZ: 0,     tiltX: 0.05 },
  too_cold:           { browLZ: -0.22, browRZ: 0.22,  browY: 0.008,  squint: 0.45, cornerY: 0.002,  open: 0,    warm: 0,   cold: 1, sweat: 0,   tiltZ: 0,     tiltX: 0.09 },
  poor_air_quality:   { browLZ: -0.06, browRZ: 0.06,  browY: 0.006,  squint: 0.50, cornerY: -0.010, open: 0.30, warm: 0,   cold: 0, sweat: 0.5, tiltZ: 0.02,  tiltX: 0.10 },
  override_rejection: { browLZ: 0.50,  browRZ: -0.50, browY: -0.016, squint: 0.12, cornerY: -0.012, open: 0.70, warm: 0.4, cold: 0, sweat: 0,   tiltZ: 0,     tiltX: -0.08 },
};

// Map the occupant's derived comfort state (the same source of truth the HUD
// and head bubble use) to a facial expression, so the avatar can never
// contradict the rest of the UI.
function expressionForUi(ui, simState) {
  switch (ui.cueType) {
    case 'override': return 'override_rejection';
    case 'glare':    return 'glare_discomfort';
    case 'warm':     return 'too_warm';
    case 'cold':     return 'too_cold';
    case 'air':      return 'poor_air_quality';
    case 'annoyed':  return 'skeptical_annoyed';
  }
  // No active discomfort cue → comfortable or mildly settling.
  if (simState.occupant.discomfort >= 0.10) return 'tense_uncomfortable';
  // Comfortable: a brief forced/awkward smile right after the player pleased
  // them, otherwise a relaxed neutral.
  if (game.lastDecision && game.lastDecision.verdict === 'aligned') return 'forced_smile';
  return 'neutral';
}

/* -----------------------------------------------------------------
 * Occupant avatar — an ORIGINAL low-poly "awkward office manager".
 *
 * Built entirely from procedural Three.js primitives (no external models,
 * no textures, no new dependencies).  The figure is intentionally generic:
 * a stylised office manager with a dark suit, light shirt, muted tie, short
 * dark hair and an expressive face.  It is NOT a likeness of any real person
 * or named character — just a relatable, slightly uncomfortable everyman.
 *
 * The face exposes a small set of named expression states (see EXPRESSIONS)
 * that the simulation maps from the occupant's derived comfort state, so the
 * avatar visibly reacts: skeptical, tense, forced smile, glare squint, too
 * warm, too cold, poor air, and an override rejection.
 *
 * The body rig (arm/leg joints, posture, reach, basePos) and the userData
 * keys are preserved exactly so the existing walk/override animations and the
 * floating status bubble keep working untouched.
 * ----------------------------------------------------------------- */
function buildOccupant() {
  occupant = new THREE.Group();
  const skinMat   = new THREE.MeshStandardMaterial({ color: 0xe7b48f, roughness: 0.65 });
  const skinShade = new THREE.MeshStandardMaterial({ color: 0xd79f78, roughness: 0.65 });
  const jacketMat = new THREE.MeshStandardMaterial({ color: 0x2b3242, roughness: 0.72 });
  const shirtMat  = new THREE.MeshStandardMaterial({ color: 0xe4ebf2, roughness: 0.55 });
  const tieMat    = new THREE.MeshStandardMaterial({ color: 0x7d4f63, roughness: 0.6 });
  const hairMat   = new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.85 });
  const pantsMat  = new THREE.MeshStandardMaterial({ color: 0x232a38, roughness: 0.7 });
  const shoeMat   = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.6 });
  const browMat   = new THREE.MeshStandardMaterial({ color: 0x271d15, roughness: 0.8 });
  const eyeWhiteMat = new THREE.MeshStandardMaterial({ color: 0xf6f7f9, roughness: 0.4 });
  const pupilMat  = new THREE.MeshStandardMaterial({ color: 0x241c1a, roughness: 0.4 });
  const mouthMat  = new THREE.MeshStandardMaterial({ color: 0x8a4a4a, roughness: 0.6 });
  const mouthDarkMat = new THREE.MeshStandardMaterial({ color: 0x3a1f25, roughness: 0.6 });

  // Torso: a buttoned suit jacket extending up from the pelvis (origin).
  const torsoH = 0.55;
  const torso = new THREE.Mesh(
    new THREE.BoxGeometry(0.42, torsoH, 0.24), jacketMat
  );
  torso.position.set(0, torsoH / 2, 0);
  torso.castShadow = true;
  occupant.add(torso);

  // Suit detailing on the chest (front is local -Z, toward the desk/camera).
  const frontZ = -0.121;
  // Light shirt panel showing in the jacket gap.
  const shirtPanel = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.40, 0.02), shirtMat);
  shirtPanel.position.set(0, 0.34, frontZ);
  occupant.add(shirtPanel);
  // Muted tie + a small knot at the collar.
  const tie = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.30, 0.02), tieMat);
  tie.position.set(0, 0.30, frontZ - 0.006);
  occupant.add(tie);
  const knot = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.05, 0.025), tieMat);
  knot.position.set(0, 0.46, frontZ - 0.006);
  occupant.add(knot);
  // Jacket lapels angled in over the shirt to leave a V.
  [-1, 1].forEach((s) => {
    const lapel = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.34, 0.02), jacketMat);
    lapel.position.set(s * 0.11, 0.34, frontZ - 0.004);
    lapel.rotation.z = s * 0.20;
    occupant.add(lapel);
  });

  // Neck.
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 0.10, 10), skinMat);
  neck.position.set(0, torsoH + 0.04, 0);
  neck.castShadow = true;
  occupant.add(neck);

  // ---- Head + expressive face -------------------------------------------
  // Everything facial lives in headGroup so expressions can tilt the whole
  // head.  headGroup origin sits at the head centre (matches the old head
  // position), keeping angryBaseY and the status bubble anchor unchanged.
  const headR = 0.15;
  const headGroup = new THREE.Group();
  headGroup.position.set(0, torsoH + 0.06 + headR, 0);
  // The body faces the desk (world -X), which would leave the face turned away
  // from the fixed camera.  Give the head a modest base yaw so the occupant
  // reads as glancing toward the room/automation, keeping the expressive face
  // visible.  Expressions only drive rotation.x / rotation.z, so this base yaw
  // persists.  Body orientation and the walk/override rig are untouched.
  const HEAD_BASE_YAW = 0.62;
  headGroup.rotation.y = HEAD_BASE_YAW;
  occupant.add(headGroup);

  const head = new THREE.Mesh(new THREE.SphereGeometry(headR, 18, 18), skinMat);
  head.castShadow = true;
  headGroup.add(head);

  // Short dark hair: a slightly larger capsule shifted up/back so the face
  // stays bare, plus a small fringe and sideburns.
  const hair = new THREE.Mesh(new THREE.SphereGeometry(headR + 0.012, 18, 18), hairMat);
  hair.scale.set(1.02, 0.92, 1.04);
  hair.position.set(0, 0.045, 0.02);
  headGroup.add(hair);
  const fringe = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.05, 0.06), hairMat);
  fringe.position.set(0, 0.10, -0.118);
  headGroup.add(fringe);
  [-1, 1].forEach((s) => {
    const burn = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.10, 0.05), hairMat);
    burn.position.set(s * 0.142, 0.0, -0.04);
    headGroup.add(burn);
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 8), skinMat);
    ear.position.set(s * 0.15, -0.01, 0.0);
    headGroup.add(ear);
  });

  const faceZ = -0.132;   // front plane of the face

  // Eyebrows — the main emotional channel.  Each brow pivots about its own
  // centre so rotation.z + height encodes the expression.
  function makeBrow(side) {
    const g = new THREE.Group();
    g.position.set(side * 0.058, 0.072, faceZ - 0.006);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.072, 0.018, 0.022), browMat);
    g.add(bar);
    headGroup.add(g);
    return g;
  }
  const browL = makeBrow(-1);
  const browR = makeBrow(1);
  const browBaseY = 0.072;

  // Eyes — white + pupil, grouped so a squint can scale them vertically.
  function makeEye(side) {
    const g = new THREE.Group();
    g.position.set(side * 0.058, 0.022, faceZ);
    const white = new THREE.Mesh(new THREE.SphereGeometry(0.033, 12, 12), eyeWhiteMat);
    white.scale.set(1, 1, 0.55);
    g.add(white);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.016, 10, 10), pupilMat);
    pupil.position.set(0, 0, -0.022);
    g.add(pupil);
    headGroup.add(g);
    return g;
  }
  const eyeL = makeEye(-1);
  const eyeR = makeEye(1);
  const eyeBaseY = 0.022;

  // Upper eyelids (skin) that lower over the eyes to squint.
  function makeLid(side) {
    const lid = new THREE.Mesh(new THREE.BoxGeometry(0.066, 0.034, 0.03), skinMat);
    lid.position.set(side * 0.058, 0.052, faceZ - 0.004);
    headGroup.add(lid);
    return lid;
  }
  const lidL = makeLid(-1);
  const lidR = makeLid(1);
  const lidBaseY = 0.052;

  // Pronounced but generic nose.
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.078, 0.07), skinShade);
  nose.position.set(0, -0.008, faceZ - 0.026);
  headGroup.add(nose);

  // Mouth: a centre line plus two corner cubes whose height encodes
  // smile/frown, and a dark "open" block that fades in for open-mouth states.
  const mouthGroup = new THREE.Group();
  mouthGroup.position.set(0, -0.082, faceZ + 0.004);
  const mouthLine = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.014, 0.02), mouthMat);
  mouthGroup.add(mouthLine);
  const cornerBaseY = 0;
  const cornerL = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.02), mouthMat);
  cornerL.position.set(-0.052, cornerBaseY, 0);
  mouthGroup.add(cornerL);
  const cornerR = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.02), mouthMat);
  cornerR.position.set(0.052, cornerBaseY, 0);
  mouthGroup.add(cornerR);
  const mouthOpen = new THREE.Mesh(new THREE.BoxGeometry(0.066, 0.05, 0.018), mouthDarkMat);
  mouthOpen.material.transparent = true;
  mouthOpen.material.opacity = 0;
  mouthOpen.position.set(0, -0.012, 0.002);
  mouthGroup.add(mouthOpen);
  headGroup.add(mouthGroup);

  // Cheek flush (warm = red, cold = blue) + a sweat bead.  Basic materials so
  // they read as flat overlays regardless of scene lighting.
  function makeCheekTint(color) {
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.034, 10, 10), m);
    mesh.scale.set(1, 0.8, 0.4);
    return mesh;
  }
  const cheekWarmL = makeCheekTint(0xe2674a); cheekWarmL.position.set(-0.088, -0.03, faceZ + 0.005);
  const cheekWarmR = makeCheekTint(0xe2674a); cheekWarmR.position.set(0.088, -0.03, faceZ + 0.005);
  const cheekColdL = makeCheekTint(0x6fa8d6); cheekColdL.position.set(-0.088, -0.03, faceZ + 0.006);
  const cheekColdR = makeCheekTint(0x6fa8d6); cheekColdR.position.set(0.088, -0.03, faceZ + 0.006);
  headGroup.add(cheekWarmL, cheekWarmR, cheekColdL, cheekColdR);
  const sweatMat = new THREE.MeshBasicMaterial({ color: 0xbfe3f2, transparent: true, opacity: 0, depthWrite: false });
  const sweat = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.036, 0.012), sweatMat);
  sweat.position.set(0.108, 0.045, faceZ + 0.01);
  headGroup.add(sweat);

  // Collect the controllable facial parts for the expression engine.
  const face = {
    headGroup, browL, browR, browBaseY, eyeL, eyeR, eyeBaseY,
    lidL, lidR, lidBaseY, cornerL, cornerR, cornerBaseY, mouthOpen,
    cheekWarmL, cheekWarmR, cheekColdL, cheekColdR, sweat,
    // Current (animated) channel values, lerped toward the target each frame.
    cur: { browLZ: 0, browRZ: 0, browY: 0, squint: 0, cornerY: 0, open: 0, warm: 0, cold: 0, sweat: 0, tiltZ: 0, tiltX: 0 },
    tgt: Object.assign({}, EXPRESSIONS.neutral),
  };

  // Build a jointed arm: shoulder pivot → upper arm → elbow pivot → forearm.
  function makeArm(side) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.22, torsoH - 0.05, 0);
    const upper = new THREE.Mesh(
      new THREE.BoxGeometry(0.10, 0.26, 0.10), jacketMat
    );
    upper.position.set(0, -0.13, 0); // hangs down from shoulder
    upper.castShadow = true;
    shoulder.add(upper);
    const elbow = new THREE.Group();
    elbow.position.set(0, -0.26, 0);
    const fore = new THREE.Mesh(
      new THREE.BoxGeometry(0.085, 0.24, 0.085), jacketMat
    );
    fore.position.set(0, -0.12, 0);
    fore.castShadow = true;
    elbow.add(fore);
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.072, 0.075, 0.072), skinMat);
    hand.position.set(0, -0.265, 0);
    hand.castShadow = true;
    elbow.add(hand);
    shoulder.add(elbow);
    occupant.add(shoulder);
    return { shoulder, elbow };
  }

  // Build a jointed leg: hip pivot → thigh → knee pivot → shin + shoe.
  function makeLeg(side) {
    const hip = new THREE.Group();
    hip.position.set(side * 0.10, 0, 0);
    const thigh = new THREE.Mesh(
      new THREE.BoxGeometry(0.13, 0.40, 0.13), pantsMat
    );
    thigh.position.set(0, -0.20, 0);
    thigh.castShadow = true;
    hip.add(thigh);
    const knee = new THREE.Group();
    knee.position.set(0, -0.40, 0);
    const shin = new THREE.Mesh(
      new THREE.BoxGeometry(0.11, 0.40, 0.11), pantsMat
    );
    shin.position.set(0, -0.20, 0);
    shin.castShadow = true;
    knee.add(shin);
    const shoe = new THREE.Mesh(
      new THREE.BoxGeometry(0.13, 0.06, 0.22), shoeMat
    );
    shoe.position.set(0, -0.43, -0.05);
    shoe.castShadow = true;
    knee.add(shoe);
    hip.add(knee);
    occupant.add(hip);
    return { hip, knee };
  }

  const lArm = makeArm(-1);
  const rArm = makeArm( 1);
  const lLeg = makeLeg(-1);
  const rLeg = makeLeg( 1);

  // Apply posture: 0 = seated (hips & knees bent ~90°), 1 = standing.
  // Local forward is -Z (away from camera in occupant frame).  Hip rotates
  // +π/2 around X to swing thighs forward; knee rotates -π/2 to swing shins
  // back down to the floor. While standing, an additional stride swing is
  // overlaid for walking.
  function applyPosture(p) {
    const stride = (occupant.userData && occupant.userData.stride) || 0;
    const seatHip  = (1 - p) * ( Math.PI / 2);
    const seatKnee = (1 - p) * (-Math.PI / 2);
    // Stride scales with how upright we are (no leg swing while seated)
    const sw = stride * p;
    lLeg.hip.rotation.x  = seatHip + sw;
    rLeg.hip.rotation.x  = seatHip - sw;
    lLeg.knee.rotation.x = seatKnee - Math.max(0,  sw) * 0.6;
    rLeg.knee.rotation.x = seatKnee - Math.max(0, -sw) * 0.6;
    // Arms: when seated reach forward to the laptop; when walking swing
    // opposite to the legs for balance.
    const seatShoulder = (1 - p) * ( Math.PI / 4);
    const seatElbow    = (1 - p) * ( Math.PI / 2.5);
    const armSwing = -sw * 0.6;
    lArm.shoulder.rotation.x = seatShoulder + armSwing;
    rArm.shoulder.rotation.x = seatShoulder - armSwing;
    lArm.elbow.rotation.x    = seatElbow;
    rArm.elbow.rotation.x    = seatElbow;
  }
  applyPosture(0);

  // Annoyance indicator above the head: a yellow anger burst with a red "!".
  // Hidden by default; faded in while the occupant overrides automation.
  const angryCanvas = document.createElement('canvas');
  angryCanvas.width = 256; angryCanvas.height = 256;
  const actx = angryCanvas.getContext('2d');
  actx.fillStyle = '#ffd23f';
  actx.beginPath();
  const cx = 128, cy = 128, spikes = 10;
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? 110 : 60;
    const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) actx.moveTo(x, y); else actx.lineTo(x, y);
  }
  actx.closePath();
  actx.fill();
  actx.strokeStyle = '#c9302c'; actx.lineWidth = 8; actx.stroke();
  actx.fillStyle = '#c9302c';
  actx.font = 'bold 130px sans-serif';
  actx.textAlign = 'center';
  actx.textBaseline = 'middle';
  actx.fillText('!', cx, cy + 8);
  const angryTex = new THREE.CanvasTexture(angryCanvas);
  const angrySprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: angryTex, transparent: true, opacity: 0, depthTest: false
  }));
  angrySprite.scale.set(0.45, 0.45, 1);
  angrySprite.position.set(0, torsoH + 0.06 + headR * 2 + 0.25, 0);
  angrySprite.renderOrder = 999;
  occupant.add(angrySprite);

  // Point the expression target at a named state (see EXPRESSIONS).  Cheap and
  // idempotent — just swaps the lerp target; the per-frame updateFace() eases
  // the visible pose toward it so transitions read as natural reactions.
  function setExpression(name) {
    const next = EXPRESSIONS[name] || EXPRESSIONS.neutral;
    if (face.tgt !== next) face.tgt = next;
  }

  // Ease the face toward its target and write the channel values onto the
  // facial meshes.  Called once per render frame.
  function updateFace() {
    const c = face.cur, t = face.tgt, k = 0.16;
    for (const key in c) c[key] += ((t[key] || 0) - c[key]) * k;
    face.browL.rotation.z = c.browLZ;
    face.browR.rotation.z = c.browRZ;
    face.browL.position.y = face.browBaseY + c.browY;
    face.browR.position.y = face.browBaseY + c.browY;
    const sq = c.squint;
    face.lidL.position.y = face.lidBaseY - sq * 0.044;
    face.lidR.position.y = face.lidBaseY - sq * 0.044;
    face.eyeL.scale.y = face.eyeR.scale.y = 1 - sq * 0.45;
    face.cornerL.position.y = face.cornerBaseY + c.cornerY;
    face.cornerR.position.y = face.cornerBaseY + c.cornerY;
    face.mouthOpen.material.opacity = c.open;
    face.mouthOpen.scale.y = 0.35 + c.open * 1.7;
    face.cheekWarmL.material.opacity = face.cheekWarmR.material.opacity = c.warm * 0.85;
    face.cheekColdL.material.opacity = face.cheekColdR.material.opacity = c.cold * 0.8;
    face.sweat.material.opacity = c.sweat;
    face.headGroup.rotation.z = c.tiltZ;
    face.headGroup.rotation.x = c.tiltX;
  }

  occupant.userData = {
    leftArm:  lArm.shoulder,
    rightArm: rArm.shoulder,
    leftElbow:  lArm.elbow,
    rightElbow: rArm.elbow,
    leftHip:   lLeg.hip,
    rightHip:  rLeg.hip,
    leftKnee:  lLeg.knee,
    rightKnee: rLeg.knee,
    posture: 0,
    reach: 0,
    basePos: new THREE.Vector3().copy(POS.seated),
    applyPosture,
    angrySprite,
    angryBaseY: torsoH + 0.06 + headR * 2 + 0.25,
    // Expressive-face engine (original avatar).
    face,
    setExpression,
    updateFace,
  };

  // Sit on the chair, facing the desk: desk is at world -X, so rotate +π/2
  // so the body's forward direction (-Z local) maps to world -X.  Legs and
  // arms swing forward in local -Z, also mapping to world -X (toward desk).
  occupant.position.set(POS.seated.x, SEAT_Y, POS.seated.z);
  occupant.rotation.y = Math.PI / 2;
  scene.add(occupant);
}

// Build the AC split unit and thermostat on the right wall.
function buildACAndThermostat() {
  const wallX = ROOM.w / 2;
  const unitZ = -1.50;
  const wallInner = wallX - 0.04; // inner face of right wall
  const acLen = 1.35; // along Z (parallel to wall)
  const acH = 0.36;
  const acDepth = 0.28; // sticks into room along -X

  // AC main body — horizontal split unit hanging on the right wall, sticking
  // into the room.  No Y rotation; geometry uses world axes directly.
  const acBody = new THREE.Mesh(
    new THREE.BoxGeometry(acDepth, acH, acLen),
    new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.4 })
  );
  acBody.position.set(wallInner - acDepth / 2, 2.85, unitZ);
  acBody.castShadow = true;
  scene.add(acBody);
  acUnitMesh = acBody;

  // Front face (camera side): slightly darker top trim with intake slits
  const trim = new THREE.Mesh(
    new THREE.BoxGeometry(acDepth + 0.005, 0.04, acLen + 0.005),
    new THREE.MeshStandardMaterial({ color: 0xdfe4ea, roughness: 0.5 })
  );
  trim.position.set(wallInner - acDepth / 2, 2.85 + acH / 2 - 0.02, unitZ);
  scene.add(trim);

  // Bottom louvre opening: a dark recessed slot beneath the body
  const louvreCavity = new THREE.Mesh(
    new THREE.BoxGeometry(acDepth - 0.06, 0.06, acLen - 0.10),
    new THREE.MeshStandardMaterial({ color: 0x1a1f24, roughness: 0.9 })
  );
  louvreCavity.position.set(wallInner - acDepth / 2, 2.85 - acH / 2 - 0.005, unitZ);
  scene.add(louvreCavity);

  // Animated louvre slats inside the cavity.  These tilt while the AC runs.
  acGrilleGroup = new THREE.Group();
  scene.add(acGrilleGroup);
  const numSlats = 5;
  for (let i = 0; i < numSlats; i++) {
    const slat = new THREE.Mesh(
      new THREE.BoxGeometry(acDepth - 0.08, 0.012, 0.16),
      new THREE.MeshStandardMaterial({ color: 0xc8d0d8, roughness: 0.5 })
    );
    const slatZ = unitZ - (acLen - 0.20) / 2 + (i + 0.5) * (acLen - 0.20) / numSlats;
    slat.position.set(wallInner - acDepth / 2, 2.85 - acH / 2 - 0.01, slatZ);
    acGrilleGroup.add(slat);
  }

  // LED indicator on the front-bottom-right of the body — pulses while running
  acLedMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.035, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0x00bfff, emissive: 0x00bfff, emissiveIntensity: 1.4, roughness: 0.2 })
  );
  acLedMesh.position.set(wallInner - acDepth - 0.005, 2.85 - acH / 2 + 0.06, unitZ + acLen / 2 - 0.10);
  scene.add(acLedMesh);

  // Airflow streams: thin cyan ribbons that descend from the louvre when the AC runs
  acAirflowGroup = new THREE.Group();
  scene.add(acAirflowGroup);
  for (let i = 0; i < 6; i++) {
    const stream = new THREE.Mesh(
      new THREE.PlaneGeometry(0.10, 0.55),
      new THREE.MeshBasicMaterial({
        color: 0x9fdcff, transparent: true, opacity: 0.0,
        side: THREE.DoubleSide, depthWrite: false
      })
    );
    const sZ = unitZ - (acLen - 0.30) / 2 + i * (acLen - 0.30) / 5;
    stream.position.set(wallInner - acDepth / 2, 2.85 - acH / 2 - 0.35, sZ);
    stream.rotation.y = Math.PI / 2;
    stream.userData.baseZ = sZ;
    stream.userData.phase = i * 0.6;
    acAirflowGroup.add(stream);
  }

  // Thermostat housing — larger and offset from wall so it is visible
  thermMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.08, 0.30, 0.22),
    new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.3 })
  );
  thermMesh.position.set(wallX - 0.13, 1.28, unitZ);
  thermMesh.rotation.y = -Math.PI / 2;
  scene.add(thermMesh);

  // Thermostat display canvas
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 320;
  const ctx = canvas.getContext('2d');
  drawThermDisplay(ctx, 22.0, 'COOL');
  thermDisplay = new THREE.CanvasTexture(canvas);
  thermDisplay.colorSpace = THREE.SRGBColorSpace;
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(0.20, 0.26),
    new THREE.MeshBasicMaterial({ map: thermDisplay })
  );
  screen.position.set(wallX - 0.17, 1.28, unitZ);
  screen.rotation.y = -Math.PI / 2;
  scene.add(screen);

  // Thermostat click target — generous plane facing the user
  const tGeo = new THREE.PlaneGeometry(0.70, 0.80);
  thermClickTarget = new THREE.Mesh(
    tGeo,
    new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
  );
  thermClickTarget.position.set(wallX - 0.25, 1.28, unitZ);
  thermClickTarget.rotation.y = -Math.PI / 2;
  thermClickTarget.userData.clickable = 'therm';
  scene.add(thermClickTarget);
}

// Draws the thermostat screen.  Called whenever the RL agent or
// occupant changes the setpoint.  Mode should be 'COOL' or 'HEAT'.
function drawThermDisplay(ctx, temp, mode) {
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, 256, 320);
  const modeColor = mode === 'COOL' ? '#00bfff'
                  : mode === 'HEAT' ? '#ff6b35'
                  : '#bbbbbb';
  ctx.fillStyle = modeColor;
  ctx.font = 'bold 48px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(temp == null ? 'OFF' : `${temp.toFixed(1)}°C`, 128, 120);
  ctx.fillStyle = '#aaaaaa';
  ctx.font = '28px monospace';
  ctx.fillText(mode, 128, 180);
  ctx.fillText('AUTO', 128, 230);
}

// Build the light switch on the right wall near the front of the room.
function buildLightSwitch() {
  const wallX = ROOM.w / 2;
  const z = 1.00;
  const y = 1.20;
  // Switch plate — protrudes clearly from the wall surface
  switchPlateMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.08, 0.20, 0.14),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 })
  );
  switchPlateMesh.position.set(wallX - 0.10, y, z);
  switchPlateMesh.rotation.y = -Math.PI / 2;
  scene.add(switchPlateMesh);
  // Rocker/lever — small box that tilts up/down
  switchLeverMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.045, 0.10, 0.07),
    new THREE.MeshStandardMaterial({ color: 0xfffde7, roughness: 0.35 })
  );
  switchLeverMesh.position.set(wallX - 0.155, y, z);
  switchLeverMesh.rotation.y = -Math.PI / 2;
  switchLeverMesh.rotation.z = -0.25;
  scene.add(switchLeverMesh);
  // Click target — generous area to make clicking easier
  const sGeo = new THREE.PlaneGeometry(0.55, 0.55);
  switchClickTarget = new THREE.Mesh(
    sGeo,
    new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
  );
  switchClickTarget.position.set(wallX - 0.22, y, z);
  switchClickTarget.rotation.y = -Math.PI / 2;
  switchClickTarget.userData.clickable = 'switch';
  scene.add(switchClickTarget);
  // Add a small label above the switch
  const labelCanvas = document.createElement('canvas');
  labelCanvas.width = 128;
  labelCanvas.height = 48;
  const lctx = labelCanvas.getContext('2d');
  lctx.fillStyle = '#ffffff';
  lctx.font = 'bold 18px monospace';
  lctx.textAlign = 'center';
  lctx.fillText('LIGHTS', 64, 32);
  const labelTex = new THREE.CanvasTexture(labelCanvas);
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(0.22, 0.08),
    new THREE.MeshBasicMaterial({ map: labelTex, transparent: true })
  );
  label.position.set(wallX - 0.155, y + 0.18, z);
  label.rotation.y = -Math.PI / 2;
  scene.add(label);
}

// Build a potted plant in the back‑left corner.  The pot consists of a
// base, rim and soil.  Several stems rise from the soil and support
// layered foliage.  Colours are earthy greens and browns to contrast
// with the room.
function buildPlant() {
  const cornerX = -ROOM.w / 2 + 0.55;
  const cornerZ = -ROOM.d / 2 + 0.55;
  // Pot base
  const potBase = new THREE.Mesh(
    new THREE.BoxGeometry(0.36, 0.32, 0.36),
    new THREE.MeshStandardMaterial({ color: 0x8b5e3c, roughness: 0.85 })
  );
  potBase.position.set(cornerX, 0.16, cornerZ);
  potBase.castShadow = potBase.receiveShadow = true;
  scene.add(potBase);
  // Pot rim
  const potRim = new THREE.Mesh(
    new THREE.BoxGeometry(0.42, 0.06, 0.42),
    new THREE.MeshStandardMaterial({ color: 0x7a5230, roughness: 0.8 })
  );
  potRim.position.set(cornerX, 0.34, cornerZ);
  potRim.castShadow = potRim.receiveShadow = true;
  scene.add(potRim);
  // Soil surface
  const soil = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.02, 0.34),
    new THREE.MeshStandardMaterial({ color: 0x3d2b1f, roughness: 0.95 })
  );
  soil.position.set(cornerX, 0.38, cornerZ);
  soil.castShadow = soil.receiveShadow = true;
  scene.add(soil);
  // Stems
  const stemMat = new THREE.MeshStandardMaterial({ color: 0x4a6741, roughness: 0.8 });
  const stems = [
    [0, 0, 1.1],
    [-0.08, 0.06, 0.9],
    [0.07, -0.05, 1.0],
  ];
  stems.forEach(([ox, oz, h]) => {
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.03, h, 7),
      stemMat
    );
    stem.position.set(cornerX + ox, 0.38 + h / 2, cornerZ + oz);
    stem.castShadow = true;
    scene.add(stem);
  });
  // Foliage
  const leafColors = [0x3a7d44, 0x4a9055, 0x2d6b38];
  const foliageDefs = [
    [0,     1.45, 0,     0.38, 0],
    [-0.12, 1.20, 0.08,  0.28, 1],
    [0.10,  1.30, -0.06, 0.30, 2],
    [0,     0.85, 0,     0.22, 1],
  ];
  foliageDefs.forEach(([ox, oy, oz, r, ci]) => {
    const leaf = new THREE.Mesh(
      new THREE.SphereGeometry(r, 9, 7),
      new THREE.MeshStandardMaterial({ color: leafColors[ci], roughness: 0.85 })
    );
    leaf.position.set(cornerX + ox, oy, cornerZ + oz);
    leaf.castShadow = true;
    scene.add(leaf);
  });
}

// Build a bookshelf against the left wall.  The unit has a back panel,
// three shelves, side panels and an assortment of colourful books.  A
// small ornament sits on the top shelf.
function buildBookshelf() {
  const wallX = -ROOM.w / 2 + 0.14;
  const shelfZ = 1.20;
  const shelfMat = new THREE.MeshStandardMaterial({ color: 0x7a5c3a, roughness: 0.75 });
  // Back panel
  const back = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 1.80, 1.10),
    shelfMat
  );
  back.position.set(wallX - 0.02, 1.10, shelfZ);
  back.castShadow = back.receiveShadow = true;
  scene.add(back);
  // Shelves
  const shelfYs = [0.30, 0.85, 1.40];
  shelfYs.forEach((y) => {
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.04, 1.10),
      shelfMat
    );
    board.position.set(wallX + 0.08, y, shelfZ);
    board.castShadow = board.receiveShadow = true;
    scene.add(board);
  });
  // Side panels
  const sideGeom = new THREE.BoxGeometry(0.22, 1.80, 0.06);
  const leftSide = new THREE.Mesh(sideGeom, shelfMat);
  leftSide.position.set(wallX + 0.08, 1.10, shelfZ - 0.52);
  leftSide.castShadow = leftSide.receiveShadow = true;
  scene.add(leftSide);
  const rightSide = leftSide.clone();
  rightSide.position.set(wallX + 0.08, 1.10, shelfZ + 0.52);
  scene.add(rightSide);
  // Books
  const bookColors = [
    0xc0392b, 0x2980b9, 0x27ae60, 0xe67e22, 0x8e44ad,
    0x16a085, 0xd35400, 0x2c3e50, 0xf39c12, 0x1abc9c,
    0x6c3483, 0x117a65, 0xcb4335, 0x1f618d, 0x239b56,
  ];
  let bookIndex = 0;
  shelfYs.forEach((y) => {
    let zOffset = -0.45;
    while (zOffset < 0.42) {
      const w  = 0.055 + Math.random() * 0.04;
      const h  = 0.18  + Math.random() * 0.12;
      const color = bookColors[bookIndex % bookColors.length];
      bookIndex++;
      const book = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, h, w),
        new THREE.MeshStandardMaterial({ color, roughness: 0.8 })
      );
      book.position.set(wallX + 0.13, y + h / 2 + 0.02, shelfZ + zOffset + w / 2);
      book.castShadow = book.receiveShadow = true;
      scene.add(book);
      zOffset += w + 0.008;
    }
  });
  // Ornament on the top shelf
  const ornament = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0xd4af37, roughness: 0.3, metalness: 0.6 })
  );
  ornament.position.set(wallX + 0.13, 1.40 + 0.04 + 0.07 + 0.04, shelfZ + 0.38);
  ornament.castShadow = true;
  scene.add(ornament);
}

// Update the lever orientation and colour based on switchOn boolean.
function updateSwitchVisual() {
  if (!switchLeverMesh) return;
  // Tilt and recolour the lever: up for ON (warm off‑white), down for OFF (gray).
  switchLeverMesh.rotation.z = switchOn ? -0.25 : 0.25;
  switchLeverMesh.material.color.setHex(switchOn ? 0xfffde7 : 0x8f8f8f);
  // Adjust all indoor lights when toggling the switch.  When OFF, the
  // ceiling light and room fill lights should emit no light at all.  A
  // small ambient hemisphere remains to avoid total darkness, but is
  // dimmed.  Also update the ceiling fixture appearance so it glows only
  // when the light is on.
  // Only toggle the artificial ceiling fixture.  Hemisphere & roomFillLight
  // are driven by updateDaylight (sun + shade), which already accounts for
  // switchOn for the sky-component contribution.
  if (ceilingLight) {
    ceilingLight.intensity = switchOn ? 0.95 : 0.0;
  }
  if (ceilingFixtureMesh && ceilingFixtureMesh.material) {
    ceilingFixtureMesh.material.emissiveIntensity = switchOn ? 0.6 : 0.0;
    ceilingFixtureMesh.material.color.setHex(switchOn ? 0xffffff : 0x888888);
  }
}

/* -----------------------------------------------------------------
 * Interaction and sequencing
 * ----------------------------------------------------------------- */

// Determine which device is under the pointer.  Returns a string
// identifier or null.
function getClickedDevice(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  // Shade
  if (raycaster.intersectObjects([shadeClickTarget, shadeHandle, shadeBottomBar], false).length > 0) {
    return 'shade';
  }
  // Thermostat
  if (thermClickTarget && raycaster.intersectObject(thermClickTarget, false).length > 0) {
    return 'therm';
  }
  // Switch
  if (switchClickTarget && raycaster.intersectObject(switchClickTarget, false).length > 0) {
    return 'switch';
  }
  return null;
}

function onPointerMove(event) {
  if (state !== 'idle') {
    renderer.domElement.style.cursor = 'default';
    return;
  }
  const device = getClickedDevice(event);
  renderer.domElement.style.cursor = device ? 'pointer' : 'default';
}

function onPointerDown(event) {
  if (state !== 'idle' || game.finished) return;
  const device = getClickedDevice(event);
  if (device === 'shade')       applyAction('shade');
  else if (device === 'therm')  applyAction('warmer');
  else if (device === 'switch') applyAction('lights');
}

/* -----------------------------------------------------------------
 * Player services (the "automation") — each writes one actuator
 * command to the simulation.  The occupant FSM decides whether to
 * accept it or stand up and override.  alignment scoring, feedback
 * and event logging are handled centrally in applyAction().
 * ----------------------------------------------------------------- */

const DOMAIN_COLOR = {
  Shading: 'var(--dom-shading)',
  HVAC: 'var(--dom-hvac)',
  Lighting: 'var(--dom-lighting)',
  'No action': 'var(--dom-none)',
};

const ACTIONS = [
  {
    id: 'shade', domain: 'Shading', target: 'shade',
    label: (s) => (s.shadePosition < 0.5 ? 'Lower shade' : 'Raise shade'),
    comfort: (s) => (s.shadePosition < 0.5 ? 'less glare / heat' : 'more daylight / view'),
    energy: (s) => (s.shadePosition < 0.5 ? '↓ cooling load' : '↑ solar gain'),
    run: () => { const c = getCommands(); setShadeCmd(c.shade > 0.4 ? 0.05 : 0.7); },
  },
  {
    id: 'warmer', domain: 'HVAC', target: 'thermostat',
    label: () => 'Warmer',
    comfort: () => '+ temperature',
    energy: () => '↑ heating',
    run: () => { const c = getCommands(); const cur = c.setpoint == null ? 22 : c.setpoint; setSetpointCmd(Math.min(26, cur + 2)); },
  },
  {
    id: 'cooler', domain: 'HVAC', target: 'thermostat',
    label: () => 'Cooler',
    comfort: () => '− temperature',
    energy: () => '↑ cooling',
    run: () => { const c = getCommands(); const cur = c.setpoint == null ? 22 : c.setpoint; setSetpointCmd(Math.max(18, cur - 2)); },
  },
  {
    id: 'hvac-off', domain: 'HVAC', target: 'thermostat',
    label: (s) => (s.thermostatSetpoint == null ? 'HVAC on' : 'HVAC off'),
    comfort: (s) => (s.thermostatSetpoint == null ? 'active control' : 'drifts to ambient'),
    energy: (s) => (s.thermostatSetpoint == null ? '↑ HVAC' : '↓↓ energy'),
    run: () => { const c = getCommands(); setSetpointCmd(c.setpoint == null ? 22 : null); },
  },
  {
    id: 'lights', domain: 'Lighting', target: 'lights',
    label: (s) => (s.lightsOn ? 'Lights off' : 'Lights on'),
    comfort: (s) => (s.lightsOn ? 'dimmer, softer' : 'brighter task light'),
    energy: (s) => (s.lightsOn ? '↓ lighting' : '↑ lighting'),
    run: () => { const c = getCommands(); setLightsCmd(!c.lights); },
  },
  {
    id: 'hold', domain: 'No action', target: null,
    label: () => 'Hold',
    comfort: () => 'unchanged',
    energy: () => 'unchanged',
    run: () => {},
  },
];

// id -> { btn, nameEl, comfortEl, energyEl, def }
const actionEls = new Map();

function renderActions(simState) {
  if (!actionsEl) return;
  actionsEl.innerHTML = '';
  actionEls.clear();
  ACTIONS.forEach((def) => {
    const btn = document.createElement('button');
    btn.className = 'action-card';
    btn.type = 'button';
    btn.dataset.action = def.id;

    const head = document.createElement('div');
    head.className = 'ac-head';
    const dot = document.createElement('span');
    dot.className = 'ac-dot';
    dot.style.background = DOMAIN_COLOR[def.domain];
    const name = document.createElement('span');
    name.className = 'ac-name';
    head.append(dot, name);

    // Domain sits on its own line below the title so it can never overlap the
    // action label, regardless of how long either string is.
    const domain = document.createElement('span');
    domain.className = 'ac-domain';
    domain.textContent = def.domain === 'No action' ? '' : def.domain;

    const effects = document.createElement('div');
    effects.className = 'ac-effects';
    const comfort = document.createElement('span');
    const energy = document.createElement('span');
    effects.append(comfort, energy);

    btn.append(head, domain, effects);
    btn.addEventListener('click', () => applyAction(def.id));
    actionsEl.appendChild(btn);
    actionEls.set(def.id, { btn, nameEl: name, comfortEl: comfort, energyEl: energy, def });
  });
  updateActionsState(simState);
}

function updateActionsState(simState) {
  const locked = game.finished || state !== 'idle';
  actionEls.forEach(({ btn, nameEl, comfortEl, energyEl, def }) => {
    nameEl.textContent = def.label(simState);
    comfortEl.innerHTML = `Comfort <b>${def.comfort(simState)}</b>`;
    energyEl.innerHTML = `Energy <b>${def.energy(simState)}</b>`;
    btn.disabled = locked;
  });
}

function applyAction(id) {
  if (game.finished || state !== 'idle') return;
  const def = ACTIONS.find((a) => a.id === id);
  if (!def) return;

  const before = getState();
  const riskBefore = before.occupant.patience01;
  const alignBefore = game.alignment;

  def.run();

  const after = getState();
  const overrode = after.occupant.state === 'overriding' || after.occupant.pendingTarget != null;

  let verdict;
  if (def.target == null) {
    verdict = before.occupant.discomfort < 0.15 ? 'aligned' : 'partial';
  } else {
    verdict = overrode ? 'misaligned' : 'aligned';
  }

  let delta;
  if (verdict === 'aligned') { delta = 6; game.aligned++; }
  else if (verdict === 'partial') { delta = -3; }
  else {
    delta = -12; game.misaligned++; game.overrides++;
    if (game.domainConflicts[def.domain] != null) game.domainConflicts[def.domain]++;
  }
  game.alignment = Math.max(0, Math.min(100, game.alignment + delta));
  game.actionsThisScenario++;

  const reason = buildReason(verdict, def);
  showFeedback(verdict, def, reason, delta, riskBefore, after.occupant.patience01, before);
  logEvent(def, before, after, verdict, alignBefore, game.alignment, riskBefore, after.occupant.patience01, reason);

  updateActionsState(after);
  updateHUD(after);
}

function buildReason(verdict, def) {
  const dom = def.domain.toLowerCase();
  if (verdict === 'misaligned') {
    return `Occupant rejected the ${dom} change and corrected it manually — that wasn't their preference.`;
  }
  if (verdict === 'partial') {
    return 'You held steady while the occupant was uneasy. Discomfort keeps building toward an override.';
  }
  if (def.target == null) {
    return 'Occupant is comfortable — holding was a safe, low-energy call.';
  }
  return `Occupant accepted the ${dom} change. You read their preference correctly.`;
}

function showFeedback(verdict, def, reason, delta, riskBefore, riskAfter, before) {
  const verdictText = verdict === 'aligned' ? 'Aligned'
    : verdict === 'partial' ? 'Partially aligned' : 'Misaligned';
  const rb = Math.round(riskBefore * 100), ra = Math.round(riskAfter * 100);

  // Record the decision — this is what reveals (and fills) the panel.
  game.lastDecision = { verdict, domain: def.domain, reason, delta, riskBefore: rb, riskAfter: ra };

  if (!fbPanelEl) return;
  fbPanelEl.hidden = false;
  fbPanelEl.classList.remove('aligned', 'partial', 'misaligned');
  fbPanelEl.classList.add(verdict);
  if (fbVerdictEl) fbVerdictEl.textContent = `${verdictText} · ${def.domain}`;
  if (fbReasonEl) fbReasonEl.textContent = reason;
  if (fbDeltaEl) fbDeltaEl.textContent = `${delta >= 0 ? '+' : ''}${delta} → ${Math.round(game.alignment)}`;
  if (fbRiskEl) fbRiskEl.textContent = `${rb}% → ${ra}%`;
}

function logEvent(def, before, after, verdict, alignBefore, alignAfter, riskBefore, riskAfter, reason) {
  game.log.push({
    scenario_id: game.scenario,
    timestamp: new Date().toISOString(),
    environmental_state: {
      temperature: Number(before.temperature.toFixed(2)),
      pmv: Number(before.pmv.toFixed(2)),
      co2: Math.round(before.co2),
      lux: Math.round(before.illuminance),
      humidity: Math.round(before.humidity),
      time_of_day: Number(before.timeOfDay.toFixed(2)),
    },
    action_selected: def.label(before),
    action_domain: def.domain,
    aligned: verdict === 'aligned',
    verdict,
    alignment_score_before: Math.round(alignBefore),
    alignment_score_after: Math.round(alignAfter),
    override_risk_before: Number(riskBefore.toFixed(3)),
    override_risk_after: Number(riskAfter.toFixed(3)),
    explanation: reason,
  });
}

/* -----------------------------------------------------------------
 * Scenario progression + end-of-session debrief.
 * ----------------------------------------------------------------- */
function maybeAdvanceScenario(simState) {
  if (game.finished || state !== 'idle') return;
  const satisfied = simState.occupant.state === 'idle' && simState.occupant.discomfort < 0.05;
  if (satisfied && game.actionsThisScenario > 0) {
    if (game.solvedAt === 0) game.solvedAt = performance.now();
    else if (performance.now() - game.solvedAt > 1200) advanceScenario();
  } else {
    game.solvedAt = 0;
  }
}

function advanceScenario() {
  game.solvedAt = 0;
  game.actionsThisScenario = 0;
  if (game.scenario >= TOTAL_SCENARIOS) { finishSession(); return; }
  game.scenario++;
  resetScenario();
  setStatus(`scenario ${game.scenario} of ${TOTAL_SCENARIOS} — new occupant, new preferences`);
}

function dominantConflict() {
  let dom = 'None', max = 0;
  for (const k of Object.keys(game.domainConflicts)) {
    if (game.domainConflicts[k] > max) { max = game.domainConflicts[k]; dom = k; }
  }
  return dom;
}

function automationStyle(dom) {
  if (game.overrides === 0 || game.alignment >= 90) return 'Occupant-aligned';
  if (dom === 'HVAC') return 'Comfort-first';
  if (dom === 'Lighting') return 'Energy-saving but intrusive';
  if (dom === 'Shading') return 'Glare-sensitive';
  return 'Occupant-aligned';
}

function finishSession() {
  game.finished = true;
  updateActionsState(getState());
  const dom = dominantConflict();
  if (sumScoreEl) sumScoreEl.textContent = String(Math.round(game.alignment));
  if (sumStyleEl) sumStyleEl.textContent = automationStyle(dom);
  if (sumDetailEl) {
    sumDetailEl.innerHTML =
      `<b>${game.aligned}</b> decisions accepted, <b>${game.misaligned}</b> overridden across ` +
      `${TOTAL_SCENARIOS} occupants. Dominant tension domain: <b>${dom}</b>.`;
  }
  if (summaryEl) summaryEl.classList.add('show');
  setStatus('session complete');
}

function restartSession() {
  game.scenario = 1;
  game.alignment = 100;
  game.aligned = 0;
  game.misaligned = 0;
  game.overrides = 0;
  game.domainConflicts = { Shading: 0, HVAC: 0, Lighting: 0 };
  game.actionsThisScenario = 0;
  game.solvedAt = 0;
  game.finished = false;
  game.lastDecision = null;
  game.log = [];
  resetScenario();
  if (summaryEl) summaryEl.classList.remove('show');
  if (fbPanelEl) {
    // No decision yet → hide the panel entirely (no empty "—" chips).
    fbPanelEl.hidden = true;
    fbPanelEl.classList.remove('aligned', 'partial', 'misaligned');
  }
  setStatus('waiting for interaction');
  const s = getState();
  updateActionsState(s);
  updateHUD(s);
}

// Sequence for roller shade: RL lowers shade; occupant stands, walks to
// window, raises shade and returns.
/* -----------------------------------------------------------------
 * Occupant override animations.  Triggered by the FSM in dataSource
 * when patience runs out.  At the "reach" frame we commit the
 * occupant's hidden preference into the actuator command, so the
 * rest of the simulation immediately uses the new value.
 * ----------------------------------------------------------------- */

function startOverrideAnim(target) {
  if (target === 'shade')           playShadeOverride();
  else if (target === 'thermostat') playThermOverride();
  else if (target === 'lights')     playLightsOverride();
}

function playShadeOverride() {
  clear();
  setButtons(false);
  state = 'overriding';
  setStatus('occupant gets up — shade');
  animatePosture(0, 1, 850, () => {
    setStatus('occupant walks to the window');
    animateMovePath([POS.standDesk, POS.aisle, POS.windowApproach, POS.window], 2200, () => {
      setStatus('occupant adjusts the shade');
      animateReach(0, 1, 350, () => {
        applyOccupantOverride('shade');
        reportOccupantOverride('shade', 'pref');
        animateReach(1, 0, 350, () => {
          setStatus('occupant returns to desk');
          animateMovePath([POS.window, POS.windowApproach, POS.aisle, POS.standDesk], 2200, () => {
            animatePosture(1, 0, 850, finishOverride);
          });
        });
      });
    });
  });
}

function playThermOverride() {
  clear();
  setButtons(false);
  state = 'overriding';
  setStatus('occupant gets up — thermostat');
  animatePosture(0, 1, 850, () => {
    setStatus('occupant walks to the thermostat');
    animateMovePath([POS.standDesk, POS.aisle, POS.thermAisle, POS.thermApproach], 2200, () => {
      setStatus('occupant adjusts the thermostat');
      animateReach(0, 1, 400, () => {
        applyOccupantOverride('thermostat');
        reportOccupantOverride('thermostat', 'pref');
        animateReach(1, 0, 400, () => {
          setStatus('occupant returns to desk');
          animateMovePath([POS.thermApproach, POS.thermAisle, POS.aisle, POS.standDesk], 2200, () => {
            animatePosture(1, 0, 850, finishOverride);
          });
        });
      });
    });
  });
}

function playLightsOverride() {
  clear();
  setButtons(false);
  state = 'overriding';
  setStatus('occupant gets up — lights');
  animatePosture(0, 1, 850, () => {
    setStatus('occupant walks to the light switch');
    animateMovePath([POS.standDesk, POS.aisle, POS.switchAisle, POS.switchApproach], 2000, () => {
      setStatus('occupant flips the switch');
      animateReach(0, 1, 400, () => {
        applyOccupantOverride('lights');
        reportOccupantOverride('lights', 'pref');
        animateReach(1, 0, 400, () => {
          setStatus('occupant returns to desk');
          animateMovePath([POS.switchApproach, POS.switchAisle, POS.aisle, POS.standDesk], 2000, () => {
            animatePosture(1, 0, 850, finishOverride);
          });
        });
      });
    });
  });
}

function finishOverride() {
  endOverride();
  state = 'idle';
  setStatus('waiting for interaction');
  setButtons(true);
}

/* -----------------------------------------------------------------
 * Animation helpers
 * ----------------------------------------------------------------- */

// Add a new animation task to the queue
function addAnimation({ duration, update, onComplete }) {
  animations.push({
    start: performance.now(),
    duration,
    update,
    onComplete
  });
}

// Clear all pending animations
function clear() {
  animations.length = 0;
}

// Animate shade fabric to target scale.y
function animateShadeTo(target, duration, onComplete) {
  const startScale = shadeFabric.scale.y;
  addAnimation({
    duration,
    update: (t) => {
      const eased = easeInOutCubic(t);
      shadeFabric.scale.y = THREE.MathUtils.lerp(startScale, target, eased);
      updateShadeBar();
    },
    onComplete
  });
}

// Animate occupant posture (0–1).  Adjust posture property; y position
// will be applied in animateMovePath via occupant.userData.posture.
function animatePosture(from, to, duration, onComplete) {
  addAnimation({
    duration,
    update: (t) => {
      const eased = easeInOutCubic(t);
      occupant.userData.posture = THREE.MathUtils.lerp(from, to, eased);
    },
    onComplete
  });
}

// Animate occupant reach (0–1).  Arms rotate to simulate reaching.
function animateReach(from, to, duration, onComplete) {
  addAnimation({
    duration,
    update: (t) => {
      const eased = easeInOutCubic(t);
      occupant.userData.reach = THREE.MathUtils.lerp(from, to, eased);
      updateArms();
    },
    onComplete: () => {
      // ensure final arms rotation
      updateArms();
      if (onComplete) onComplete();
    }
  });
}

function updateArms() {
  const r = occupant.userData.reach || 0;
  // raise arms: 0 = down, 1 = up
  occupant.userData.leftArm.rotation.z = -0.5 * r;
  occupant.userData.rightArm.rotation.z =  0.5 * r;
}

// Move occupant along a path of waypoints over a duration.  The
// occupant's base position is stored in userData.basePos; posture is
// applied as a vertical offset.
function animateMovePath(path, duration, onComplete) {
  // Precompute segment lengths
  const segLen = [];
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const d = path[i].distanceTo(path[i + 1]);
    segLen.push(d);
    total += d;
  }
  occupant.userData.walking = true;
  addAnimation({
    duration,
    update: (t) => {
      // distance along entire path
      const s = t * total;
      let acc = 0;
      let i = 0;
      while (i < segLen.length && acc + segLen[i] < s) {
        acc += segLen[i];
        i++;
      }
      const segmentFraction = segLen[i] === 0 ? 0 : (s - acc) / segLen[i];
      const start = path[i].clone();
      const end   = path[i + 1].clone();
      occupant.userData.basePos.copy(start.lerp(end, segmentFraction));
      // Face direction of motion: body's forward is local -Z, so atan2 + π
      const dir = end.clone().sub(start);
      if (dir.lengthSq() > 1e-6) {
        const yaw = Math.atan2(dir.x, dir.z);
        occupant.rotation.y = yaw + Math.PI;
      }
      // Vertical position: lerp between seated (SEAT_Y) and standing (STAND_Y)
      const basePos = occupant.userData.basePos;
      const p = occupant.userData.posture;
      const y = SEAT_Y + (STAND_Y - SEAT_Y) * p;
      occupant.position.set(basePos.x, y, basePos.z);
    },
    onComplete: () => {
      occupant.userData.walking = false;
      occupant.userData.stride = 0;
      if (onComplete) onComplete();
    }
  });
}

/* -----------------------------------------------------------------
 * Render loop
 * ----------------------------------------------------------------- */

function animate() {
  requestAnimationFrame(animate);
  const simState = getState();
  // Legacy generic "angry burst" sprite is retired: it fired on any tiny
  // discomfort (>0.05) and showed a star even when the occupant was content.
  // The single type-matched head bubble (statusBubble) now carries all cues,
  // so keep this sprite permanently faded out.
  if (occupant && occupant.userData.angrySprite) {
    const sprite = occupant.userData.angrySprite;
    sprite.material.opacity += (0 - sprite.material.opacity) * 0.2;
  }
  // Apply current posture (jointed limbs) every frame so seated/standing pose
  // holds even when no movement animation is active.  Drive a stride swing
  // while walking.
  if (occupant && occupant.userData.applyPosture) {
    occupant.userData.stride = occupant.userData.walking
      ? Math.sin(performance.now() * 0.012) * 0.7
      : 0;
    occupant.userData.applyPosture(occupant.userData.posture);
    // Y position: keep occupant on chair when posture==0
    const basePos = occupant.userData.basePos;
    const p = occupant.userData.posture;
    const y = SEAT_Y + (STAND_Y - SEAT_Y) * p;
    occupant.position.set(basePos.x, y, basePos.z);
  }
  // Drive the avatar's facial expression from the same derived comfort state
  // the HUD/head-bubble use, then ease the face toward it.
  if (occupant && occupant.userData.setExpression) {
    occupant.userData.setExpression(expressionForUi(deriveUiState(simState), simState));
    occupant.userData.updateFace();
  }
  // Drive device visuals from the simulation state so the player can see
  // their commands take effect (and watch the IEQ react).
  if (shadeFabric) {
    shadeFabric.scale.y = simState.shadePosition;
    updateShadeBar();
  }
  if (switchOn !== simState.lightsOn) {
    switchOn = simState.lightsOn;
    updateSwitchVisual();
  }
  if (acRunning !== simState.acRunning) {
    updateACVisual(simState.acRunning);
  }
  updateThermDisplay(simState.thermostatSetpoint, simState.thermostatMode);

  // FSM watcher: when the occupant decides to override and we're idle,
  // kick off the corresponding walk-and-reach animation.
  if (state === 'idle' && simState.occupant.pendingTarget) {
    startOverrideAnim(simState.occupant.pendingTarget);
  }

  // Advance the scenario once the current occupant is satisfied.
  maybeAdvanceScenario(simState);
  // Update HUD, diagnosis, action availability and scene cues.
  updateHUD(simState);
  updateActionsState(simState);
  // Update daylight (sun position, sky colour, ambient lighting) based
  // on the current time of day and the state of the light switch.
  updateDaylight(simState);

  const now = performance.now();
  // Process queued animation tasks.  Each task runs for its specified
  // duration and is removed when complete.  This drives the occupant
  // walking, shade movement and reaching animations.
  for (let i = animations.length - 1; i >= 0; i--) {
    const anim = animations[i];
    const t = Math.min(1, (now - anim.start) / anim.duration);
    anim.update(t);
    if (t >= 1) {
      animations.splice(i, 1);
      if (anim.onComplete) anim.onComplete();
    }
  }
  // AC louvre animation: oscillate slats while the AC is running to
  // give a subtle sense of airflow.  The group contains all slats
  // added in buildACAndThermostat().
  if (acGrilleGroup) {
    const angle = acRunning ? Math.sin(now * 0.002) * 0.45 : 0;
    acGrilleGroup.children.forEach((slat) => {
      slat.rotation.x = angle;
    });
  }
  // Airflow streams: fade & drift downward while running.  Colour is
  // driven by AC mode — blue for cooling, orange for heating, white when
  // the AC is idle.
  if (acAirflowGroup) {
    const mode = simState.thermostatMode;
    const flowColor = mode === 'COOL' ? 0x9fdcff
                    : mode === 'HEAT' ? 0xffb070
                    : 0xffffff;
    acAirflowGroup.children.forEach((stream) => {
      stream.material.color.setHex(flowColor);
      if (acRunning) {
        const phase = (now * 0.0018 + stream.userData.phase) % 1;
        stream.position.y = 2.85 - 0.36 / 2 - 0.05 - phase * 0.85;
        stream.material.opacity = (1 - phase) * 0.55;
      } else {
        stream.material.opacity = 0;
      }
    });
  }
  // LED pulse + colour while running.  Cool → blue, heat → orange, off → dim.
  if (acLedMesh) {
    const mode = simState.thermostatMode;
    if (acRunning) {
      const ledColor = mode === 'HEAT' ? 0xff6b35 : 0x00bfff;
      acLedMesh.material.color.setHex(ledColor);
      acLedMesh.material.emissive.setHex(ledColor);
      const pulse = 0.9 + Math.sin(now * 0.006) * 0.5;
      acLedMesh.material.emissiveIntensity = pulse;
    }
  }
  // Render the scene from the current camera viewpoint.  The camera
  // remains locked so the user cannot pan or zoom.
  renderer.render(scene, camera);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

/* -----------------------------------------------------------------
 * Utility functions
 * ----------------------------------------------------------------- */

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function setStatus(text) {
  if (statusEl) statusEl.textContent = `Status: ${text}`;
}

// Enable or disable all action cards.  When an override animation is
// running (or the session is over) all input is disabled to prevent
// overlapping sequences.
function setButtons(enabled) {
  actionEls.forEach(({ btn }) => {
    btn.disabled = !enabled || game.finished;
  });
}

function updateThermDisplay(temp, mode) {
  const canvas = thermDisplay?.image;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  drawThermDisplay(ctx, temp, mode);
  thermDisplay.needsUpdate = true;
}

// Update the AC unit visual state.  When the AC is running, the LED
// glows bright blue and the slats gently oscillate to suggest airflow.
// When off, the LED dims and slats remain stationary.  The acRunning
// flag is toggled here and read in the animate() loop.
function updateACVisual(on) {
  acRunning = on;
  if (!acLedMesh) return;
  // LED colour and emissive power
  acLedMesh.material.color.setHex(on ? 0x00bfff : 0x334444);
  acLedMesh.material.emissive.setHex(on ? 0x00bfff : 0x000000);
  acLedMesh.material.emissiveIntensity = on ? 1.2 : 0.0;
}

// Classify the room's primary issue from live metrics.  Returns a small
// descriptor used by both the diagnosis card and the occupant bubble.
function diagnose(simState) {
  const shadeUp = simState.shadePosition < 0.5;
  const glare = simState.illuminance > 2500 && shadeUp;
  if (glare) {
    return {
      key: 'glare', bubble: 'Too bright',
      issue: 'Strong daylight is reaching the workstation — glare risk is high while the shade is up.',
      priority: 'Visual comfort', conflict: 'Glare vs. daylight & view',
    };
  }
  if (simState.occupant.thermal === 'warm') {
    return {
      key: 'warm', bubble: 'Too warm',
      issue: 'The space is above the comfort band — cool it with the AC (lower the setpoint) and lower the shade to block solar gain.',
      priority: 'Thermal comfort', conflict: 'Cooling vs. energy use',
    };
  }
  if (simState.occupant.thermal === 'cold') {
    return {
      key: 'cold', bubble: 'Too cold',
      issue: 'The space is below the comfort band — warm it with the AC (raise the setpoint) and raise the shade to admit solar gain.',
      priority: 'Thermal comfort', conflict: 'Heating vs. energy use',
    };
  }
  if (simState.co2 > 900) {
    return {
      key: 'stuffy', bubble: 'Stuffy',
      issue: 'CO₂ is elevated — air feels stale near the desk.',
      priority: 'Air quality', conflict: 'Fresh air vs. thermal stability',
    };
  }
  return {
    key: 'ok', bubble: 'Comfortable',
    issue: 'Conditions are within the comfort band. Hold, or fine-tune a service.',
    priority: 'Maintain comfort', conflict: 'Comfort vs. energy use',
  };
}

// Visual vocabulary for the floating head cue, keyed by cueType from
// deriveUiState().  Glyph + colour are matched to the source of discomfort.
// Comfortable / mildly-uneasy states map to no cueType, so nothing floats.
const CUE_VISUAL = {
  glare:    { text: '☀ Too bright',    bg: 'rgba(192,138,42,0.94)' },
  warm:     { text: '♨ Too warm',      bg: 'rgba(194,90,47,0.94)' },
  cold:     { text: '❄ Too cold',      bg: 'rgba(47,110,170,0.94)' },
  air:      { text: '≋ Stuffy',        bg: 'rgba(110,120,70,0.94)' },
  annoyed:  { text: '• Annoyed',       bg: 'rgba(192,138,42,0.94)' },
  override: { text: '⚠ Would override', bg: 'rgba(194,73,47,0.94)' },
};

/*
 * Single source of truth for every player-facing label.  All HUD panels read
 * from this one derived object so the occupant state, override risk, situation
 * card, bubble and 3D cue can never contradict each other.
 *
 * Concepts (kept explicit per the design):
 *   - occupant state   : whether the occupant is comfortable / uneasy / overriding
 *   - currentIssue     : the specific problem, or 'none'
 *   - overrideRisk     : probability the occupant rejects the current setup
 *                        (occupant-only — NOT energy)
 *   - lastDecision     : result of the last action (drives the feedback panel)
 *   - alignmentScore   : accumulated score (read directly from game.alignment)
 *
 * Rule: "Risk = what may happen before action.  Alignment = accumulated score
 * from past decisions.  Last decision = result after the user acts."
 */
function deriveUiState(simState) {
  const occ = simState.occupant;
  const d = diagnose(simState);

  // Severity bucket from the OCCUPANT — authoritative for whether anything is
  // wrong.  The environment diagnosis only names the issue once one exists.
  let bucket;
  if (occ.state === 'overriding')                       bucket = 'override';
  else if (occ.state === 'annoyed' || occ.discomfort >= 0.25) bucket = 'bad';
  else if (occ.discomfort >= 0.10)                      bucket = 'mild';
  else                                                  bucket = 'ok';

  // Override risk derived from patience, but clamped to agree with the bucket
  // so the gauge never says "High" while the occupant looks comfortable.
  let riskFraction = occ.patience01;
  if (bucket === 'ok')         riskFraction = Math.min(riskFraction, 0.18);
  else if (bucket === 'mild')  riskFraction = Math.min(Math.max(riskFraction, 0.22), 0.50);
  else if (bucket === 'bad')   riskFraction = Math.max(riskFraction, 0.45);
  else                         riskFraction = 1.0;
  const overrideRisk = riskFraction < 0.20 ? 'Low' : riskFraction < 0.55 ? 'Medium' : 'High';

  // Comfortable defaults.
  let occupantState = 'Comfortable', stateClass = '';
  let bubbleText = null, cueType = null, currentIssue = null;
  let situationHeadline = 'Conditions are within the comfort band. Holding is reasonable.';
  let likelyPriority = 'Maintain comfort';
  let conflict = 'Comfort vs. energy';

  if (bucket === 'override') {
    occupantState = 'Overriding you'; stateClass = 'is-override';
    bubbleText = CUE_VISUAL.override.text; cueType = 'override';
    currentIssue = 'Override in progress';
    situationHeadline = 'The occupant is correcting a setting you chose.';
    likelyPriority = 'Restore their setting';
    conflict = 'Your command vs. their preference';
  } else if (bucket === 'mild') {
    occupantState = 'Settling'; stateClass = '';
    bubbleText = 'Acceptable'; cueType = null;   // mild unease shows no floating symbol
    currentIssue = 'Minor unease';
    situationHeadline = 'Conditions are acceptable but not ideal. A small adjustment may help.';
    likelyPriority = 'Fine-tune comfort';
  } else if (bucket === 'bad') {
    occupantState = 'Uneasy'; stateClass = 'is-annoyed';
    switch (d.key) {
      case 'glare':
        bubbleText = CUE_VISUAL.glare.text; cueType = 'glare'; currentIssue = 'Glare risk';
        situationHeadline = 'Strong daylight is reaching the workstation — glare risk is high.';
        likelyPriority = 'Visual comfort'; conflict = 'Glare vs. daylight & view'; break;
      case 'warm':
        bubbleText = CUE_VISUAL.warm.text; cueType = 'warm'; currentIssue = 'Too warm';
        situationHeadline = 'Above the comfort band — cool with the AC and lower the shade.';
        likelyPriority = 'Thermal comfort'; conflict = 'Cooling vs. energy'; break;
      case 'cold':
        bubbleText = CUE_VISUAL.cold.text; cueType = 'cold'; currentIssue = 'Too cold';
        situationHeadline = 'Below the comfort band — warm with the AC and raise the shade.';
        likelyPriority = 'Thermal comfort'; conflict = 'Heating vs. energy'; break;
      case 'stuffy':
        bubbleText = CUE_VISUAL.air.text; cueType = 'air'; currentIssue = 'Poor air';
        situationHeadline = 'CO₂ is rising — the air near the desk is getting stuffy.';
        likelyPriority = 'Air quality'; conflict = 'Fresh air vs. thermal stability'; break;
      default:
        // Occupant is annoyed by a hidden-preference mismatch the environment
        // metrics don't flag (e.g. wants the thermostat off at a neutral temp).
        bubbleText = CUE_VISUAL.annoyed.text; cueType = 'annoyed'; currentIssue = 'Setting mismatch';
        situationHeadline = 'The occupant is unsettled by one of your current settings.';
        likelyPriority = 'Find their preference'; conflict = 'Automation vs. preference'; break;
    }
  }

  return {
    occupantState, stateClass, currentIssue,
    bubbleText, cueType,
    situationHeadline, likelyPriority, conflict,
    overrideRisk, riskFraction,
    showLastDecision: !!game.lastDecision,
  };
}

// Update the heads‑up display with live simulation metrics, alignment
// scoring, the diagnosis card and the 3D scene cues.  Called every frame;
// does not mutate the simulation.
function updateHUD(simState) {
  if (!simState) return;
  const occ = simState.occupant;

  // --- Metric chips ---
  const hrs = Math.floor(simState.timeOfDay);
  const mins = Math.floor((simState.timeOfDay % 1) * 60);
  if (valTimeEl) valTimeEl.textContent = `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
  if (valPmvEl) {
    valPmvEl.textContent = simState.pmv.toFixed(2);
    valPmvEl.className = 'chip-value' + (Math.abs(simState.pmv) > 0.5 ? ' warn' : '');
  }
  if (valTempEl) valTempEl.textContent = `${simState.temperature.toFixed(1)}°C`;
  if (valCo2El) {
    valCo2El.textContent = `${Math.round(simState.co2)}ppm`;
    valCo2El.className = 'chip-value' + (simState.co2 > 900 ? ' warn' : '');
  }
  if (valLuxEl) {
    valLuxEl.textContent = `${Math.round(simState.illuminance)}`;
    valLuxEl.className = 'chip-value' + (simState.illuminance > 2500 ? ' warn' : '');
  }
  if (valHumEl) valHumEl.textContent = `${Math.round(simState.humidity)}%`;

  // --- Actuator chips ---
  const shadePct = Math.round(shadeFabric.scale.y * 100);
  if (valShadeEl) valShadeEl.textContent = shadePct >= 50 ? 'Down' : 'Up';
  if (valLightsEl) valLightsEl.textContent = switchOn ? 'On' : 'Off';
  if (valAcEl) valAcEl.textContent = acRunning ? 'ON' : 'OFF';
  if (valThermEl) {
    valThermEl.textContent = simState.thermostatSetpoint == null
      ? 'Off'
      : `${simState.thermostatSetpoint.toFixed(0)}°C`;
  }

  // --- Single source of truth for every player-facing label ---
  const ui = deriveUiState(simState);

  // --- Occupant state chip + issue chip ---
  if (occStateEl) {
    occStateEl.classList.remove('is-annoyed', 'is-override');
    occStateEl.textContent = ui.occupantState;
    if (ui.stateClass) occStateEl.classList.add(ui.stateClass);
  }
  if (occIssueEl) {
    if (ui.currentIssue) {
      occIssueEl.textContent = ui.currentIssue;
      occIssueEl.hidden = false;
    } else {
      occIssueEl.hidden = true;
    }
  }
  // Mode badge is static — the player is always the automation.  Dynamic
  // occupant mood lives in the occupant chip, so the badge no longer duplicates it.

  // --- Alignment + override-risk gauges ---
  if (alignScoreEl) alignScoreEl.textContent = String(Math.round(game.alignment));
  if (alignMarkerEl) alignMarkerEl.style.left = `${Math.max(0, Math.min(100, game.alignment))}%`;
  if (riskFillEl) {
    const p = ui.riskFraction;
    riskFillEl.style.width = `${Math.round(p * 100)}%`;
    riskFillEl.style.background = p < 0.2 ? 'var(--green)' : p < 0.55 ? 'var(--amber)' : 'var(--red)';
  }
  if (riskValEl) riskValEl.textContent = ui.overrideRisk;

  // --- Scenario counter ---
  if (scnNowEl) scnNowEl.textContent = String(game.scenario);
  if (scnOverridesEl) scnOverridesEl.textContent = String(game.overrides);

  // --- Situation card (state-generated) ---
  if (diagIssueEl) diagIssueEl.textContent = ui.situationHeadline;
  if (diagPriorityEl) diagPriorityEl.textContent = ui.likelyPriority;
  if (diagRiskEl) diagRiskEl.textContent = ui.overrideRisk;
  if (diagConflictEl) diagConflictEl.textContent = ui.conflict;

  // --- Feedback panel visibility: only once the player has acted ---
  if (fbPanelEl) fbPanelEl.hidden = !ui.showLastDecision;

  // --- 3D scene cues (state-specific; silent when comfortable) ---
  if (statusBubble) {
    const cue = ui.cueType ? CUE_VISUAL[ui.cueType] : null;
    const mat = statusBubble.sprite.material;
    if (cue) statusBubble.setText(cue.text, cue.bg);
    mat.opacity += ((cue ? 1 : 0) - mat.opacity) * 0.12;
  }
  if (glareSprite) {
    // The desk glare marker only lights when glare is the active issue, so it
    // never appears for a comfortable occupant or a non-visual problem.
    const glareOn = ui.cueType === 'glare' ? 1 : 0;
    glareSprite.material.opacity += (glareOn - glareSprite.material.opacity) * 0.1;
  }
}

// Update daylight conditions based on the current time of day.  The
// sun's position, intensity and colour change smoothly throughout
// the day.  The sky colour and ambient lighting are also adjusted.
function updateDaylight(simState) {
  if (!sunLight || !simState) return;
  const t = simState.timeOfDay;
  // Daylight curve over working hours (8–18). Peaks at midday.
  const daylightFactor = (t - 6) / 14;          // 0 at 6am, 1 at 8pm
  const angle = daylightFactor * Math.PI;
  const sunCurve = Math.max(0, Math.sin(angle));
  // Sun travels east → west across the sky.  Always behind the south wall.
  const sunX = -Math.cos(angle) * 5;
  const sunY = Math.sin(angle) * 10;
  sunLight.position.set(sunX, Math.max(1.5, sunY), -14);
  // Sun colour: warm at dawn/dusk, neutral midday
  const warmth = 1 - sunCurve;
  sunLight.color.setRGB(1.0,
    Math.min(1, 0.95 - warmth * 0.20),
    Math.min(1, 0.88 - warmth * 0.35));

  // Shade transmission: fully open shade lets all sun in; closed blocks ~92%.
  const shade = simState.shadePosition;          // 0 open, 1 fully closed
  const transmission = 1 - 0.92 * shade;
  // When the artificial lights are on, drop the direct-sun contribution a bit
  // so interior fill competes with it and shadows on the shelf/plant soften.
  const sunDirectScale = switchOn ? 0.7 : 1.0;
  sunLight.intensity = 2.6 * sunCurve * transmission * sunDirectScale;

  // Skylight (hemisphere): contributes ambient daylight, slightly dimmed by
  // closed shade and significantly dimmed when artificial lights are off and
  // sun is low.  When lights are ON, add a flat ambient lift so the room
  // looks more homogeneously lit (less directional contrast on shelves/plant).
  if (hemisphereLight) {
    const skyBase = 0.18 + 0.30 * sunCurve * (1 - 0.5 * shade);
    const onLift = switchOn ? 0.45 : 0.0;
    hemisphereLight.intensity = skyBase * (switchOn ? 1.0 : 0.55) + onLift;
  }
  // Warm fill at the window: represents sun bouncing off floor/walls.
  // Scales strongly with sun*transmission.  Boosted slightly when the
  // ceiling light is on to wash out hard shadows.
  if (roomFillLight) {
    roomFillLight.intensity = 0.8 * sunCurve * transmission + (switchOn ? 0.35 : 0.0);
  }

  // Sunbeam pool on the floor: opacity & position track the sun.
  if (sunbeamMesh) {
    sunbeamMesh.material.opacity = 0.55 * sunCurve * transmission;
    // Drift the pool along the floor as the sun moves east→west.
    const beamX = -sunX * 0.18;
    const beamZ = -1.4 + (1 - sunCurve) * 1.2;
    sunbeamMesh.position.set(beamX, 0.005, beamZ);
    // Stretch the pool when the sun is low (long shadows).
    const stretch = 1 + (1 - sunCurve) * 1.4;
    sunbeamMesh.scale.set(1, stretch, 1);
  }

  // Sky colour stays daytime blue during office hours.
  if (skyMesh && skyMesh.material) {
    skyMesh.material.color.setHex(0x9bd4f0);
  }
}

/* -----------------------------------------------------------------
 * Bootstrap — run last so all module-level const declarations
 * (ACTIONS, DOMAIN_COLOR, actionEls, …) are initialised first.
 * ----------------------------------------------------------------- */
init();
animate();
