import React from 'react';

export default function QualityBadge({ format, className = "" }) {
    if (!format || !format.bitrate) return null;

    let qualityType = null;
    let label = '';

    const bitrate = format.bitrate;
    const sampleRate = format.sampleRate || 44100;
    const codec = format.codec ? format.codec.toUpperCase() : '';

    if (bitrate >= 800000 || codec === 'FLAC' || codec === 'ALAC' || codec === 'WAV') {
        if (sampleRate >= 96000) {
            qualityType = 'hires';
            label = 'Hi-Res';
        } else {
            qualityType = 'sq';
            label = 'SQ';
        }
    } else if (bitrate >= 320000) {
        qualityType = 'hq';
        label = 'HQ';
    }

    if (!qualityType) return null;

    return (
        <span 
            data-quality={qualityType}
            className={`quality-badge inline-flex items-center justify-center px-1 py-[1px] border rounded text-[9px] font-bold tracking-wider leading-none ml-2 ${className}`}
            title={`Bitrate: ${Math.round(bitrate / 1000)} kbps | Sample Rate: ${Math.round(sampleRate / 1000)} kHz`}
        >
            {label}
        </span>
    );
}
