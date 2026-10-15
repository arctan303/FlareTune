import React, { useEffect, useRef, useState } from 'react';
import { imageLoadRegistry } from '../../utils/imageLoadRegistry.js';
import { usePrivateMediaRouteRevision } from '../../hooks/usePrivateMediaRouteRevision.js';
import { isTextureAuthorized } from '../../utils/privateTextureAuthorization.js';
import { usePageVisibility } from '../../hooks/usePageVisibility.js';

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
   Apple Music 优雅流体背景着色器管线（正交 2D 分离高斯模糊 + 封面后置涡旋）
   ========================================================================== */

const APPLE_FLUID_PARAMS = {
    rot: [0.003, -0.008, -0.006, 0.004],    // 每 30fps 归一帧自转角速度 (rad)
    spriteW: [1.25, 0.8, 0.5, 0.25],        // 4 张精灵尺度比例
    orbitRatio: 0.75,                       // 公转轨道角速度倍率
    orbitRadius: 0.25,                      // 公转轨道半径 = 宽度 × 0.25
    orbitCenterOffset: 0.05,                // 第 4 张精灵的圆心偏移 = 宽度 × 0.05
    reducedRot: 0.001,                      // 减弱动态偏好时的自转速率
    twistAngle: -1.75,                      // 优雅水流涡旋角（避免过度扭绞成蚊香盘）
    blurSigma: 10.0,                        // 正交 2D 高斯模糊半径
    saturation: 1.70,                       // 调优后的人性化饱和度（避免浅色封面过饱和刺眼）
    brightness: 0.85,                       // 通透度
    contrast: 1.25,                         // 柔和对比度（避免暗部死黑或亮部炸开）
    black: 0.45,                            // 影院级暗部下沉
    white: 0.04,                            // 5% 柔雾提亮
};

const VS_FULL = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
    v_uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const VS_SPRITE = `
attribute vec2 a_pos;
uniform mat3 u_matrix;
varying vec2 v_uv;
void main() {
    vec3 p = u_matrix * vec3(a_pos, 1.0);
    gl_Position = vec4(p.xy, 0.0, 1.0);
    v_uv = a_pos + 0.5;
}
`;

const FS_SPRITE = `
precision mediump float;
uniform sampler2D u_tex;
uniform float u_alpha;
varying vec2 v_uv;
void main() {
    vec4 c = texture2D(u_tex, clamp(v_uv, 0.0, 1.0));
    gl_FragColor = vec4(c.rgb, c.a * u_alpha);
}
`;

// 独立 Pass 2: 纯涡旋扭曲（将旋转中心动态置于封面后方）
const FS_TWIST = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_area;
uniform vec2 u_offset;
uniform float u_radius;
uniform float u_angle;

vec2 toPx(vec2 uv) { return vec2(uv.x, 1.0 - uv.y) * u_area; }
vec2 toUv(vec2 px) { return vec2(px.x / u_area.x, 1.0 - px.y / u_area.y); }

vec2 twist(vec2 uv) {
    vec2 coord = toPx(uv);
    vec2 c = coord - u_offset;
    float dist = length(c);
    if (dist < u_radius) {
        float ratioDist = (u_radius - dist) / u_radius;
        float angleMod = ratioDist * ratioDist * u_angle;
        float s = sin(angleMod), co = cos(angleMod);
        c = vec2(c.x * co - c.y * s, c.x * s + c.y * co);
    }
    return toUv(c + u_offset);
}

void main() {
    vec2 sampleUv = clamp(twist(v_uv), 0.0, 1.0);
    gl_FragColor = texture2D(u_tex, sampleUv);
}
`;

// 独立 Pass 3: 严格一维笛卡尔横向高斯模糊（确保 2D 正交可分性，消除旋转条纹失真）
const FS_BLUR_H = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_texel_x;
uniform float u_sigma;

void main() {
    vec4 sum = vec4(0.0);
    float wsum = 0.0;
    for (int i = -16; i <= 16; i++) {
        float fi = float(i);
        float w = exp(-0.5 * fi * fi / (u_sigma * u_sigma + 1e-6));
        sum += texture2D(u_tex, clamp(v_uv + vec2(fi * u_texel_x, 0.0), 0.0, 1.0)) * w;
        wsum += w;
    }
    gl_FragColor = sum / wsum;
}
`;

