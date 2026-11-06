"use strict";

function playChime() {
  const context = new AudioContext();
  const now = context.currentTime;
  function tone(frequency, start, duration) {
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = "sine";
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain).connect(context.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }
  tone(784, now, 0.12);
  tone(1174, now + 0.14, 0.16);
  setTimeout(() => context.close(), 700);
}
