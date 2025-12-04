import * as THREE from 'three';
import { createRoundedPath } from './RoundedPath.js';

// --- 模块级单例：纹理缓存 ---
let _cachedArrowTexture = null;

function getArrowTexture(anisotropy = 16) {
    if (_cachedArrowTexture) return _cachedArrowTexture;

    // 提高分辨率以获得更精细的效果
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, size, size);

    const padding = size * 0.2;
    const h = size - padding * 2;
    const cy = size / 2;

    // 绘制更锐利的箭头
    ctx.strokeStyle = 'white';
    ctx.lineWidth = size * 0.15;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    // 稍微调整箭头形状使其更紧凑
    ctx.beginPath();
    ctx.moveTo(padding, cy - h * 0.35);
    ctx.lineTo(size - padding, cy);
    ctx.lineTo(padding, cy + h * 0.35);
    ctx.stroke();

    const texture = new THREE.CanvasTexture(canvas);
    // 使用线性滤镜减少缩小时的闪烁
    texture.minFilter = THREE.LinearMipMapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.anisotropy = anisotropy;
    
    _cachedArrowTexture = texture;
    return texture;
}

/**
 * NavLine 类
 * 实现了屏幕空间宽度的导航线，并且箭头的间隔也是屏幕空间均匀的。
 */
export class NavLine {
    constructor(scene, points, config = {}) {
        this.scene = scene;
        this.originalPoints = points; // 保存原始拐点
        
        // 合并配置
        this.config = Object.assign({
            width: 20.0,         // [屏幕像素] 线宽
            arrowSpacing: 60.0,  // [屏幕像素] 箭头间距 (注意单位变化！)
            speed: 2.0,          // [屏幕像素/帧] 流动速度 (改为像素单位更易控，或者保留米/秒并在update转换)
            trafficData: [],
            zOffset: 0.5,
            cornerRadius: 15.0
        }, config);

        // 速度我们还是保留米/秒的逻辑，但在 update 中我们会动态计算它对应的像素速度
        // 或者简单点，我们让 speed 代表 "流动快慢系数"
        
        if (config.yOffset !== undefined) {
            this.config.zOffset = config.yOffset;
        }

        this.mesh = null;
        this.material = null;
        this._accumulatedTime = 0; // 这里的 Time 我们将累积为“屏幕像素偏移量”
        this._resolution = new THREE.Vector2(window.innerWidth, window.innerHeight);
        
        // 缓存生成的中心路径点，用于 CPU 投影计算
        this._curvePoints = [];

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
                uSpacing: { value: this.config.arrowSpacing }, // Pixels
                uOffset: { value: 0 }, // Pixels (Animation)
                uResolution: { value: this._resolution },
            },
            vertexShader: `
                uniform vec2 uResolution;
                uniform float uWidth;
                
                attribute vec3 aTangent;
                attribute vec2 aOffset; // x: side, y: forward
                attribute float aScreenDist; // 预计算的屏幕距离 (Pixels)
                attribute vec3 aColor;      // 顶点颜色
                attribute float aIsCap;
                
                varying vec2 vUv;
                varying vec3 vColor;
                varying float vScreenDist;
                varying float vIsCap;

                void main() {
                    vUv = uv;
                    vColor = aColor;
                    vScreenDist = aScreenDist;
                    vIsCap = aIsCap;
                    
                    // 1. Clip Space
                    vec4 clipCenter = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    vec4 clipTangent = projectionMatrix * modelViewMatrix * vec4(position + aTangent, 1.0);

                    // 2. NDC
                    vec2 ndcCenter = clipCenter.xy / clipCenter.w;
                    vec2 ndcTangent = clipTangent.xy / clipTangent.w;

                    // 3. Screen Space Tangent & Normal
                    vec2 screenDir = normalize((ndcTangent - ndcCenter) * uResolution);
                    vec2 screenNormal = vec2(-screenDir.y, screenDir.x);

                    // 4. Pixel Offset
                    vec2 pixelOffset = (screenNormal * aOffset.x + screenDir * aOffset.y) * uWidth * 0.5;

                    // 5. Back to Clip Delta
                    vec2 clipOffset = (pixelOffset * 2.0 / uResolution) * clipCenter.w;

                    gl_Position = clipCenter;
                    gl_Position.xy += clipOffset;
                }
            `,
            fragmentShader: `
                uniform sampler2D uTexture;
                uniform float uWidth;
                uniform float uSpacing;
                uniform float uOffset;
                
                varying vec2 vUv;
                varying vec3 vColor;
                varying float vScreenDist;
                varying float vIsCap;

                void main() {
                    vec3 finalColor = vColor;
                    vec3 white = vec3(1.0);
                    
                    // --- 1. 高质量抗锯齿边缘 (Anti-Aliased Edge) ---
                    // 使用 fwidth 计算当前像素对应的 UV 变化率，实现完美的 smoothstep
                    float distY = abs(vUv.y - 0.5) * 2.0; // 0 (center) -> 1 (edge)
                    
                    // 线条边缘虚化宽度 (对应约 1.5 像素)
                    float edgeWidth = fwidth(vUv.y) * 1.5; 
                    
                    // 身体部分的边缘 alpha
                    float bodyAlpha = 1.0 - smoothstep(1.0 - edgeWidth, 1.0, distY);
                    
                    // 圆头部分的边缘 alpha
                    if (vIsCap > 0.5) {
                        float r = length(vUv);
                        float capEdge = fwidth(r) * 1.5;
                        bodyAlpha = 1.0 - smoothstep(1.0 - capEdge, 1.0, r);
                    }

                    // 如果完全透明则丢弃 (优化)
                    if (bodyAlpha < 0.01) discard;

                    // --- 2. 屏幕空间箭头纹理 ---
                    float arrowLayer = 0.0;
                    
                    // 仅在身体部分绘制箭头 (vIsCap == 0)
                    if (vIsCap < 0.5) {
                        // 计算当前像素在循环中的位置 (Pixels)
                        // vScreenDist 是屏幕像素距离，uOffset 是动画偏移
                        float currentDist = vScreenDist - uOffset;
                        float distInCycle = mod(currentDist, uSpacing);
                        
                        // 箭头的视觉尺寸设为线宽 (保持正方形比例)
                        float arrowSize = uWidth;
                        
                        // 居中显示
                        float halfGap = (uSpacing - arrowSize) * 0.5;
                        
                        // 归一化纹理 X 坐标
                        float texX = (distInCycle - halfGap) / arrowSize;
                        
                        // 采样纹理
                        if (texX > 0.0 && texX < 1.0) {
                            float texAlpha = texture2D(uTexture, vec2(texX, vUv.y)).a;
                            
                            // 同样使用 fwidth 对纹理内容进行抗锯齿，防止远处闪烁
                            float texEdge = fwidth(texAlpha) * 1.0;
                            arrowLayer = smoothstep(0.5 - texEdge, 0.5 + texEdge, texAlpha);
                        }
                    }

                    // --- 3. 颜色混合 ---
                    vec3 c = mix(vColor, white, arrowLayer);
                    gl_FragColor = vec4(c, bodyAlpha);
                }
            `,
            transparent: true,
            vertexColors: false, // 我们自己传递 aColor
            side: THREE.DoubleSide,
            extensions: {
                derivatives: true // 必须启用，用于 fwidth
            }
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
        const totalLen = curve.getLength();
        // 增加采样密度以保证投影精度
        const segments = Math.max(200, Math.floor(totalLen * 5)); 
        const points = curve.getSpacedPoints(segments);
        this._curvePoints = points; // 保存用于 update 投影
        const count = points.length;

