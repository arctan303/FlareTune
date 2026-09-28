import React, { useEffect, useRef, useState } from 'react';
import { imageLoadRegistry } from '../../utils/imageLoadRegistry.js';
import { usePrivateMediaRouteRevision } from '../../hooks/usePrivateMediaRouteRevision.js';
import { isTextureAuthorized } from '../../utils/privateTextureAuthorization.js';

/* ==========================================================================
   Apple Music 调色提取器
   ========================================================================== */

export function extractAppleMusicPalette(imgElement) {
    try {
        const canvas = document.createElement('canvas');
        const size = 32;
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;
        ctx.drawImage(imgElement, 0, 0, size, size);
        const imgData = ctx.getImageData(0, 0, size, size).data;

        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        let weight = 0;
        let bestVibrant = null;
        let maxVibrance = -1;

        for (let i = 0; i < imgData.length; i += 4) {
            const r = imgData[i];
            const g = imgData[i + 1];
            const b = imgData[i + 2];
            const a = imgData[i + 3];
            if (a < 128) continue;

            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            const delta = max - min;
            const lightness = (max + min) / (2 * 255);

            const chromaWeight = 0.55 + (delta / 255) * 0.45;
            sumR += r * chromaWeight;
            sumG += g * chromaWeight;
            sumB += b * chromaWeight;
            weight += chromaWeight;

            if (lightness < 0.12 || lightness > 0.88 || delta < 35) continue;
            const saturation = delta / (1 - Math.abs(2 * lightness - 1) + 0.001);
            const vibranceScore = saturation * 2.0 + (max / 255);
            if (vibranceScore > maxVibrance) {
                maxVibrance = vibranceScore;
                bestVibrant = { r, g, b };
            }
        }

        if (!weight) return null;

        const avg = { r: sumR / weight, g: sumG / weight, b: sumB / weight };
        const dominant = bestVibrant || avg;
        const deep = {
            r: Math.max(8, Math.round(avg.r * 0.12)),
            g: Math.max(8, Math.round(avg.g * 0.12)),
            b: Math.max(8, Math.round(avg.b * 0.12)),
        };

        return {
            dominant: `rgb(${Math.round(dominant.r)}, ${Math.round(dominant.g)}, ${Math.round(dominant.b)})`,
            secondary: `rgb(${Math.round(avg.r * 1.2)}, ${Math.round(avg.g * 1.2)}, ${Math.round(avg.b * 1.2)})`,
            deep: `rgb(${deep.r}, ${deep.g}, ${deep.b})`,
        };
    } catch {
        return null;
    }
}

/* ==========================================================================
   Apple Music 原生动态流体着色器 (带智能亮度压制与歌词区高对比度遮罩)
   ========================================================================== */

const VS_SOURCE = `
attribute vec2 a_position;
varying vec2 v_uv;

void main() {
    v_uv = (a_position + 1.0) * 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FS_SOURCE = `
precision highp float;

varying vec2 v_uv;

uniform sampler2D u_tex_current;
uniform sampler2D u_tex_prev;
uniform float u_crossfade; // 0.0 -> 1.0
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_aspect;

// Simplex 2D 连续流体噪声
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }

float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy));
    vec2 x0 = v -   i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
    m = m * m;
    m = m * m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
    vec3 g;
    g.x  = a0.x  * x0.x  + h.x  * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
}

