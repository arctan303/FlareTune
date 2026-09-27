import React from 'react';
import {
    hasAudioAnalyserEnteredPlaying,
    invalidateAudioAnalyser,
    isAudioAnalyserCurrent,
    markAudioAnalyserPlaying,
    refreshAudioAnalyser,
    releaseAudioAnalyser,
    setAudioAnalyserActive,
} from './audioAnalyserResource';

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const lerp = (from, to, progress) => from + (to - from) * progress;
const smoothstep = (edge0, edge1, value) => {
    const progress = clamp((value - edge0) / Math.max(edge1 - edge0, 0.0001));
    return progress * progress * (3 - 2 * progress);
};

const setAmbientVars = (node, level) => {
    if (!node) return;
    node.style.setProperty('--immersive-audio-level', level.toFixed(3));
    node.style.setProperty('--immersive-lyric-glow-size', `${8 + level * 18}px`);
    node.style.setProperty('--immersive-lyric-glow-alpha', `${0.16 + level * 0.22}`);
};

const getIntensityScale = (intensity) => {
    switch (intensity) {
        case 'intense': return 1.45;
        case 'standard': return 1;
        case 'subtle':
        default: return 0.62;
    }
};

export default function ImmersiveAudioAura({
    audioRef,
    isPlaying,
    isBuffering,
    enabled,
    suspended = false,
    intensity = 'subtle',
    containerRef,
    visualMode = 'ambient',
    prefersReducedMotion = false,
    presentationReady = true,
    renderPaused = false,
    onModeCollapsed,
}) {
    const canvasRef = React.useRef(null);
    const analyserRef = React.useRef(null);
    const analyserResourceRef = React.useRef(null);
    const dataArrayRef = React.useRef(null);
    const smoothLevelRef = React.useRef(0);
    const smoothBandsRef = React.useRef(new Float32Array(96));
    const upperYRef = React.useRef(new Float32Array(96));
    const modeProgressRef = React.useRef(0);
    const baselineActivityRef = React.useRef(0);
    const animationRef = React.useRef(null);
    const analysisEnabledRef = React.useRef(false);
    const analyserActiveRef = React.useRef(false);
    const initAudioRef = React.useRef(null);
    const analyserAttemptRef = React.useRef(0);
    const collapseNotifiedRef = React.useRef(true);
    const [canvasVersion, setCanvasVersion] = React.useState(0);
    const [analysisVersion, setAnalysisVersion] = React.useState(0);

    const isNoLyricsMode = visualMode === 'no-lyrics';
    const isNoLyricsContext = isNoLyricsMode || visualMode === 'no-lyrics-idle';
    const analysisEnabled = !prefersReducedMotion && !suspended && (enabled || isNoLyricsMode);
    const analyserActive = analysisEnabled && isPlaying && !isBuffering;
    analysisEnabledRef.current = analysisEnabled;
    analyserActiveRef.current = analyserActive;

    React.useEffect(() => {
        if (!enabled) setAmbientVars(containerRef?.current, 0);
    }, [containerRef, enabled]);

    React.useEffect(() => {
        if (visualMode === 'no-lyrics-idle') collapseNotifiedRef.current = false;
    }, [visualMode]);

    React.useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return undefined;

        const resize = () => {
            const rect = canvas.getBoundingClientRect();
            const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
            const rawWidth = Math.max(1, rect.width * pixelRatio);
            const rawHeight = Math.max(1, rect.height * pixelRatio);
            const maxWidth = 1920;
            const maxHeight = 1080;
            const resolutionScale = Math.min(1, maxWidth / rawWidth, maxHeight / rawHeight);
            const nextWidth = Math.max(1, Math.round(rawWidth * resolutionScale));
            const nextHeight = Math.max(1, Math.round(rawHeight * resolutionScale));
            if (canvas.width === nextWidth && canvas.height === nextHeight) return;
            canvas.width = nextWidth;
            canvas.height = nextHeight;
            setCanvasVersion((version) => version + 1);
        };

        resize();
        const observer = new ResizeObserver(resize);
        observer.observe(canvas);
        return () => observer.disconnect();
    }, []);

    React.useEffect(() => {
        if (!audioRef?.current) return undefined;

        const audio = audioRef.current;

        const initAudio = () => {
            if (!analysisEnabledRef.current) return;
            try {
                if (!audio || audio.paused) return;

                // 若音频已实际起播但尚未打标，主动补齐标记以允许捕获
                if (!hasAudioAnalyserEnteredPlaying(audio) && audio.currentTime > 0) {
                    markAudioAnalyserPlaying(audio);
                }

                if (
                    !hasAudioAnalyserEnteredPlaying(audio)
                    || audio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
                ) return;
                const previousResource = analyserResourceRef.current;
                // Keep timeupdate as a delayed capture retry only. A healthy
                // captured stream must not enqueue AudioContext work on every
                // media progress event.
                if (isAudioAnalyserCurrent(previousResource, audio)) {
                    if (analyserActiveRef.current
                        && previousResource.resource.context.state !== 'running') {
                        setAudioAnalyserActive(previousResource, true);
                    }
                    return;
                }
                const resource = refreshAudioAnalyser(previousResource, audio);
                if (!resource) {
                    analyserResourceRef.current = null;
                    analyserRef.current = null;
                    dataArrayRef.current = null;
                    analyserAttemptRef.current += 1;
                    return;
                }
                if (resource !== previousResource) {
                    analyserResourceRef.current = resource;
                    analyserRef.current = resource.analyser;
                    resource.analyser.fftSize = 256;
                    resource.analyser.smoothingTimeConstant = 0.84;
                    dataArrayRef.current = new Uint8Array(resource.analyser.frequencyBinCount);
                    smoothBandsRef.current.fill(0);
                    smoothLevelRef.current = 0;
                    analyserAttemptRef.current = 0;
                    setAnalysisVersion((version) => version + 1);
                }
                setAudioAnalyserActive(analyserResourceRef.current, analyserActiveRef.current);
            } catch (error) {
                analyserAttemptRef.current += 1;
                if (analyserAttemptRef.current === 1) {
                    console.warn('Immersive audio visual unavailable:', error);
                }
            }
        };

        const resetAudio = () => {
            invalidateAudioAnalyser(audio);
            analyserResourceRef.current = null;
            analyserRef.current = null;
            dataArrayRef.current = null;
            smoothBandsRef.current.fill(0);
            smoothLevelRef.current = 0;
            analyserAttemptRef.current = 0;
            setAmbientVars(containerRef?.current, 0);
            setAnalysisVersion((version) => version + 1);
        };

        const handlePlaying = () => {
            markAudioAnalyserPlaying(audio);
            initAudio();
        };

        initAudioRef.current = initAudio;
        initAudio();
        audio.addEventListener('loadstart', resetAudio);
        audio.addEventListener('emptied', resetAudio);
        audio.addEventListener('playing', handlePlaying);
        audio.addEventListener('timeupdate', initAudio);
        document.addEventListener('click', initAudio, { once: true, passive: true });

        return () => {
            audio.removeEventListener('loadstart', resetAudio);
            audio.removeEventListener('emptied', resetAudio);
            audio.removeEventListener('playing', handlePlaying);
            audio.removeEventListener('timeupdate', initAudio);
            document.removeEventListener('click', initAudio);
            initAudioRef.current = null;
            if (animationRef.current) {
                cancelAnimationFrame(animationRef.current);
                animationRef.current = null;
            }
            releaseAudioAnalyser(analyserResourceRef.current);
            analyserResourceRef.current = null;
            analyserRef.current = null;
            dataArrayRef.current = null;
            analyserAttemptRef.current = 0;
            setAmbientVars(containerRef?.current, 0);
        };
    }, [audioRef, containerRef]);

    React.useEffect(() => {
        if (analyserActive) {
            initAudioRef.current?.();
        } else {
            setAudioAnalyserActive(analyserResourceRef.current, false);
        }
    }, [analyserActive]);

    React.useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return undefined;

        const context = canvas.getContext('2d');
        if (renderPaused) {
            context.clearRect(0, 0, canvas.width, canvas.height);
            return undefined;
        }
        const bands = smoothBandsRef.current;
        let running = true;

        const drawBaseline = (width, height, opacity = 0.12) => {
            const baselineY = height - 2;
            context.clearRect(0, 0, width, height);
            context.beginPath();
            context.moveTo(0, baselineY);
            context.lineTo(width, baselineY);
            context.strokeStyle = `rgba(255,255,255,${opacity})`;
            context.lineWidth = Math.max(1, window.devicePixelRatio || 1);
            context.stroke();
        };

        const draw = (timestamp = 0) => {
            if (!running) return;

            const width = canvas.width;
            const height = canvas.height;
            if (!width || !height) return;

            const intensityScale = getIntensityScale(intensity);
            const analyser = analyserRef.current;
            const dataArray = dataArrayRef.current;
            const canSample = analysisEnabled
                && !prefersReducedMotion
                && isPlaying
                && !isBuffering
                && visualMode !== 'no-lyrics-idle'
                && analyser
                && dataArray;
            const baselineActivityTarget = canSample ? 1 : 0;
            const baselineEase = prefersReducedMotion ? 1 : (baselineActivityTarget > baselineActivityRef.current ? 0.07 : 0.05);
            baselineActivityRef.current += (baselineActivityTarget - baselineActivityRef.current) * baselineEase;
            if (Math.abs(baselineActivityTarget - baselineActivityRef.current) < 0.0015) {
                baselineActivityRef.current = baselineActivityTarget;
            }
            const targetModeProgress = isNoLyricsMode && isPlaying ? 1 : 0;
            if (targetModeProgress > 0) collapseNotifiedRef.current = false;
            const modeEase = prefersReducedMotion ? 1 : (targetModeProgress > modeProgressRef.current ? 0.0375 : 0.055);
            modeProgressRef.current += (targetModeProgress - modeProgressRef.current) * modeEase;
            if (Math.abs(targetModeProgress - modeProgressRef.current) < 0.0015) {
                modeProgressRef.current = targetModeProgress;
            }
            const modeProgress = clamp(modeProgressRef.current);
            if (canSample) analyser.getByteFrequencyData(dataArray);

            let average = 0;
            let peak = 0;
            for (let i = 0; i < bands.length; i++) {
                const sourceIndex = Math.floor((i / bands.length) * (dataArray?.length || 1) * 0.78);
                const raw = canSample ? (dataArray[sourceIndex] || 0) / 255 : 0;
                const target = canSample ? Math.pow(raw, 1.48) * intensityScale : 0;
                const smoothing = canSample ? 0.19 : (isBuffering && isPlaying ? 0.012 : 0.085);
                bands[i] += (target - bands[i]) * smoothing;
                average += bands[i];
                peak = Math.max(peak, bands[i]);
            }

            average /= bands.length;
            smoothLevelRef.current += (Math.min(1, average * 1.9) - smoothLevelRef.current) * 0.13;
            setAmbientVars(containerRef?.current, enabled ? smoothLevelRef.current : 0);
            const energyCollapsed = peak < 0.003 && smoothLevelRef.current < 0.003;
            if (targetModeProgress === 0
                && modeProgress === 0
                && energyCollapsed
                && baselineActivityRef.current === 0
                && !collapseNotifiedRef.current) {
                collapseNotifiedRef.current = true;
                onModeCollapsed?.();
            }

            const standbyBaselineY = height - 2;
            // Original canvas occupied the bottom 22vh and used baseY = 76%:
            // 78% + 22% * 76% = 94.72% of the fullscreen height.
            const activeBaselineY = height * 0.9472;
            const baselineY = lerp(standbyBaselineY, activeBaselineY, baselineActivityRef.current);
            const centerY = height * 0.445;
            const foldProgress = smoothstep(0, 0.58, modeProgress);
            const specialReveal = smoothstep(0.16, 1, modeProgress);
            const specialSpan = Math.min(width * 0.28, height * 0.48);
            const waveSpan = lerp(width, specialSpan, foldProgress);
            const waveStartX = (width - waveSpan) / 2;
            const specialAxisY = centerY + height * 0.072;
            const waveAxisY = lerp(baselineY, specialAxisY, foldProgress);
            const bottomAmplitude = height * 0.085;
            const specialAmplitude = height * 0.038;
            const fillOpacity = 1 - smoothstep(0.18, 0.72, modeProgress);
            const bufferBreath = !prefersReducedMotion && isBuffering && isPlaying && isNoLyricsMode
                ? 0.025 + Math.sin(timestamp / 520) * 0.008
                : 0;
            const pointCount = bands.length;
            const upperY = upperYRef.current;

            for (let i = 0; i < pointCount; i++) {
                const t = i / (pointCount - 1);
                const envelope = Math.pow(Math.sin(Math.PI * t), 0.18);
                const bandValue = Math.max(bufferBreath, bands[i] || 0);
                const bottomOffset = -bandValue * bottomAmplitude * envelope;
                const bidirectionalOffset = Math.sin(t * Math.PI * 10 + timestamp * 0.0032)
                    * bandValue
                    * specialAmplitude
                    * envelope;
                upperY[i] = waveAxisY + lerp(bottomOffset, bidirectionalOffset, specialReveal);
            }

            const traceSmoothWave = () => {
                context.beginPath();
                context.moveTo(waveStartX, upperY[0]);
                for (let i = 1; i < pointCount - 1; i++) {
                    const x = waveStartX + (i / (pointCount - 1)) * waveSpan;
                    const nextX = waveStartX + ((i + 1) / (pointCount - 1)) * waveSpan;
                    context.quadraticCurveTo(
                        x,
                        upperY[i],
                        (x + nextX) / 2,
                        (upperY[i] + upperY[i + 1]) / 2
                    );
                }
                context.lineTo(waveStartX + waveSpan, upperY[pointCount - 1]);
            };

            context.clearRect(0, 0, width, height);
            context.save();
            context.globalCompositeOperation = 'screen';

            if (fillOpacity > 0.002) {
                const bottomGradient = context.createLinearGradient(0, waveAxisY - bottomAmplitude, 0, waveAxisY);
                bottomGradient.addColorStop(0, `rgba(255,255,255,${fillOpacity * 0.14})`);
                bottomGradient.addColorStop(1, 'rgba(255,255,255,0)');
                traceSmoothWave();
                context.lineTo(waveStartX + waveSpan, waveAxisY);
                context.lineTo(waveStartX, waveAxisY);
                context.closePath();
                context.fillStyle = bottomGradient;
                context.fill();
            }

            if (specialReveal > 0.002) {
                const axisGradient = context.createLinearGradient(waveStartX, 0, waveStartX + waveSpan, 0);
                axisGradient.addColorStop(0, 'rgba(255,255,255,0)');
                axisGradient.addColorStop(0.18, `rgba(255,255,255,${specialReveal * 0.07})`);
                axisGradient.addColorStop(0.82, `rgba(255,255,255,${specialReveal * 0.07})`);
                axisGradient.addColorStop(1, 'rgba(255,255,255,0)');
                context.beginPath();
                context.moveTo(waveStartX, waveAxisY);
                context.lineTo(waveStartX + waveSpan, waveAxisY);
                context.strokeStyle = axisGradient;
                context.lineWidth = 1;
                context.stroke();
            }

            traceSmoothWave();
            context.shadowColor = `rgba(255,255,255,${specialReveal * (0.12 + smoothLevelRef.current * 0.18)})`;
            context.shadowBlur = 10 * specialReveal * Math.min(window.devicePixelRatio || 1, 1.5);
            context.strokeStyle = `rgba(255,255,255,${0.10 + smoothLevelRef.current * 0.24 + specialReveal * 0.12})`;
            context.lineWidth = (1.25 + specialReveal * 0.35) * Math.min(window.devicePixelRatio || 1, 1.5);
            context.stroke();
            context.restore();

            const transitionPending = Math.abs(targetModeProgress - modeProgress) > 0.0015;
            const energyPending = peak > 0.003 || smoothLevelRef.current > 0.003;
            const baselinePending = Math.abs(baselineActivityTarget - baselineActivityRef.current) > 0.0015;
            const bufferingVisual = !prefersReducedMotion && isNoLyricsMode && isPlaying && isBuffering;
            const shouldContinue = canSample || transitionPending || energyPending || baselinePending || bufferingVisual;

            if (shouldContinue) {
                animationRef.current = requestAnimationFrame(draw);
            } else if (modeProgress <= 0.002 && (analysisEnabled || isNoLyricsContext)) {
                drawBaseline(width, height, enabled || isNoLyricsContext ? 0.12 : 0);
                animationRef.current = null;
            } else {
                // Keep the already-rendered static short spectrum in special mode.
                animationRef.current = null;
            }
        };

        draw();
        return () => {
            running = false;
            if (animationRef.current) {
                cancelAnimationFrame(animationRef.current);
                animationRef.current = null;
            }
        };
    }, [analysisEnabled, analysisVersion, canvasVersion, containerRef, enabled, intensity, isBuffering, isNoLyricsContext, isNoLyricsMode, isPlaying, onModeCollapsed, prefersReducedMotion, renderPaused, suspended]);

    const visible = presentationReady && !renderPaused && (enabled || isNoLyricsContext || modeProgressRef.current > 0.002);

    return (
        <div
            className={`pointer-events-none absolute inset-0 z-[8] transition-opacity duration-700 ${visible ? 'opacity-100' : 'opacity-0'}`}
            aria-hidden="true"
        >
            <canvas ref={canvasRef} className="h-full w-full" />
        </div>
    );
}
