// Tiny WebAudio game sounds — no audio files, no downloads, zero bundle cost.
// All sounds are short oscillator blips, so they cost nothing on mobile data
// and work on any platform with a browser. AudioContext is created lazily
// on the first user gesture, so browsers never block it as autoplay.
let ctx = null;
let muted = typeof localStorage !== 'undefined' && localStorage.getItem('pr_muted') === '1';
function ac() {
  if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { return null; } }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
export function isMuted() { return muted; }
export function setMuted(v) { muted = !!v; try { localStorage.setItem('pr_muted', muted ? '1' : '0'); } catch (_) {} }
if (typeof window !== 'undefined') window.addEventListener('pointerdown', () => ac(), { once: true });
function tone(freq, dur, type = 'sine', gain = 0.12, when = 0) {
  if (muted) return; const c = ac(); if (!c) return;
  const t = c.currentTime + when; const o = c.createOscillator(); const g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t); g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur); o.connect(g); g.connect(c.destination);
  o.start(t); o.stop(t + dur);
}
export const sfx = {
  tap() { tone(600, 0.06, 'triangle', 0.08); },
  coin() { tone(1200, 0.08, 'square', 0.06); tone(1800, 0.12, 'sine', 0.08, 0.05); },
  bell() { tone(1568, 0.4, 'sine', 0.14); tone(2093, 0.5, 'sine', 0.1, 0.08); },
  win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, 'triangle', 0.1, i * 0.09)); },
  lose() { tone(220, 0.25, 'sawtooth', 0.05); tone(165, 0.3, 'sawtooth', 0.05, 0.12); },
};
