import * as THREE from 'three';
import { createRoundedPath } from './RoundedPath.js';

// --- 模块级单例：纹理缓存 ---
let _cachedArrowTexture = null;

function getArrowTexture(anisotropy = 16) {
    if (_cachedArrowTexture) return _cachedArrowTexture;

    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, size, size);

    // 绘制箭头
    // 为了适应 1:1 的正方形比例，我们调整箭头的大小和位置
    const padding = size * 0.15;
    const w = size - padding * 2;
    const h = size - padding * 2;
    const cx = size / 2;
    const cy = size / 2;

    ctx.strokeStyle = 'white';
    ctx.lineWidth = size * 0.15; // 加粗一点
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    // 画一个标准的向右箭头
    ctx.beginPath();
    // 顶点
    const headX = size - padding;
    const tailX = padding;
    const arrowWidth = h * 0.6; // 箭头张开的宽度

    ctx.moveTo(tailX, cy - arrowWidth * 0.6);
    ctx.lineTo(headX, cy);
    ctx.lineTo(tailX, cy + arrowWidth * 0.6);
    ctx.stroke();

    const texture = new THREE.CanvasTexture(canvas);
    // 使用线性滤镜，保证缩放平滑
    texture.minFilter = THREE.LinearMipMapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    // 关键：边缘截断，防止 UV 计算溢出时出现杂色
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.anisotropy = anisotropy;
    
    _cachedArrowTexture = texture;
    return texture;
}

export class NavLine {
    constructor(scene, points, config = {}) {
        this.scene = scene;
        this.originalPoints = points;
        
        this.config = Object.assign({
            width: 20.0,         // [屏幕像素] 线宽 (也是箭头的大小)
            arrowSpacing: 10.0,  // [世界单位/米] 箭头中心之间的物理间距
            speed: 5.0,          // [米/秒] 流动速度
            trafficData: [],
            zOffset: 0.5,
            cornerRadius: 15.0
        }, config);

        if (config.yOffset !== undefined) {
            this.config.zOffset = config.yOffset;
        }

        this.mesh = null;
        this.material = null;
        this._accumulatedTime = 0;
        this._resolution = new THREE.Vector2(window.innerWidth, window.innerHeight);
        
        this._init();
    }

