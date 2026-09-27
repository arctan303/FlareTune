export const DEFAULT_COVER_ACCENT = '#4f9da3';

const paletteCache = new Map();

export function rgbToHsl(r, g, b) {
  const rNorm = r / 255;
  const gNorm = g / 255;
  const bNorm = b / 255;
  const max = Math.max(rNorm, gNorm, bNorm);
  const min = Math.min(rNorm, gNorm, bNorm);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rNorm:
        h = ((gNorm - bNorm) / d + (gNorm < bNorm ? 6 : 0)) / 6;
        break;
      case gNorm:
        h = ((bNorm - rNorm) / d + 2) / 6;
        break;
      case bNorm:
        h = ((rNorm - gNorm) / d + 4) / 6;
        break;
      default:
        break;
    }
  }

  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

export function hslToRgb(h, s, l) {
  const hNorm = h / 360;
  const sNorm = s / 100;
  const lNorm = l / 100;

  if (sNorm === 0) {
    const val = Math.round(lNorm * 255);
    return { r: val, g: val, b: val };
  }

  const hue2rgb = (p, q, t) => {
    let tNorm = t;
    if (tNorm < 0) tNorm += 1;
    if (tNorm > 1) tNorm -= 1;
    if (tNorm < 1 / 6) return p + (q - p) * 6 * tNorm;
    if (tNorm < 1 / 2) return q;
    if (tNorm < 2 / 3) return p + (q - p) * (2 / 3 - tNorm) * 6;
    return p;
  };

  const q = lNorm < 0.5 ? lNorm * (1 + sNorm) : lNorm + sNorm - lNorm * sNorm;
  const p = 2 * lNorm - q;

  const r = Math.round(hue2rgb(p, q, hNorm + 1 / 3) * 255);
  const g = Math.round(hue2rgb(p, q, hNorm) * 255);
  const b = Math.round(hue2rgb(p, q, hNorm - 1 / 3) * 255);

  return { r, g, b };
}

export function rgbToHex({ r, g, b }) {
  const toHex = (c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function parseRgb(colorStr) {
  if (!colorStr || typeof colorStr !== 'string') return null;
  const match = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (match) {
    return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
  }
  const hex = colorStr.replace('#', '');
  if (hex.length === 6) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  return null;
}

export function clampColorForReadability(rgb, isDark) {
  if (!rgb) {
    return isDark
      ? { r: 125, g: 211, b: 252, hex: '#7dd3fc', css: 'rgb(125, 211, 252)' }
      : { r: 3, g: 105, b: 161, hex: '#0369a1', css: 'rgb(3, 105, 161)' };
  }

  let { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b);

  // 纯灰度/黑白专辑：用户明确指出“棕色还不如黑色”，低饱和度纯净墨黑呈现，绝不偏色
  if (s < 14) {
    return isDark
      ? { r: 244, g: 244, b: 245, hex: '#f4f4f5', css: 'rgb(244, 244, 245)' }
      : { r: 24, g: 24, b: 27, hex: '#18181b', css: 'rgb(24, 24, 27)' };
  }

  if (isDark) {
    // 深色模式：高亮晶莹发光色相，通透明亮
    let targetH = h;
    let targetS = Math.max(75, Math.min(100, s));
    let targetL = 78;
    if (h >= 40 && h <= 75) {
      targetL = 82; // 明亮金黄
    }
    const clampedRgb = hslToRgb(targetH, targetS, targetL);
    const hex = rgbToHex(clampedRgb);
    return { ...clampedRgb, hex, css: `rgb(${clampedRgb.r}, ${clampedRgb.g}, ${clampedRgb.b})` };
  } else {
    // 浅色模式：暖色系保持鲜明饱满，杜绝土黄/脏泥棕！
    let targetH = h;
    let targetS = Math.max(85, Math.min(100, s));
    let targetL = 42;

    if (h >= 40 && h <= 75) {
      // 亮黄/黄绿区间：微调至温暖饱满的琥珀暖金 (h -> 36)，饱满流金，绝不发绿发棕
      targetH = 36;
      targetL = 42;
      targetS = 96;
    } else if (h >= 15 && h < 40) {
      // 暖橘/蜜柑/赤陶：保持活泼明艳暖橘
      targetL = 44;
      targetS = 95;
    } else if (h < 15 || h >= 345) {
      // 暖红/朱红/玫瑰绯红：纯正明丽红韵
      targetL = 45;
      targetS = 92;
    } else if (h >= 75 && h <= 165) {
      // 翡翠/苍翠青绿
      targetL = 38;
      targetS = 85;
    } else if (h > 165 && h <= 200) {
      // 湖蓝/青黛海蓝
      targetL = 40;
      targetS = 90;
    } else if (h > 200 && h <= 250) {
      // 皇家宝蓝/蔚蓝
      targetL = 46;
      targetS = 90;
    } else {
      // 紫罗兰/品红
      targetL = 44;
      targetS = 85;
    }

    const clampedRgb = hslToRgb(targetH, targetS, targetL);
    const hex = rgbToHex(clampedRgb);
    return { ...clampedRgb, hex, css: `rgb(${clampedRgb.r}, ${clampedRgb.g}, ${clampedRgb.b})` };
  }
}

export function getPlayerThemeColors(extractedColor, isDark) {
  const baseRgb = typeof extractedColor === 'string' ? parseRgb(extractedColor) : extractedColor;
  const clamped = clampColorForReadability(baseRgb, isDark);
  const rawRgb = baseRgb || (isDark ? { r: 56, g: 189, b: 248 } : { r: 2, g: 132, b: 199 });

  const rawHsl = rgbToHsl(rawRgb.r, rawRgb.g, rawRgb.b);
  const hoverColor = isDark
    ? rgbToHex(hslToRgb(rawHsl.h, 85, 70))
    : rgbToHex(hslToRgb(rawHsl.h, 85, 42));

  return {
    accent: rgbToHex(rawRgb),
    lyricCurrent: clamped.hex,
    lyricUnheard: isDark ? 'rgba(255, 255, 255, 0.70)' : 'rgba(15, 23, 42, 0.58)',
    iconColor: isDark ? 'rgba(255, 255, 255, 0.90)' : 'rgba(15, 23, 42, 0.88)',
    iconHover: hoverColor,
    playColor: isDark ? '#ffffff' : '#09090b',
    textShadow: isDark
      ? '0 1px 3px rgba(0, 0, 0, 0.45)'
      : 'none',
  };
}

export function extractCoverPalette(imgElement) {
  if (!imgElement) return null;
  const src = imgElement.src;
  if (paletteCache.has(src)) return paletteCache.get(src);

  try {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    const size = 24;
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

    const avg = { r: Math.round(sumR / weight), g: Math.round(sumG / weight), b: Math.round(sumB / weight) };
    const dominant = bestVibrant || avg;
    paletteCache.set(src, dominant);
    return dominant;
  } catch {
    return null;
  }
}
