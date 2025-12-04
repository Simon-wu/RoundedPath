import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { NavLine } from './NavLine.js';

// --- Scene Setup ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdddddd);
scene.fog = new THREE.FogExp2(0x111111, 0.002);

// --- Camera ---
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(0, -100, 100); 
camera.up.set(0, 0, 1);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

// --- Controls ---
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.screenSpacePanning = false;
controls.minDistance = 10;
controls.maxDistance = 500;
controls.maxPolarAngle = Math.PI / 2 - 0.1;

// --- Helpers ---
const gridHelper = new THREE.GridHelper(500, 50, 0x444444, 0x222222);
gridHelper.rotation.x = Math.PI / 2;
scene.add(gridHelper);

const axesHelper = new THREE.AxesHelper(10);
scene.add(axesHelper);

// --- Path ---
const pathPoints = [
    new THREE.Vector3(-80, -80, 0),
    new THREE.Vector3(-20, -60, 0),
    new THREE.Vector3(20, -20, 10),
    new THREE.Vector3(50, 0, 10), 
    new THREE.Vector3(80, 50, 0), 
    new THREE.Vector3(20, 80, 0),
    new THREE.Vector3(-50, 50, 0),
    new THREE.Vector3(-80, 0, 0)
];

const trafficData = [
    { start: 0.0, end: 0.2, color: new THREE.Color(0xff0000) },
    { start: 0.2, end: 0.4, color: new THREE.Color(0xffcc00) },
    { start: 0.4, end: 0.6, color: new THREE.Color(0xff0000) },
    { start: 0.6, end: 0.8, color: new THREE.Color(0xffcc00) },
    { start: 0.8, end: 1.0, color: new THREE.Color(0xff0000) },
];

// --- Create NavLine ---
const navLine = new NavLine(scene, pathPoints, {
    width: 20.0,       // 屏幕像素宽度
    arrowSpacing: 10.0, // 世界单位(米)间距
    speed: 18.0,        // 米/秒
    trafficData: trafficData,
    zOffset: 0.5,
    cornerRadius: 15
});

// --- GUI Controller ---
const gui = new GUI();
const settings = {
    lodBias: 1.0,
    spacing: 10.0
};

gui.add(settings, 'lodBias', 0.1, 3.0)
    .name('LOD Fade (Cleanliness)')
    .onChange(v => navLine.setLodBias(v));

gui.add(settings, 'spacing', 5.0, 30.0)
    .name('Arrow Spacing (m)')
    .onChange(v => navLine.setArrowSpacing(v));

// --- Mock Environment ---
const boxGeo = new THREE.BoxGeometry(2, 2, 10);
const boxMat = new THREE.MeshBasicMaterial({ color: 0x333333 });
for(let i=0; i<5; i++) {
    const mesh = new THREE.Mesh(boxGeo, boxMat);
    mesh.position.set(Math.random()*100 - 50, Math.random()*100 - 50, 5);
    scene.add(mesh);
}

// --- Animation Loop ---
const clock = new THREE.Clock();

function animate() {
    requestAnimationFrame(animate);
    
    const delta = clock.getDelta();
    
    controls.update();
    
    navLine.update(delta);
    
    renderer.render(scene, camera);
}

// --- Resize ---
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    navLine.update(0); 
});

animate();