    _init() {
        const maxAnisotropy = this.scene.renderer 
            ? this.scene.renderer.capabilities.getMaxAnisotropy() 
            : 16;
        const texture = getArrowTexture(maxAnisotropy); 

        this.material = new THREE.ShaderMaterial({
            uniforms: {
                uTexture: { value: texture },
                uWidth: { value: this.config.width }, // Pixels
                uSpacing: { value: this.config.arrowSpacing }, // Meters
                uOffset: { value: 0 }, // Meters
                uResolution: { value: this._resolution },
                uLodBias: { value: 1.0 } // 1.0 = Default, Higher = Cleaner (Fades sooner), Lower = Busier
            },
            vertexShader: `
                uniform vec2 uResolution;
                uniform float uWidth;
                
                attribute vec3 aTangent;
                attribute vec2 aOffset;
                attribute float aPathDist; // 世界路径距离 (Meters)
                attribute vec3 aColor;
                attribute float aIsCap;
                
                varying vec2 vUv;
                varying vec3 vColor;
                varying float vPathDist;
                varying float vIsCap;

                void main() {
                    vUv = uv;
                    vColor = aColor;
                    vPathDist = aPathDist;
                    vIsCap = aIsCap;
                    
                    // Standard Screen-Space Line extrusion
                    vec4 clipCenter = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    vec4 clipTangent = projectionMatrix * modelViewMatrix * vec4(position + aTangent, 1.0);

                    vec2 ndcCenter = clipCenter.xy / clipCenter.w;
                    vec2 ndcTangent = clipTangent.xy / clipTangent.w;

                    vec2 screenDir = normalize((ndcTangent - ndcCenter) * uResolution);
                    vec2 screenNormal = vec2(-screenDir.y, screenDir.x);

                    vec2 pixelOffset = (screenNormal * aOffset.x + screenDir * aOffset.y) * uWidth * 0.5;
                    vec2 clipOffset = (pixelOffset * 2.0 / uResolution) * clipCenter.w;

                    gl_Position = clipCenter;
                    gl_Position.xy += clipOffset;
                }
            `,
            fragmentShader: `
                uniform sampler2D uTexture;
                uniform float uWidth;   // Line Width in Pixels
                uniform float uSpacing; // Arrow Spacing in Meters
                uniform float uOffset;  // Animation Offset in Meters
                uniform float uLodBias; // Bias for LOD fading
                
                varying vec2 vUv;
                varying vec3 vColor;
                varying float vPathDist;
                varying float vIsCap;

                void main() {
                    // --- 1. 线条边缘抗锯齿 ---
                    float distY = abs(vUv.y - 0.5) * 2.0;
                    float edgeWidth = fwidth(vUv.y) * 1.5;
                    float bodyAlpha = 1.0 - smoothstep(1.0 - edgeWidth, 1.0, distY);

                    // 圆头处理
                    if (vIsCap > 0.5) {
                        float r = length(vUv);
                        float capEdge = fwidth(r) * 1.5;
                        bodyAlpha = 1.0 - smoothstep(1.0 - capEdge, 1.0, r);
                    }
                    if (bodyAlpha < 0.01) discard;

                    // --- 2. 箭头渲染 (核心逻辑修复) ---
                    float arrowAlpha = 0.0;
                    
                    if (vIsCap < 0.5) {
                        // 计算当前像素代表多少米 (Meters Per Pixel)
                        // fwidth(vPathDist) 告诉我们路径距离随屏幕像素变化的速度
                        float mpp = fwidth(vPathDist);
                        // 避免除以零
                        mpp = max(mpp, 0.0001);

                        // 确定当前位置相对于最近箭头的距离
                        float currentDist = vPathDist - uOffset;
                        // 计算该点属于第几个箭头周期
                        float cycle = floor(currentDist / uSpacing + 0.5);
                        // 最近箭头的中心位置 (Meters)
                        float centerDist = cycle * uSpacing;
                        // 当前像素距离箭头中心的物理距离 (Meters)
                        float distMeters = currentDist - centerDist;
                        
                        // 将物理距离转换为屏幕像素距离
                        float distPixels = distMeters / mpp;

                        // 计算纹理坐标
                        // 我们希望箭头在屏幕上占据 uWidth 个像素宽
                        // 所以 distPixels 在 [-uWidth/2, uWidth/2] 范围内时显示箭头
                        // 映射到 UV [0, 1]
                        float texX = 0.5 + distPixels / uWidth;

                        // --- LOD (细节层次) ---
                        // 计算两个箭头在屏幕上的像素间距
                        float spacingPixels = uSpacing / mpp;
                        
                        // 计算 LOD 阈值
                        // 默认: 当间距小于 1.2倍线宽时开始淡出，大于 2.5倍时完全显示
                        // 乘以 uLodBias: 
                        //   Bias 大 -> 需要更大的间距才显示 -> 箭头更早消失 (更干净)
                        //   Bias 小 -> 允许更小的间距 -> 箭头更晚消失 (更密集)
                        float minSpacing = uWidth * 1.2 * uLodBias;
                        float maxSpacing = uWidth * 2.5 * uLodBias;
                        
                        float lodFade = smoothstep(minSpacing, maxSpacing, spacingPixels);

                        // 只有在纹理范围内且 LOD 允许时才采样
                        if (texX >= 0.0 && texX <= 1.0 && lodFade > 0.01) {
                            // 采样纹理 Alpha
                            float texA = texture2D(uTexture, vec2(texX, vUv.y)).a;
                            arrowAlpha = texA * lodFade;
                        }
                    }

                    // --- 3. 合成颜色 ---
                    vec3 finalColor = mix(vColor, vec3(1.0), arrowAlpha);
                    gl_FragColor = vec4(finalColor, bodyAlpha);
                }
            `,
            transparent: true,
            side: THREE.DoubleSide,
            extensions: { derivatives: true }
        });

        this._buildGeometry();
    }