// 多光团有机流体渲染器 (Apple Music 经典动态光斑交织系统)
vec3 evaluateFluid(sampler2D tex, vec2 uv, float t) {
    vec2 aspectP = vec2((uv.x - 0.5) * u_aspect + 0.5, uv.y);

    // 1. 低频有机微扰动 (让光团边缘呈柔和液态拉伸)
    float warp = snoise(aspectP * 1.15 + vec2(t * 0.12, -t * 0.10)) * 0.12;
    vec2 pWarped = aspectP + vec2(warp, -warp * 0.85);

    // 2. 三个主要色彩光团的平滑游弋轨迹 (从容沉静，每秒移动约 2% 屏幕距离，方向明确)
    vec2 centerA = vec2(0.38 + sin(t * 0.24) * 0.24, 0.46 + cos(t * 0.19) * 0.19);
    vec2 centerB = vec2(0.66 + cos(t * 0.21 + 1.4) * 0.26, 0.38 + sin(t * 0.26 + 0.6) * 0.22);
    vec2 centerC = vec2(0.46 + sin(t * 0.17 + 2.8) * 0.22, 0.70 + cos(t * 0.22 + 1.2) * 0.18);

    // 3. 计算每个光斑的影响半径与柔和高斯衰减
    float distA = length(pWarped - centerA);
    float distB = length(pWarped - centerB);
    float distC = length(pWarped - centerC);

    float wA = smoothstep(0.92, 0.05, distA);
    float wB = smoothstep(0.82, 0.05, distB);
    float wC = smoothstep(0.88, 0.05, distC);

    // 4. 随着光团自身游弋坐标动态取样纹理 (色彩随位置流动而连续变幻)
    vec2 uvA = clamp(vec2(centerA.x, centerA.y) + vec2(warp * 0.5, -warp * 0.5), 0.08, 0.92);
    vec2 uvB = clamp(vec2(centerB.x, centerB.y) + vec2(-warp * 0.5, warp * 0.5), 0.08, 0.92);
    vec2 uvC = clamp(vec2(centerC.x, centerC.y) + vec2(warp * 0.4, warp * 0.4), 0.08, 0.92);

    vec3 colA = texture2D(tex, uvA).rgb;
    vec3 colB = texture2D(tex, uvB).rgb;
    vec3 colC = texture2D(tex, uvC).rgb;
    vec3 colBase = texture2D(tex, vec2(0.50, 0.50)).rgb * 0.45;

    // 5. 饱和度与活力提升 (防止暗色封面变成纯黑死色)
    float lumA = dot(colA, vec3(0.299, 0.587, 0.114));
    float lumB = dot(colB, vec3(0.299, 0.587, 0.114));
    float lumC = dot(colC, vec3(0.299, 0.587, 0.114));
    if (lumA < 0.15) colA += vec3(0.18, 0.12, 0.22);
    if (lumB < 0.15) colB += vec3(0.12, 0.18, 0.24);
    if (lumC < 0.15) colC += vec3(0.20, 0.14, 0.16);

    // 6. 加权混合光斑
    vec3 fluid = colBase;
    fluid = mix(fluid, colA, wA * 0.80);
    fluid = mix(fluid, colB, wB * 0.70);
    fluid = mix(fluid, colC, wC * 0.65);

    // 7. 色彩通透度与层次润色
    float gray = dot(fluid, vec3(0.299, 0.587, 0.114));
    fluid = mix(vec3(gray), fluid, 1.30);

    return fluid;
}

void main() {
    float t = u_time;

    vec3 cur = evaluateFluid(u_tex_current, v_uv, t);
    vec3 color = cur;

    if (u_crossfade < 0.999) {
        vec3 prev = evaluateFluid(u_tex_prev, v_uv, t);
        float ease = smoothstep(0.0, 1.0, u_crossfade);
        color = mix(prev, cur, ease);
    }

    // 8. 影院级自然发光源：以左侧唱片为中心向外自然漫射
    vec2 lightOrigin = vec2(0.28, 0.46);
    float distFromCover = length(v_uv - lightOrigin);
    float ambientFalloff = smoothstep(1.40, 0.15, distFromCover);
    color = mix(color * 0.40, color, ambientFalloff);

    // 9. 智能自适应亮度控制
    float lum = dot(color, vec3(0.299, 0.587, 0.114));
    float targetMaxLum = 0.52;
    if (lum > targetMaxLum) {
        color = mix(color * (targetMaxLum / lum), color, 0.25);
    }

    // 10. 歌词区域渐进式暗调过度 (右侧歌词区保证高对比度与纯净背景)
    float lyricScrim = smoothstep(0.20, 0.85, v_uv.x);
    color = mix(color, color * 0.45, lyricScrim * 0.60);

    // 11. 底部控制台暗区沉淀
    color *= mix(1.0, 0.80, smoothstep(0.55, 1.0, v_uv.y));

    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('Shader compile error:', gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

function createProgram(gl, vsSource, fsSource) {
    const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
    const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return null;

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('Program link error:', gl.getProgramInfoLog(program));
        gl.deleteProgram(program);
        return null;
    }
    return program;
}

function createSolidTexture(gl, r, g, b) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([r, g, b, 255])
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return texture;
}

function processMacroColorTexture(gl, texture, image) {
    const canvas = document.createElement('canvas');
    const size = 64; // 64x64，保留封面四个象限的丰富真实色彩
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    if ('filter' in ctx) {
        ctx.filter = 'blur(1.5px) saturate(1.4) contrast(1.08)';
    }
    ctx.drawImage(image, 0, 0, size, size);

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
}

/**
 * 官方同款原生 WebGL Apple Music 流体动态背景
 */