        // Arrays
        const positions = [];
        const tangents = [];
        const offsets = []; 
        const uvs = [];
        const colors = [];
        const screenDists = []; // 初始全为0，由 update 填充
        const isCaps = [];
        const indices = [];

        let vertexIndex = 0;

        // --- Helper: Add Cap ---
        const addCap = (center, direction, color) => {
            const capSegments = 32; // 增加段数让圆头更圆
            const tanX = direction.x;
            const tanY = direction.y;
            const tanZ = direction.z;

            // Center Vertex
            positions.push(center.x, center.y, center.z + zOffset);
            tangents.push(tanX, tanY, tanZ);
            offsets.push(0, 0); 
            uvs.push(0, 0);
            colors.push(color.r, color.g, color.b);
            screenDists.push(0); // Cap 的 screenDist 设为0或继承端点，这里暂存占位
            isCaps.push(1);
            
            const centerIdx = vertexIndex++;

            for (let i = 0; i <= capSegments; i++) {
                const theta = -Math.PI / 2 + (Math.PI * i) / capSegments;
                const sin = Math.sin(theta); // Right/Side
                const cos = Math.cos(theta); // Forward

                positions.push(center.x, center.y, center.z + zOffset);
                tangents.push(tanX, tanY, tanZ);
                offsets.push(sin, cos); 
                uvs.push(sin, cos);
                colors.push(color.r, color.g, color.b);
                screenDists.push(0);
                isCaps.push(1);

                if (i > 0) {
                    indices.push(centerIdx, vertexIndex - 1, vertexIndex);
                }
                vertexIndex++;
            }
        };

        const startTangent = new THREE.Vector3().subVectors(points[1], points[0]).normalize();
        const endTangent = new THREE.Vector3().subVectors(points[count-1], points[count-2]).normalize();

        // 1. Start Cap (Arrow pointing OUT -> tangent negated)
        // 注意：之前的逻辑修复了 Cap 朝向，这里保持一致
        addCap(points[0], startTangent.clone().negate(), this._getColor(0, trafficData));

        // 2. Body
        // 我们记录 Body 顶点的起始索引，方便后续 update 更新 screenDist
        this._bodyVertexStart = vertexIndex;
        this._bodyVertexCount = count * 2;

