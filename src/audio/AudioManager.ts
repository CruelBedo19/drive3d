import type { AudioSettings } from '../settings/Settings';

/** Mixer channels future sound sources connect to. */
export type AudioChannel = 'engine' | 'tyres' | 'ambience' | 'music';

export const AUDIO_CHANNELS: readonly AudioChannel[] = ['engine', 'tyres', 'ambience', 'music'];

/** Effective 0..1 gain of each channel for the given settings (master, mute and music switch applied). */
export function channelGains(s: AudioSettings): Record<AudioChannel, number> {
  const master = s.muteAll ? 0 : s.master;
  return {
    engine: master * s.engine,
    tyres: master * s.tyres,
    ambience: master * s.ambience,
    music: s.musicEnabled ? master * s.music : 0,
  };
}

/**
 * Central audio mixer. No sound exists yet, so nothing is created until a
 * source asks for its channel: then a Web Audio context and one gain node per
 * channel are made (browsers only allow this after a user gesture), already set
 * from the settings. Sources: `audio.channel('engine')` → connect to the node.
 */
export class AudioManager {
  private settings: AudioSettings;
  private context: AudioContext | null = null;
  private nodes: Partial<Record<AudioChannel, GainNode>> = {};

  constructor(settings: AudioSettings) {
    this.settings = settings;
  }

  get gains(): Record<AudioChannel, number> {
    return channelGains(this.settings);
  }

  apply(settings: AudioSettings): void {
    this.settings = settings;
    if (!this.context) return;
    const g = this.gains;
    for (const ch of AUDIO_CHANNELS) this.nodes[ch]?.gain.setTargetAtTime(g[ch], this.context.currentTime, 0.05);
  }

  /** The gain node a sound source on this channel should connect to (creates the context on first use). */
  channel(ch: AudioChannel): GainNode | null {
    if (!this.context) {
      if (typeof AudioContext === 'undefined') return null;
      this.context = new AudioContext();
      const g = this.gains;
      for (const c of AUDIO_CHANNELS) {
        const node = this.context.createGain();
        node.gain.value = g[c];
        node.connect(this.context.destination);
        this.nodes[c] = node;
      }
    }
    return this.nodes[ch] ?? null;
  }

  dispose(): void {
    void this.context?.close();
    this.context = null;
    this.nodes = {};
  }
}
