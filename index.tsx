
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { NavLine } from './NavLine.js';

// --- Scene Setup ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111111);
// 添加一点雾效增强纵深感
scene.fog = new THREE.FogExp2(0x111111, 0.002);

// --- Camera (Z-Up Setup) ---
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
// 放在 Z 轴上方俯视
camera.position.set(0, -100, 100); 
camera.up.set(0, 0, 1); // Z 轴向上

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
controls.maxPolarAngle = Math.PI / 2 - 0.1; // 防止相机钻入地下

// --- Helpers ---
// Grid Helper: 在 XY 平面
const gridHelper = new THREE.GridHelper(500, 50, 0x444444, 0x222222);
gridHelper.rotation.x = Math.PI / 2; // 旋转到 XY 平面
scene.add(gridHelper);

const axesHelper = new THREE.AxesHelper(10);
scene.add(axesHelper);

// --- Navigation Path ---
// 定义一组 Z-Up 的路径点
const pathPoints = [
    new THREE.Vector3(-80, -80, 0),
    new THREE.Vector3(-20, -60, 0),
    new THREE.Vector3(20, -20, 10), // 上坡
    new THREE.Vector3(50, 0, 10),   // 高架
    new THREE.Vector3(80, 50, 0),   // 下坡
    new THREE.Vector3(20, 80, 0),
    new THREE.Vector3(-50, 50, 0),
    new THREE.Vector3(-80, 0, 0)
];

// --- 模拟交通拥堵数据 ---
const trafficData = [
    { start: 0.0, end: 0.2, color: new THREE.Color(0x00ff00) }, // 畅通
    { start: 0.2, end: 0.4, color: new THREE.Color(0xffcc00) }, // 缓行
    { start: 0.4, end: 0.6, color: new THREE.Color(0xff0000) }, // 拥堵 (高架段)
    { start: 0.6, end: 0.8, color: new THREE.Color(0xffcc00) }, // 缓行
    { start: 0.8, end: 1.0, color: new THREE.Color(0x00ff00) }, // 畅通
];

// --- Create NavLine ---
const navLine = new NavLine(scene, pathPoints, {
    width: 24.0,       // 屏幕像素宽度
    arrowSpacing: 10,  // 箭头间距 (米)
    speed: 10,         // 速度 (米/秒)
    trafficData: trafficData,
    zOffset: 0.5,      // 稍微抬高防止与 Grid 重叠
    cornerRadius: 15   // 圆角半径
});

// --- Mock Environment (Optional) ---
// 添加一些简单的柱子作为参照物
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

// --- Resize Handler ---
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    
    // NavLine 需要感知分辨率变化以维持恒定像素宽度
    navLine.update(0); 
});

animate();
