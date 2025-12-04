import * as THREE from 'three';
import { createRoundedPath } from './RoundedPath.js';

// --- 模块级单例：纹理缓存 ---
let _cachedArrowTexture = null;

function getArrowTexture(anisotropy = 16) {
    if (_cachedArrowTexture) return _cachedArrowTexture;

    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, size, size);

    const padding = size * 0.15;
    const h = size - padding * 2;
    const cy = size / 2;

    ctx.strokeStyle = 'white';
    ctx.lineWidth = size * 0.12;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(padding, cy - h * 0.4);
    ctx.lineTo(size - padding, cy);
    ctx.lineTo(padding, cy + h * 0.4);
    ctx.stroke();

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.anisotropy = anisotropy;
    
    _cachedArrowTexture = texture;
    return texture;
}

/**
 * NavLine 类 (Screen Space Width / Z-Up)
 * 宽度单位为屏幕像素，纹理单位为世界米
 */
export class NavLine {
    constructor(scene, points, config = {}) {
        this.scene = scene;
        this.points = points;
        
        // 合并配置
        this.config = Object.assign({
            width: 20.0,       // [变更] 屏幕像素宽度
            arrowSpacing: 15.0,// [保持] 箭头间距 (世界单位/米)
            speed: 5.0,        // [保持] 流动速度 (米/秒)
            trafficData: [],
            zOffset: 0.5,      // 离地高度
            cornerRadius: 5.0
        }, config);

        if (config.yOffset !== undefined) {
            this.config.zOffset = config.yOffset;
        }

        this.mesh = null;
        this.material = null;
        this._accumulatedTime = 0;
        // 记录画布尺寸，用于 Shader 计算
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
                uTime: { value: 0 },
                uTexture: { value: texture },
                uWidth: { value: this.config.width }, // 像素
                uArrowSpacing: { value: this.config.arrowSpacing }, // 米
                uResolution: { value: this._resolution }, // 画布尺寸
            },
            vertexShader: `
                uniform vec2 uResolution;
                uniform float uWidth;
                
                attribute vec3 aTangent;
                attribute vec2 aOffset; // x: side, y: forward (for caps)
                attribute float lineDist;
                attribute float vType; 
                
                varying vec2 vUv;
                varying vec3 vColor;
                varying float vDist;
                varying float vIsCap;

                void main() {
                    vUv = uv;
                    vColor = color;
                    vDist = lineDist;
                    vIsCap = vType;
                    
                    // 1. 计算中心点和切线方向的 Clip Space 坐标
                    vec4 clipCenter = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    vec4 clipTangent = projectionMatrix * modelViewMatrix * vec4(position + aTangent, 1.0);

                    // 2. 转换为 NDC (Normalized Device Coordinates)
                    vec2 ndcCenter = clipCenter.xy / clipCenter.w;
                    vec2 ndcTangent = clipTangent.xy / clipTangent.w;

                    // 3. 计算屏幕空间的切线方向 (像素单位)
                    vec2 screenDir = normalize((ndcTangent - ndcCenter) * uResolution);

                    // 4. 计算屏幕空间的法线方向 (-y, x)
                    vec2 screenNormal = vec2(-screenDir.y, screenDir.x);

                    // 5. 计算最终的像素偏移向量
                    // aOffset.x 是法向偏移 (左右), aOffset.y 是切向偏移 (圆头)
                    vec2 pixelOffset = (screenNormal * aOffset.x + screenDir * aOffset.y) * uWidth * 0.5;

                    // 6. 将像素偏移转回 Clip Space Delta
                    // DeltaNDC = PixelOffset / Resolution * 2.0
                    // DeltaClip = DeltaNDC * w
                    vec2 clipOffset = (pixelOffset * 2.0 / uResolution) * clipCenter.w;

                    // 应用偏移
                    gl_Position = clipCenter;
                    gl_Position.xy += clipOffset;
                }
            `,
            fragmentShader: `
                uniform float uTime;
                uniform sampler2D uTexture;
                uniform float uWidth;        // Pixels
                uniform float uArrowSpacing; // Meters
                
                varying vec2 vUv;
                varying vec3 vColor;
                varying float vDist;         // Meters
                varying float vIsCap;

                void main() {
                    vec3 finalColor = vColor;
                    vec3 white = vec3(1.0);
                    float border = 0.0;
                    float arrowAlpha = 0.0;

                    // 固定边框宽度 (例如 2 像素)
                    float borderPx = 2.0;
                    float borderRatio = borderPx / uWidth;

                    if (vIsCap > 0.5) {
                        // 圆头
                        float r = length(vUv);
                        float delta = fwidth(r);
                        float borderInner = 1.0 - borderRatio * 2.0;
                        border = smoothstep(borderInner - delta, borderInner, r);
                        if (r > 1.0) discard;
                    } else {
                        // 身体
                        border = step(vUv.y, borderRatio) + step(1.0 - borderRatio, vUv.y);
                        
                        // --- 核心修正：保持纹理比例 ---
                        // 我们需要计算当前像素对应的世界宽度 (米)，以保持箭头为正方形
                        
                        // 计算 vDist (米) 在屏幕上的变化率 -> 米/像素
                        float metersPerPixel = length(vec2(dFdx(vDist), dFdy(vDist)));
                        metersPerPixel = max(metersPerPixel, 0.0001);

                        // 当前线条在世界中的视觉宽度 (米)
                        float visibleWidthMeters = uWidth * metersPerPixel;

                        // 计算纹理坐标
                        // 箭头的长度 (米) 应该等于其宽度 (米) 才能保持正方形
                        float arrowLengthMeters = visibleWidthMeters;

                        float currentDist = vDist - uTime;
                        float distInCycle = mod(currentDist, uArrowSpacing);
                        
                        // 居中计算
                        float halfGap = (uArrowSpacing - arrowLengthMeters) * 0.5;
                        
                        // 归一化 X 坐标 (0~1 对应一个箭头长度)
                        float texX = (distInCycle - halfGap) / arrowLengthMeters;

                        if (texX > 0.0 && texX < 1.0) {
                            vec4 tex = texture2D(uTexture, vec2(texX, vUv.y));
                            arrowAlpha = smoothstep(0.45, 0.55, tex.a);
                        }
                    }

                    vec3 centerColor = mix(vColor, white, arrowAlpha);
                    finalColor = mix(centerColor, white, border);
                    gl_FragColor = vec4(finalColor, 1.0);
                }
            `,
            transparent: true,
            vertexColors: true,
            side: THREE.DoubleSide,
            // 启用导数扩展 (Three.js 默认通常开启，显式声明更安全)
            extensions: {
                derivatives: true
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
        
        const curve = createRoundedPath(this.points, cornerRadius);
        const totalLen = curve.getLength();
        const segments = Math.max(200, Math.floor(totalLen * 5));
        const points = curve.getSpacedPoints(segments);
        const count = points.length;

        // Attributes
        const positions = [];
        const tangents = [];
        const offsets = []; // vec2: x=side, y=forward
        const uvs = [];
        const colors = [];
        const dists = [];
        const types = [];
        const indices = [];

        let vertexIndex = 0;

        // --- 圆头 ---
        const addCap = (center, direction, color) => {
            const capSegments = 16;
            
            // 将 3D 方向投影到平面的 Forward (用于 Vertex Shader 计算切线空间)
            // Z-Up: 我们只需要方向向量，Shader 会再次投影到屏幕
            // 这里我们直接传 3D 的 tangent
            const tanX = direction.x;
            const tanY = direction.y;
            const tanZ = direction.z;

            // 中心点
            positions.push(center.x, center.y, center.z + zOffset);
            tangents.push(tanX, tanY, tanZ);
            offsets.push(0, 0); // 中心无偏移
            uvs.push(0, 0);
            colors.push(color.r, color.g, color.b);
            dists.push(0);
            types.push(1);
            
            const centerIdx = vertexIndex++;

            for (let i = 0; i <= capSegments; i++) {
                const theta = -Math.PI / 2 + (Math.PI * i) / capSegments;
                const sin = Math.sin(theta); // 对应 Right (Side)
                const cos = Math.cos(theta); // 对应 Forward

                positions.push(center.x, center.y, center.z + zOffset);
                tangents.push(tanX, tanY, tanZ);
                // 这里传入偏移系数，Shader 会根据 uWidth 展开
                offsets.push(sin, cos); 
                
                uvs.push(sin, cos);
                colors.push(color.r, color.g, color.b);
                dists.push(0);
                types.push(1);

                if (i > 0) {
                    indices.push(centerIdx, vertexIndex - 1, vertexIndex);
                }
                vertexIndex++;
            }
        };

        const startTangent = new THREE.Vector3().subVectors(points[1], points[0]).normalize();
        const endTangent = new THREE.Vector3().subVectors(points[count-1], points[count-2]).normalize();

        // Start Cap
        addCap(points[0], startTangent.clone().negate(), this._getColor(0, trafficData));

        // Body
        const bodyStartIdx = vertexIndex;
        let currentDist = 0;

        for (let i = 0; i < count; i++) {
            if (i > 0) currentDist += points[i].distanceTo(points[i-1]);

            let tangent;
            if (i === 0) tangent = startTangent;
            else if (i === count-1) tangent = endTangent;
            else tangent = new THREE.Vector3().subVectors(points[i+1], points[i-1]).normalize();

            const c = this._getColor(i / (count - 1), trafficData);

            // Left Vertex (Side = 1)
            positions.push(points[i].x, points[i].y, points[i].z + zOffset);
            tangents.push(tangent.x, tangent.y, tangent.z);
            offsets.push(1, 0); // Side +1
            uvs.push(0, 0); // UV.y = 0
            colors.push(c.r, c.g, c.b);
            dists.push(currentDist);
            types.push(0);

            // Right Vertex (Side = -1)
            positions.push(points[i].x, points[i].y, points[i].z + zOffset);
            tangents.push(tangent.x, tangent.y, tangent.z);
            offsets.push(-1, 0); // Side -1
            uvs.push(0, 1); // UV.y = 1
            colors.push(c.r, c.g, c.b);
            dists.push(currentDist);
            types.push(0);

            if (i < count - 1) {
                const base = bodyStartIdx + i * 2;
                indices.push(base, base+1, base+2);
                indices.push(base+1, base+3, base+2);
            }
            vertexIndex += 2;
        }

        // End Cap
        addCap(points[count-1], endTangent, this._getColor(1, trafficData));

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('aTangent', new THREE.Float32BufferAttribute(tangents, 3));
        geometry.setAttribute('aOffset', new THREE.Float32BufferAttribute(offsets, 2));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        geometry.setAttribute('lineDist', new THREE.Float32BufferAttribute(dists, 1));
        geometry.setAttribute('vType', new THREE.Float32BufferAttribute(types, 1));
        geometry.setIndex(indices);

        this.mesh = new THREE.Mesh(geometry, this.material);
        // 重要：由于顶点在 Shader 中偏移，包围盒计算可能会失效导致被剔除
        // 简单起见，禁用视锥体剔除
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

    // ================= Public API =================

    update(deltaTime) {
        if (!this.material) return;
        this._accumulatedTime += deltaTime * this.config.speed;
        this.material.uniforms.uTime.value = this._accumulatedTime;
        
        // 更新分辨率信息，确保线宽恒定
        // 如果有性能顾虑，可以只在 resize 时调用一个 resize() 方法
        this._resolution.set(window.innerWidth, window.innerHeight);
    }

    setWidth(val) {
        if (this.config.width === val) return;
        this.config.width = val;
        this.material.uniforms.uWidth.value = val;
        // 注意：无需重新构建几何体，只需更新 Uniform
    }

    setSpacing(val) {
        this.config.arrowSpacing = val;
        this.material.uniforms.uArrowSpacing.value = val;
    }

    setSpeed(val) {
        this.config.speed = val;
    }

    setTraffic(data) {
        this.config.trafficData = data;
        // 颜色存储在 Attribute 中，需要重建
        this._buildGeometry();
    }
    
    setCornerRadius(val) {
        if (this.config.cornerRadius === val) return;
        this.config.cornerRadius = val;
        this._buildGeometry();
    }

    dispose() {
        if (this.mesh) {
            this.scene.remove(this.mesh);
            this.mesh.geometry.dispose();
        }
        if (this.material) {
            this.material.dispose();
        }
    }
}