export default function AppleFluidCanvas({
    coverUrl,
    palette,
    isPlaying = true,
    isBuffering = false,
    suspended = false,
    className = '',
}) {
    const routeRevision = usePrivateMediaRouteRevision();
    const [textureAuthorization, setTextureAuthorization] = useState(null);
    const canvasRef = useRef(null);
    const glRef = useRef(null);
    const programRef = useRef(null);
    const texturesRef = useRef({ current: null, prev: null });
    const crossfadeRef = useRef({ startTime: 0, progress: 1.0 });
    const timeRef = useRef(0);
    const animFrameRef = useRef(null);
    const lastCoverUrlRef = useRef('');
    const lastRouteRevisionRef = useRef(routeRevision);
    const lastCoverWasPrivateRef = useRef(false);

    // 使用 Ref 解决 React 闭包陈旧状态导致动画循环死锁的问题
    const isPlayingRef = useRef(isPlaying);
    const isBufferingRef = useRef(isBuffering);
    const suspendedRef = useRef(suspended);
    isPlayingRef.current = isPlaying;
    isBufferingRef.current = isBuffering;
    suspendedRef.current = suspended;

    // 渲染循环（内部始终读取最新的 Ref 状态）
    const renderLoop = () => {
        const gl = glRef.current;
        const program = programRef.current;
        const canvas = canvasRef.current;
        if (!gl || !program || !canvas || suspendedRef.current) {
            animFrameRef.current = null;
            return;
        }

        gl.useProgram(program);

        const playing = isPlayingRef.current && !isBufferingRef.current;
        if (playing) {
            timeRef.current += 0.008; // 黄金均衡流速 (沉静、丝滑且清晰可辨)
        }

        if (crossfadeRef.current.progress < 1.0) {
            const elapsed = performance.now() - crossfadeRef.current.startTime;
            crossfadeRef.current.progress = Math.min(1.0, elapsed / 850);
        }

        const uTime = gl.getUniformLocation(program, 'u_time');
        const uCrossfade = gl.getUniformLocation(program, 'u_crossfade');
        const uResolution = gl.getUniformLocation(program, 'u_resolution');
        const uAspect = gl.getUniformLocation(program, 'u_aspect');
        const uTexCurrent = gl.getUniformLocation(program, 'u_tex_current');
        const uTexPrev = gl.getUniformLocation(program, 'u_tex_prev');

        gl.uniform1f(uTime, timeRef.current);
        gl.uniform1f(uCrossfade, crossfadeRef.current.progress);
        gl.uniform2f(uResolution, canvas.width, canvas.height);
        gl.uniform1f(uAspect, canvas.width / Math.max(1, canvas.height));

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texturesRef.current.current);
        gl.uniform1i(uTexCurrent, 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, texturesRef.current.prev || texturesRef.current.current);
        gl.uniform1i(uTexPrev, 1);

        gl.drawArrays(gl.TRIANGLES, 0, 6);

        const isTransitioning = crossfadeRef.current.progress < 1.0;
        if (playing || isTransitioning) {
            animFrameRef.current = requestAnimationFrame(renderLoop);
        } else {
            animFrameRef.current = null;
        }
    };

    const triggerRender = () => {
        if (!animFrameRef.current) {
            animFrameRef.current = requestAnimationFrame(renderLoop);
        }
    };

    // 初始化 WebGL 上下文
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const gl = canvas.getContext('webgl', { 
            alpha: false,
            antialias: false,
            powerPreference: 'high-performance' 
        }) || canvas.getContext('experimental-webgl');
        
        if (!gl) return;
        glRef.current = gl;

        const program = createProgram(gl, VS_SOURCE, FS_SOURCE);
        if (!program) return;
        programRef.current = program;

        const positionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.bufferData(
            gl.ARRAY_BUFFER,
            new Float32Array([
                -1.0, -1.0,
                 1.0, -1.0,
                -1.0,  1.0,
                -1.0,  1.0,
                 1.0, -1.0,
                 1.0,  1.0,
            ]),
            gl.STATIC_DRAW
        );

        const aPosition = gl.getAttribLocation(program, 'a_position');
        gl.enableVertexAttribArray(aPosition);
        gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

        // 默认初始化底色纹理 (使用优雅深色，非死黑)
        texturesRef.current.current = createSolidTexture(gl, 28, 24, 36);
        texturesRef.current.prev = createSolidTexture(gl, 28, 24, 36);

        const handleResize = () => {
            if (!canvas || !gl) return;
            const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
            const rect = canvas.getBoundingClientRect();
            // 22% 渲染分辨率：全屏 blur(26-38px) 会掩盖低分率颗粒，视觉几乎不变但显著降低 GPU 像素量
            const w = Math.max(200, Math.floor(rect.width * 0.22 * dpr));
            const h = Math.max(140, Math.floor(rect.height * 0.22 * dpr));
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
                gl.viewport(0, 0, w, h);
            }
        };

        handleResize();
        window.addEventListener('resize', handleResize);
        triggerRender();

        return () => {
            window.removeEventListener('resize', handleResize);
            if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
            if (texturesRef.current.current) gl.deleteTexture(texturesRef.current.current);
            if (texturesRef.current.prev) gl.deleteTexture(texturesRef.current.prev);
            if (program) gl.deleteProgram(program);
            if (positionBuffer) gl.deleteBuffer(positionBuffer);
        };
    }, []);

    // 封面更新与过渡
    useEffect(() => {
        const gl = glRef.current;
        if (!gl) return;
        if (lastRouteRevisionRef.current !== routeRevision) {
            if (lastCoverWasPrivateRef.current || imageLoadRegistry.isPrivateMediaUrl(coverUrl)) {
                if (texturesRef.current.current) gl.deleteTexture(texturesRef.current.current);
                if (texturesRef.current.prev) gl.deleteTexture(texturesRef.current.prev);
                texturesRef.current.current = createSolidTexture(gl, 28, 24, 36);
                texturesRef.current.prev = createSolidTexture(gl, 28, 24, 36);
                crossfadeRef.current = { startTime: 0, progress: 1.0 };
                lastCoverUrlRef.current = '';
                setTextureAuthorization(null);
                triggerRender();
            }
            lastRouteRevisionRef.current = routeRevision;
        }
        if (!coverUrl || coverUrl === lastCoverUrlRef.current) return;
        lastCoverWasPrivateRef.current = imageLoadRegistry.isPrivateMediaUrl(coverUrl);
        if (lastCoverWasPrivateRef.current && !imageLoadRegistry.shouldLoadPrivately(coverUrl)) return;

        const img = new Image();
        img.crossOrigin = 'Anonymous';
        let cancelled = false;
        let authorizedSource = null;

        img.onload = () => {
            if (cancelled || !glRef.current) return;
            const currentGl = glRef.current;

            if (texturesRef.current.prev) {
                currentGl.deleteTexture(texturesRef.current.prev);
            }
            texturesRef.current.prev = texturesRef.current.current;

            const newTex = currentGl.createTexture();
            processMacroColorTexture(currentGl, newTex, img);
            texturesRef.current.current = newTex;

            crossfadeRef.current = {
                startTime: performance.now(),
                progress: 0.0,
            };
            lastCoverUrlRef.current = coverUrl;
            if (lastCoverWasPrivateRef.current) {
                setTextureAuthorization({ coverUrl, routeRevision, source: authorizedSource });
            }

            triggerRender();
        };

        img.onerror = () => {
            if (cancelled) return;
            lastCoverUrlRef.current = coverUrl;
            triggerRender();
        };

        const optimizedUrl = coverUrl.includes('size=')
            ? coverUrl.replace(/size=\d+/, 'size=100')
            : coverUrl;
        if (imageLoadRegistry.shouldLoadPrivately(coverUrl)) {
            void imageLoadRegistry.load(coverUrl).then(({ url }) => {
                if (!cancelled) {
                    authorizedSource = url;
                    img.src = url;
                }
            }).catch(() => {
                if (!cancelled) img.onerror?.();
            });
        } else {
            img.src = optimizedUrl + (optimizedUrl.includes('?') ? '&' : '?') + '_c=1';
        }

        return () => {
            cancelled = true;
            img.onload = null;
            img.onerror = null;
        };
    }, [coverUrl, routeRevision]);

    // 播放/缓冲状态变化时触发渲染循环检查
    useEffect(() => {
        if ((isPlaying && !isBuffering) || crossfadeRef.current.progress < 1.0) {
            triggerRender();
        }
    }, [isPlaying, isBuffering]);

    // 挂起状态恢复时重新启动渲染循环（保留当前帧与纹理，不重新初始化）
    useEffect(() => {
        if (!suspended && ((isPlaying && !isBuffering) || crossfadeRef.current.progress < 1.0)) {
            triggerRender();
        }
    }, [suspended, isPlaying, isBuffering]);

    const textureVisible = isTextureAuthorized(coverUrl, routeRevision, textureAuthorization, imageLoadRegistry);

    return (
        <div className={`apple-fluid-canvas absolute inset-0 overflow-hidden pointer-events-none z-[-2] bg-[#050404] ${className}`}>
            <canvas
                style={textureVisible ? undefined : { visibility: 'hidden' }}
                ref={canvasRef}
                className="w-full h-full object-cover scale-105 filter blur-[26px] md:blur-[38px] opacity-100 transition-opacity duration-1000 ease-out"
            />
            {/* 智能磨砂与歌词区对比度保护遮罩 (Apple Music Contrast Scrim) */}
            <div className="absolute inset-0 bg-gradient-to-r from-black/10 via-black/20 to-black/45 pointer-events-none" />
            <div className="absolute inset-0 bg-black/10 pointer-events-none" />
        </div>
    );
}
