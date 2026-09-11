type VibrateNav = Navigator & {
  vibrate?: (pattern: number | number[]) => boolean;
  webkitVibrate?: (pattern: number | number[]) => boolean;
};

let clickAudio: HTMLAudioElement | null = null;

function isIOS() {
  if (typeof navigator === 'undefined') return false;
  return /iP(hone|ad|od)/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function getVibrate(): ((pattern: number | number[]) => boolean) | null {
  if (typeof navigator === 'undefined') return null;
  const nav = navigator as VibrateNav;
  const fn = nav.vibrate || nav.webkitVibrate;
  if (typeof fn !== 'function') return null;
  return fn.bind(nav);
}

function buildClickWav(): string {
  const sampleRate = 22050;
  const samples = Math.floor(sampleRate * 0.04);
  const dataSize = samples * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-t * 80);
    const sample = Math.sin(2 * Math.PI * 140 * t) * env;
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * 32767, true);
  }
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

function getClickAudio(): HTMLAudioElement | null {
  if (typeof Audio === 'undefined') return null;
  if (!clickAudio) {
    clickAudio = new Audio(buildClickWav());
    clickAudio.preload = 'auto';
    clickAudio.volume = 0.4;
  }
  return clickAudio;
}

function playClick() {
  const audio = getClickAudio();
  if (!audio) return;
  audio.currentTime = 0;
  const play = audio.play();
  if (play && typeof play.catch === 'function') play.catch(() => {});
}

export function primeHaptic() {
  const audio = getClickAudio();
  if (!audio) return;
  audio.muted = true;
  const p = audio.play();
  if (p && typeof p.then === 'function') {
    p.then(() => {
      audio.pause();
      audio.currentTime = 0;
      audio.muted = false;
    }).catch(() => {
      audio.muted = false;
    });
  }
}

export function triggerHaptic(enabled: boolean) {
  if (!enabled) return;
  if (isIOS()) {
    playClick();
    return;
  }
  const vibrate = getVibrate();
  if (vibrate) {
    try {
      vibrate(80);
      return;
    } catch {
      // fall through
    }
  }
  playClick();
}