    _buildGeometry() {
        if (this.mesh) {
            this.scene.remove(this.mesh);
            this.mesh.geometry.dispose();
        }

        const { trafficData, zOffset, cornerRadius } = this.config;
        
        const curve = createRoundedPath(this.originalPoints, cornerRadius);
        const points = curve.getSpacedPoints(Math.floor(curve.getLength() * 2));
        const count = points.length;

        const positions = [];
        const tangents = [];
        const offsets = []; 
        const uvs = [];
        const colors = [];
        const pathDists = []; 
        const isCaps = [];
        const indices = [];

        let vertexIndex = 0;

        // 计算累积世界距离
        const dists = [0];
        for(let i=1; i<count; i++) {
            dists.push(dists[i-1] + points[i].distanceTo(points[i-1]));
        }

        const addCap = (center, direction, color, dist) => {
            const capSegments = 16;
            const tanX = direction.x;
            const tanY = direction.y;
            const tanZ = direction.z;

            // Cap Center
            positions.push(center.x, center.y, center.z + zOffset);
            tangents.push(tanX, tanY, tanZ);
            offsets.push(0, 0); 
            uvs.push(0, 0);
            colors.push(color.r, color.g, color.b);
            pathDists.push(dist); 
            isCaps.push(1);
            
            const centerIdx = vertexIndex++;

            for (let i = 0; i <= capSegments; i++) {
                const theta = -Math.PI / 2 + (Math.PI * i) / capSegments;
                const sin = Math.sin(theta); 
                const cos = Math.cos(theta); 

                positions.push(center.x, center.y, center.z + zOffset);
                tangents.push(tanX, tanY, tanZ);
                offsets.push(sin, cos); 
                uvs.push(sin, cos);
                colors.push(color.r, color.g, color.b);
                pathDists.push(dist);
                isCaps.push(1);

                if (i > 0) indices.push(centerIdx, vertexIndex - 1, vertexIndex);
                vertexIndex++;
            }
        };

        const startTangent = new THREE.Vector3().subVectors(points[1], points[0]).normalize();
        const endTangent = new THREE.Vector3().subVectors(points[count-1], points[count-2]).normalize();

        // Caps
        addCap(points[0], startTangent.clone().negate(), this._getColor(0, trafficData), dists[0]);
        
        // Body
        for (let i = 0; i < count; i++) {
            let tangent;
            if (i === 0) tangent = startTangent;
            else if (i === count-1) tangent = endTangent;
            else tangent = new THREE.Vector3().subVectors(points[i+1], points[i-1]).normalize();

            const c = this._getColor(i / (count - 1), trafficData);
            const d = dists[i];

            // Left
            positions.push(points[i].x, points[i].y, points[i].z + zOffset);
            tangents.push(tangent.x, tangent.y, tangent.z);
            offsets.push(1, 0);
            uvs.push(0, 0); 
            colors.push(c.r, c.g, c.b);
            pathDists.push(d);
            isCaps.push(0);

            // Right
            positions.push(points[i].x, points[i].y, points[i].z + zOffset);
            tangents.push(tangent.x, tangent.y, tangent.z);
            offsets.push(-1, 0);
            uvs.push(0, 1);
            colors.push(c.r, c.g, c.b);
            pathDists.push(d);
            isCaps.push(0);

            if (i < count - 1) {
                const base = vertexIndex;
                indices.push(base, base+1, base+2);
                indices.push(base+1, base+3, base+2);
                vertexIndex += 2;
            }
        }
        vertexIndex += 2;

        addCap(points[count-1], endTangent, this._getColor(1, trafficData), dists[count-1]);

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('aTangent', new THREE.Float32BufferAttribute(tangents, 3));
        geometry.setAttribute('aOffset', new THREE.Float32BufferAttribute(offsets, 2));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geometry.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3));
        geometry.setAttribute('aPathDist', new THREE.Float32BufferAttribute(pathDists, 1));
        geometry.setAttribute('aIsCap', new THREE.Float32BufferAttribute(isCaps, 1));
        geometry.setIndex(indices);
        geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10000);

        this.mesh = new THREE.Mesh(geometry, this.material);
        this.mesh.frustumCulled = false; 
        this.scene.add(this.mesh);
    }

    _getColor(progress, trafficData) {
        if (!trafficData || trafficData.length === 0) return new THREE.Color(0x00ff00);
        for (let seg of trafficData) {
            if (progress >= seg.start && progress <= seg.end) return seg.color;
        }
        return trafficData[trafficData.length-1].color;
    }

    update(deltaTime) {
        if (!this.mesh || !this.material) return;
        
        this._accumulatedTime += deltaTime * this.config.speed;
        this.material.uniforms.uOffset.value = this._accumulatedTime;

        this._resolution.set(window.innerWidth, window.innerHeight);
        this.material.uniforms.uResolution.value.copy(this._resolution);
    }
    
    setLodBias(value) {
        if(this.material) this.material.uniforms.uLodBias.value = value;
    }

    setArrowSpacing(value) {
        this.config.arrowSpacing = value;
        if(this.material) this.material.uniforms.uSpacing.value = value;
    }

    dispose() {
        if (this.mesh) {
            this.scene.remove(this.mesh);
            this.mesh.geometry.dispose();
        }
        if (this.material) this.material.dispose();
    }
}