        for (let i = 0; i < count; i++) {
            let tangent;
            if (i === 0) tangent = startTangent;
            else if (i === count-1) tangent = endTangent;
            else tangent = new THREE.Vector3().subVectors(points[i+1], points[i-1]).normalize();

            const c = this._getColor(i / (count - 1), trafficData);

            // Left
            positions.push(points[i].x, points[i].y, points[i].z + zOffset);
            tangents.push(tangent.x, tangent.y, tangent.z);
            offsets.push(1, 0);
            uvs.push(0, 0); // u:0=Left
            colors.push(c.r, c.g, c.b);
            screenDists.push(0); // 待更新
            isCaps.push(0);

            // Right
            positions.push(points[i].x, points[i].y, points[i].z + zOffset);
            tangents.push(tangent.x, tangent.y, tangent.z);
            offsets.push(-1, 0);
            uvs.push(0, 1); // u:0=Right (vUv.y used for gradient) - Wait, uv.y is width.
            // Shader uses abs(vUv.y - 0.5). So lets map 0..1
            // Left: 0, Right: 1. Center is 0.5.
            colors.push(c.r, c.g, c.b);
            screenDists.push(0); // 待更新
            isCaps.push(0);

            if (i < count - 1) {
                const base = this._bodyVertexStart + i * 2;
                indices.push(base, base+1, base+2);
                indices.push(base+1, base+3, base+2);
            }
            vertexIndex += 2;
        }

        // 3. End Cap
        addCap(points[count-1], endTangent, this._getColor(1, trafficData));

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('aTangent', new THREE.Float32BufferAttribute(tangents, 3));
        geometry.setAttribute('aOffset', new THREE.Float32BufferAttribute(offsets, 2));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geometry.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3));
        geometry.setAttribute('aScreenDist', new THREE.Float32BufferAttribute(screenDists, 1));
        geometry.setAttribute('aIsCap', new THREE.Float32BufferAttribute(isCaps, 1));
        geometry.setIndex(indices);

        // 为了防止剔除（因为顶点Shader会大幅偏移顶点），设大包围球
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

    /**
     * 更新导航线状态
     * @param {number} deltaTime 时间增量
     * @param {THREE.Camera} camera 相机对象 (必须提供，用于计算屏幕距离)
     */
    update(deltaTime, camera) {
        if (!this.mesh || !this.material) return;
        
        // 1. 更新动画偏移
        // 假设 speed 是 "像素/秒" (例如 60 px/s)
        const pxSpeed = 100.0; 
        this._accumulatedTime += deltaTime * pxSpeed; 
        this.material.uniforms.uOffset.value = this._accumulatedTime;

        // 2. 更新分辨率
        this._resolution.set(window.innerWidth, window.innerHeight);
        this.material.uniforms.uResolution.value.copy(this._resolution);

        // 3. [关键] 计算屏幕空间距离 (Screen Space Distance)
        if (camera) {
            this._updateScreenDistances(camera);
        }
    }

    _updateScreenDistances(camera) {
        const points = this._curvePoints;
        const count = points.length;
        const width = window.innerWidth;
        const height = window.innerHeight;
        const halfW = width / 2;
        const halfH = height / 2;

        const screenDistAttr = this.mesh.geometry.attributes.aScreenDist;
        const array = screenDistAttr.array;
        
        // 投影向量缓存
        const vec = new THREE.Vector3();
        
        let accumulatedDist = 0;
        let prevScreenPos = new THREE.Vector2();
        let prevValid = false;

        for (let i = 0; i < count; i++) {
            // 复制点坐标并应用视图矩阵
            vec.copy(points[i]);
            vec.applyMatrix4(camera.matrixWorldInverse); 
            
            // 检查点是否在相机后面 (View Space 中, 相机看向 -Z, 所以 Z > 0 是后面)
            // 留一点 buffer (-0.1) 避免近裁面的闪烁
            const isBehind = vec.z > -0.1;
            
            // 投影到 NDC
            vec.applyMatrix4(camera.projectionMatrix); 

            // 计算屏幕坐标
            const screenX = vec.x * halfW + halfW;
            const screenY = vec.y * halfH + halfH;

            // 如果点在相机后面，我们不累加距离，但我们需要填充属性以防 crash
            // 更重要的是，如果当前点或上一个点在相机后面，两点之间的屏幕距离是无效的
            if (i > 0) {
                if (!isBehind && prevValid) {
                    const dx = screenX - prevScreenPos.x;
                    const dy = screenY - prevScreenPos.y;
                    const dist = Math.sqrt(dx*dx + dy*dy);
                    accumulatedDist += dist;
                } else {
                    // 如果跨越了相机平面，或者在后面，保持距离不变
                    // 这会“冻结”不可见部分的纹理坐标，防止无限大数值导致整个纹理闪烁
                }
            }

            prevScreenPos.set(screenX, screenY);
            prevValid = !isBehind;

            // 更新 Mesh 属性
            const idx = this._bodyVertexStart + i * 2;
            array[idx] = accumulatedDist;
            array[idx + 1] = accumulatedDist;
        }

        screenDistAttr.needsUpdate = true;
    }

    setArrowSpacing(px) {
        this.config.arrowSpacing = px;
        this.material.uniforms.uSpacing.value = px;
    }

    dispose() {
        if (this.mesh) {
            this.scene.remove(this.mesh);
            this.mesh.geometry.dispose();
        }
        if (this.material) this.material.dispose();
    }
}