// 独立 Pass 4: 纵向高斯模糊 + 氛围调色 + 屏幕直出
const FS_BLUR_V = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_texel_y;
uniform float u_sigma;
uniform float u_saturation;
uniform float u_brightness;
uniform float u_contrast;
uniform float u_black;
uniform float u_white;
uniform float u_time;
uniform float u_crossfade;

void main() {
    vec4 sum = vec4(0.0);
    float wsum = 0.0;
    for (int i = -16; i <= 16; i++) {
        float fi = float(i);
        float w = exp(-0.5 * fi * fi / (u_sigma * u_sigma + 1e-6));
        sum += texture2D(u_tex, clamp(v_uv + vec2(0.0, fi * u_texel_y), 0.0, 1.0)) * w;
        wsum += w;
    }
    vec4 c = sum / wsum;
    if (c.a > 0.0) {
        c.rgb /= c.a;
        // Apple 经典 ColorMatrix 公式（以0.5中灰度做对比度与饱和度外插）
        vec3 rgb = mix(vec3(0.5), mix(vec3(dot(vec3(0.2125, 0.7154, 0.0721), c.rgb)), c.rgb, u_saturation), u_contrast);
        c.rgb = rgb * u_brightness;
        c.rgb *= c.a;
    }
    vec3 outRgb = c.rgb * (1.0 - u_black);
    outRgb = outRgb * (1.0 - u_white) + u_white;
    gl_FragColor = vec4(clamp(outRgb, 0.0, 1.0), 1.0);
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

function parseRgb(colorStr) {
    if (!colorStr || typeof colorStr !== 'string') return null;
    const match = colorStr.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (!match) return null;
    return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
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

function createPaletteFallbackTexture(gl, palette) {
    const c1 = parseRgb(palette?.dominant) || [48, 44, 56];
    const c2 = parseRgb(palette?.secondary) || [64, 52, 72];
    const c3 = parseRgb(palette?.accent) || [72, 60, 80];
    const c4 = parseRgb(palette?.deep) || [28, 24, 36];

    const data = new Uint8Array([
        c1[0], c1[1], c1[2], 255,   c2[0], c2[1], c2[2], 255,
        c3[0], c3[1], c3[2], 255,   c4[0], c4[1], c4[2], 255,
    ]);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return texture;
}

function processMacroColorTexture(gl, texture, image) {
    try {
        const canvas = document.createElement('canvas');
        const size = 40; // 官方 40x40 极低分辨率微缩图
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(image, 0, 0, size, size);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
        } else {
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        }
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    } catch {
        try {
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        } catch {
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texImage2D(
                gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0,
                gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([28, 24, 36, 255])
            );
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        }
    }
}

function modelMatrix(x, y, size, angle, W, H) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const a = c * size;
    const b = s * size;
    const cc = -s * size;
    const d = c * size;
    return new Float32Array([
        (2 / W) * a, (-2 / H) * b, 0,
        (2 / W) * cc, (-2 / H) * d, 0,
        (2 / W) * x - 1, 1 - (2 / H) * y, 1,
    ]);
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
    const pageVisible = usePageVisibility();
    const [textureAuthorization, setTextureAuthorization] = useState(null);
    const canvasRef = useRef(null);
    const glRef = useRef(null);
    const programsRef = useRef(null);
    const buffersRef = useRef(null);
    const fbosRef = useRef({ a: null, b: null });
    const texturesRef = useRef({ current: null, prev: null });
    const crossfadeRef = useRef({ startTime: 0, progress: 1.0 });
    const timeRef = useRef(0);
    const rotRef = useRef([0, 0, 0, 0]);
    const lastFrameTimeRef = useRef(null);
    const animFrameRef = useRef(null);
    const lastCoverUrlRef = useRef('');
    const lastRouteRevisionRef = useRef(routeRevision);
    const lastCoverWasPrivateRef = useRef(false);

    const isPlayingRef = useRef(isPlaying);
    const isBufferingRef = useRef(isBuffering);
    const suspendedRef = useRef(suspended);
    isPlayingRef.current = isPlaying;
    isBufferingRef.current = isBuffering;
    suspendedRef.current = suspended || !pageVisible;

    const renderLoop = (timestamp) => {
        animFrameRef.current = null;
        const gl = glRef.current;
        const canvas = canvasRef.current;
        const programs = programsRef.current;
        const buffers = buffersRef.current;
        if (!gl || !canvas || !programs || suspendedRef.current) {
            lastFrameTimeRef.current = null;
            return;
        }

        const playing = isPlayingRef.current && !isBufferingRef.current;
        if (playing) {
            const previous = lastFrameTimeRef.current;
            const elapsed = previous === null ? 0 : Math.max(0, timestamp - previous);
            timeRef.current += elapsed <= 250 ? elapsed * 0.00048 : 0;
            const dt = elapsed <= 250 ? elapsed / 33.333333 : 0;
            for (let i = 0; i < 4; i++) {
                rotRef.current[i] += APPLE_FLUID_PARAMS.rot[i] * dt;
            }
            lastFrameTimeRef.current = timestamp;
        } else {
            lastFrameTimeRef.current = null;
        }

        if (crossfadeRef.current.progress < 1.0) {
            const elapsed = performance.now() - crossfadeRef.current.startTime;
            crossfadeRef.current.progress = Math.min(1.0, elapsed / 850);
        }

        try {
            const cw = canvas.width || 1;
            const ch = canvas.height || 1;
            const { progSprite, progTwist, progBlurH, progBlurV } = programs;
            const { a: fboA, b: fboB } = fbosRef.current;
            const curTex = texturesRef.current.current;
            const prevTex = texturesRef.current.prev;
            const isCrossfading = crossfadeRef.current.progress < 1.0 && prevTex && prevTex !== curTex;

            if (fboA && fboB) {
                // Pass 1: 4 个正方形精灵以不同角速度公转与自转，绘制至 FBO A
                gl.bindFramebuffer(gl.FRAMEBUFFER, fboA.f);
                gl.viewport(0, 0, cw, ch);
                // 优雅的深邃暗曜底色（避免纯白底导致浅色封面被漂白泛脏）
                gl.clearColor(0.06, 0.05, 0.08, 1.0);
                gl.clear(gl.COLOR_BUFFER_BIT);

                gl.useProgram(progSprite.program);
                gl.enable(gl.BLEND);
                gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

                gl.bindBuffer(gl.ARRAY_BUFFER, buffers.unitQuad);
                gl.enableVertexAttribArray(progSprite.attribs.aPos);
                gl.vertexAttribPointer(progSprite.attribs.aPos, 2, gl.FLOAT, false, 0, 0);

                const w = cw;
                const h = ch;
                const orb = w * APPLE_FLUID_PARAMS.orbitRadius;
                const off = w * APPLE_FLUID_PARAMS.orbitCenterOffset;
                const rot = rotRef.current;
                const layout = [
                    { w: w * APPLE_FLUID_PARAMS.spriteW[0], x: w / 2, y: h / 2, rot: rot[0] },
                    { w: w * APPLE_FLUID_PARAMS.spriteW[1], x: w / 2.5, y: h / 2.5, rot: rot[1] },
                    { w: w * APPLE_FLUID_PARAMS.spriteW[2], x: w / 2 + orb * Math.cos(rot[2] * APPLE_FLUID_PARAMS.orbitRatio), y: h / 2 + orb * Math.sin(rot[2] * APPLE_FLUID_PARAMS.orbitRatio), rot: -rot[2] },
                    { w: w * APPLE_FLUID_PARAMS.spriteW[3], x: w / 2 + off + orb * Math.cos(rot[3] * APPLE_FLUID_PARAMS.orbitRatio), y: h / 2 + off + orb * Math.sin(rot[3] * APPLE_FLUID_PARAMS.orbitRatio), rot: -rot[3] },
                ];

                const drawSpriteSet = (tex, alpha) => {
                    if (!tex || alpha <= 0.001) return;
                    gl.activeTexture(gl.TEXTURE0);
                    gl.bindTexture(gl.TEXTURE_2D, tex);
                    gl.uniform1i(progSprite.uniforms.uTex, 0);
                    for (let i = 0; i < 4; i++) {
                        const item = layout[i];
                        gl.uniformMatrix3fv(progSprite.uniforms.uMatrix, false, modelMatrix(item.x, item.y, item.w, item.rot, w, h));
                        gl.uniform1f(progSprite.uniforms.uAlpha, alpha);
                        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
                    }
                };

                if (isCrossfading) {
                    drawSpriteSet(prevTex, 1.0 - crossfadeRef.current.progress);
                    drawSpriteSet(curTex, crossfadeRef.current.progress);
                } else {
                    drawSpriteSet(curTex, 1.0);
                }

                // Pass 2: 纯 Twist 涡旋变换 -> FBO B
                // 关键优化：将涡旋眼精准对齐在封面后方，避免在歌词与封面中间露出机械旋转的涡旋中心
                const isDesktop = cw >= 220; // 对应宽屏视口
                const vortexOffsetX = isDesktop ? cw * 0.28 : cw * 0.50;
                const vortexOffsetY = isDesktop ? ch * 0.46 : ch * 0.35;

                gl.bindFramebuffer(gl.FRAMEBUFFER, fboB.f);
                gl.viewport(0, 0, cw, ch);
                gl.disable(gl.BLEND);
                gl.useProgram(progTwist.program);

                gl.bindBuffer(gl.ARRAY_BUFFER, buffers.fullQuad);
                gl.enableVertexAttribArray(progTwist.attribs.aPos);
                gl.vertexAttribPointer(progTwist.attribs.aPos, 2, gl.FLOAT, false, 0, 0);

                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, fboA.t);
                gl.uniform1i(progTwist.uniforms.uTex, 0);
                gl.uniform2f(progTwist.uniforms.uArea, cw, ch);
                gl.uniform2f(progTwist.uniforms.uOffset, vortexOffsetX, vortexOffsetY);
                gl.uniform1f(progTwist.uniforms.uRadius, Math.max(cw, ch) * 0.95);
                gl.uniform1f(progTwist.uniforms.uAngle, APPLE_FLUID_PARAMS.twistAngle);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

                // Pass 3: 正交横向一维高斯模糊 -> FBO A
                gl.bindFramebuffer(gl.FRAMEBUFFER, fboA.f);
                gl.viewport(0, 0, cw, ch);
                gl.useProgram(progBlurH.program);

                gl.bindBuffer(gl.ARRAY_BUFFER, buffers.fullQuad);
                gl.enableVertexAttribArray(progBlurH.attribs.aPos);
                gl.vertexAttribPointer(progBlurH.attribs.aPos, 2, gl.FLOAT, false, 0, 0);

                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, fboB.t);
                gl.uniform1i(progBlurH.uniforms.uTex, 0);
                gl.uniform1f(progBlurH.uniforms.uTexelX, 1.0 / cw);
                gl.uniform1f(progBlurH.uniforms.uSigma, APPLE_FLUID_PARAMS.blurSigma);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            }

            // Pass 4: 正交纵向高斯模糊 + 人性化调色矩阵 + 屏幕画布直出
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, cw, ch);
            gl.disable(gl.BLEND);
            gl.useProgram(progBlurV.program);

            gl.bindBuffer(gl.ARRAY_BUFFER, buffers.fullQuad);
            gl.enableVertexAttribArray(progBlurV.attribs.aPos);
            gl.vertexAttribPointer(progBlurV.attribs.aPos, 2, gl.FLOAT, false, 0, 0);

            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, fboA ? fboA.t : curTex);
            gl.uniform1i(progBlurV.uniforms.uTex, 0);
            gl.uniform1f(progBlurV.uniforms.uTexelY, 1.0 / ch);
            gl.uniform1f(progBlurV.uniforms.uSigma, APPLE_FLUID_PARAMS.blurSigma);
            gl.uniform1f(progBlurV.uniforms.uSaturation, APPLE_FLUID_PARAMS.saturation);
            gl.uniform1f(progBlurV.uniforms.uBrightness, APPLE_FLUID_PARAMS.brightness);
            gl.uniform1f(progBlurV.uniforms.uContrast, APPLE_FLUID_PARAMS.contrast);
            gl.uniform1f(progBlurV.uniforms.uBlack, APPLE_FLUID_PARAMS.black);
            gl.uniform1f(progBlurV.uniforms.uWhite, APPLE_FLUID_PARAMS.white);
            gl.uniform1f(progBlurV.uniforms.uTime, timeRef.current);
            gl.uniform1f(progBlurV.uniforms.uCrossfade, crossfadeRef.current.progress);

            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        } catch (err) {
            console.warn('AppleFluidCanvas draw error:', err);
        }

        const isTransitioning = crossfadeRef.current.progress < 1.0;
        if ((playing || isTransitioning) && !suspendedRef.current) {
            animFrameRef.current = requestAnimationFrame(renderLoop);
        } else {
            animFrameRef.current = null;
            lastFrameTimeRef.current = null;
        }
    };

    const triggerRender = () => {
        if (suspendedRef.current) return;
        if (!animFrameRef.current) {
            animFrameRef.current = requestAnimationFrame(renderLoop);
        }
    };

    // 初始化 WebGL 上下文与着色器程序
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const gl = canvas.getContext('webgl', {
            alpha: false,
            antialias: false,
            depth: false,
            stencil: false,
            powerPreference: 'low-power',
        }) || canvas.getContext('experimental-webgl');

        if (!gl) return;
        glRef.current = gl;

        const pSprite = createProgram(gl, VS_SPRITE, FS_SPRITE);
        const pTwist = createProgram(gl, VS_FULL, FS_TWIST);
        const pBlurH = createProgram(gl, VS_FULL, FS_BLUR_H);
        const pBlurV = createProgram(gl, VS_FULL, FS_BLUR_V);

        if (!pSprite || !pTwist || !pBlurH || !pBlurV) return;

        programsRef.current = {
            progSprite: {
                program: pSprite,
                attribs: { aPos: gl.getAttribLocation(pSprite, 'a_pos') },
                uniforms: {
                    uMatrix: gl.getUniformLocation(pSprite, 'u_matrix'),
                    uTex: gl.getUniformLocation(pSprite, 'u_tex'),
                    uAlpha: gl.getUniformLocation(pSprite, 'u_alpha'),
                },
            },
            progTwist: {
                program: pTwist,
                attribs: { aPos: gl.getAttribLocation(pTwist, 'a_pos') },
                uniforms: {
                    uTex: gl.getUniformLocation(pTwist, 'u_tex'),
                    uArea: gl.getUniformLocation(pTwist, 'u_area'),
                    uOffset: gl.getUniformLocation(pTwist, 'u_offset'),
                    uRadius: gl.getUniformLocation(pTwist, 'u_radius'),
                    uAngle: gl.getUniformLocation(pTwist, 'u_angle'),
                },
            },
            progBlurH: {
                program: pBlurH,
                attribs: { aPos: gl.getAttribLocation(pBlurH, 'a_pos') },
                uniforms: {
                    uTex: gl.getUniformLocation(pBlurH, 'u_tex'),
                    uTexelX: gl.getUniformLocation(pBlurH, 'u_texel_x'),
                    uSigma: gl.getUniformLocation(pBlurH, 'u_sigma'),
                },
            },
            progBlurV: {
                program: pBlurV,
                attribs: { aPos: gl.getAttribLocation(pBlurV, 'a_pos') },
                uniforms: {
                    uTex: gl.getUniformLocation(pBlurV, 'u_tex'),
                    uTexelY: gl.getUniformLocation(pBlurV, 'u_texel_y'),
                    uSigma: gl.getUniformLocation(pBlurV, 'u_sigma'),
                    uSaturation: gl.getUniformLocation(pBlurV, 'u_saturation'),
                    uBrightness: gl.getUniformLocation(pBlurV, 'u_brightness'),
                    uContrast: gl.getUniformLocation(pBlurV, 'u_contrast'),
                    uBlack: gl.getUniformLocation(pBlurV, 'u_black'),
                    uWhite: gl.getUniformLocation(pBlurV, 'u_white'),
                    uTime: gl.getUniformLocation(pBlurV, 'u_time'),
                    uCrossfade: gl.getUniformLocation(pBlurV, 'u_crossfade'),
                },
            },
        };

        const unitQuad = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, unitQuad);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);

        const fullQuad = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, fullQuad);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1.0, -1.0, 1.0, -1.0, -1.0, 1.0, 1.0, 1.0]), gl.STATIC_DRAW);

        buffersRef.current = { unitQuad, fullQuad };

        const createFbo = (w, h) => {
            const t = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            const f = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, f);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            return { t, f };
        };

        texturesRef.current.current = createSolidTexture(gl, 28, 24, 36);
        texturesRef.current.prev = createSolidTexture(gl, 28, 24, 36);

        const handleResize = () => {
            if (!canvas || !gl) return;
            const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
            const rect = canvas.getBoundingClientRect();
            const w = Math.max(200, Math.floor(rect.width * 0.22 * dpr));
            const h = Math.max(140, Math.floor(rect.height * 0.22 * dpr));
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;

                const { a, b } = fbosRef.current;
                if (a) {
                    if (a.t) gl.deleteTexture(a.t);
                    if (a.f) gl.deleteFramebuffer(a.f);
                }
                if (b) {
                    if (b.t) gl.deleteTexture(b.t);
                    if (b.f) gl.deleteFramebuffer(b.f);
                }
                fbosRef.current = { a: createFbo(w, h), b: createFbo(w, h) };
                triggerRender();
            }
        };

        handleResize();
        window.addEventListener('resize', handleResize);
        triggerRender();

        return () => {
            window.removeEventListener('resize', handleResize);
            if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
            animFrameRef.current = null;
            if (texturesRef.current.current) gl.deleteTexture(texturesRef.current.current);
            if (texturesRef.current.prev) gl.deleteTexture(texturesRef.current.prev);
            const { a, b } = fbosRef.current;
            if (a) {
                if (a.t) gl.deleteTexture(a.t);
                if (a.f) gl.deleteFramebuffer(a.f);
            }
            if (b) {
                if (b.t) gl.deleteTexture(b.t);
                if (b.f) gl.deleteFramebuffer(b.f);
            }
            if (pSprite) gl.deleteProgram(pSprite);
            if (pTwist) gl.deleteProgram(pTwist);
            if (pBlurH) gl.deleteProgram(pBlurH);
            if (pBlurV) gl.deleteProgram(pBlurV);
            if (unitQuad) gl.deleteBuffer(unitQuad);
            if (fullQuad) gl.deleteBuffer(fullQuad);
            glRef.current = null;
            programsRef.current = null;
            buffersRef.current = null;
            fbosRef.current = { a: null, b: null };
        };
    }, []);

    // 封面更新与交叉淡入
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
        const shouldLoadPrivately = imageLoadRegistry.shouldLoadPrivately(coverUrl);
        if (lastCoverWasPrivateRef.current && !shouldLoadPrivately) {
            if (texturesRef.current.prev) gl.deleteTexture(texturesRef.current.prev);
            texturesRef.current.prev = texturesRef.current.current;
            texturesRef.current.current = createPaletteFallbackTexture(gl, palette);
            crossfadeRef.current = { startTime: performance.now(), progress: 0.0 };
            lastCoverUrlRef.current = coverUrl;
            triggerRender();
            return;
        }

        const img = new Image();
        let cancelled = false;
        let authorizedSource = null;

        if (!shouldLoadPrivately && !coverUrl.startsWith('blob:') && !coverUrl.startsWith('data:')) {
            img.crossOrigin = 'Anonymous';
        }

        const applyNewTexture = (texture) => {
            if (cancelled || !glRef.current) return;
            const currentGl = glRef.current;
            if (texturesRef.current.prev) {
                currentGl.deleteTexture(texturesRef.current.prev);
            }
            texturesRef.current.prev = texturesRef.current.current;
            texturesRef.current.current = texture;

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

        img.onload = () => {
            if (cancelled || !glRef.current) return;
            const currentGl = glRef.current;
            let newTex = null;
            try {
                newTex = currentGl.createTexture();
                processMacroColorTexture(currentGl, newTex, img);
                applyNewTexture(newTex);
            } catch {
                if (newTex) {
                    try { currentGl.deleteTexture(newTex); } catch {}
                }
                const fallbackTex = createPaletteFallbackTexture(currentGl, palette);
                applyNewTexture(fallbackTex);
            }
        };

        img.onerror = () => {
            if (cancelled || !glRef.current) return;
            const currentGl = glRef.current;
            const fallbackTex = createPaletteFallbackTexture(currentGl, palette);
            applyNewTexture(fallbackTex);
        };

        const optimizedUrl = coverUrl.includes('size=')
            ? coverUrl.replace(/size=\d+/, 'size=100')
            : coverUrl;

        if (shouldLoadPrivately) {
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

    // 恢复时先补静态帧；是否继续动画由循环读取最新偏好与播放状态决定
    useEffect(() => {
        lastFrameTimeRef.current = null;
        if (!suspended && pageVisible) triggerRender();
    }, [suspended, isPlaying, isBuffering, pageVisible, coverUrl]);

    const textureVisible = isTextureAuthorized(coverUrl, routeRevision, textureAuthorization, imageLoadRegistry);

    return (
        <div className={`apple-fluid-canvas absolute inset-0 overflow-hidden pointer-events-none z-[-2] bg-[#050404] ${className}`}>
            <canvas
                style={textureVisible ? undefined : { visibility: 'hidden' }}
                ref={canvasRef}
                className="w-full h-full object-cover scale-105 filter blur-[12px] md:blur-[18px] opacity-100 transition-opacity duration-1000 ease-out"
            />
            {/* 歌词区高对比度保护遮罩 */}
            <div className="absolute inset-0 bg-gradient-to-r from-black/10 via-black/20 to-black/40 pointer-events-none" />
            <div className="absolute inset-0 bg-black/10 pointer-events-none" />
        </div>
    );
}
