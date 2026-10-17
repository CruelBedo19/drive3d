import type { Vehicle } from '../vehicle/Vehicle';

const REFRESH_INTERVAL = 0.1;

/** Development-only text panel (F3). Refreshes 10x per second to keep DOM work low. */
export class DebugOverlay {
  private readonly root: HTMLPreElement;
  private visible = false;
  private timer = 0;
  /** Car / setup / camera line (developer info, kept out of the player HUD). */
  label = '';
  /** Frame cost line (what the PC could do without vsync). */
  perf = '';

  constructor(parent: HTMLElement) {
    this.root = document.createElement('pre');
    this.root.className = 'debug-overlay';
    this.root.hidden = true;
    parent.appendChild(this.root);
  }

  toggle(): void {
    this.visible = !this.visible;
    this.root.hidden = !this.visible;
    this.timer = REFRESH_INTERVAL;
  }

  update(dt: number, vehicle: Vehicle, fps: number, frameMs: number, physicsSteps: number, physicsDebug: boolean): void {
    if (!this.visible) return;
    this.timer += dt;
    if (this.timer < REFRESH_INTERVAL) return;
    this.timer = 0;

    const t = vehicle.telemetry;
    const p = t.position;
    const v = t.velocity;
    const wheels = vehicle.physics.wheels
      .map((w, i) => {
        const name = ['FL', 'FR', 'RL', 'RR'][i];
        return (
          `${name} ${w.grounded ? 'G' : '-'}${w.locked ? 'L' : ' '} load ${pad(w.load.toFixed(0), 5)}N  ` +
          `ω ${pad(w.angularVelocity.toFixed(1), 6)}  κ ${pad(w.slipRatio.toFixed(2), 5)}  α ${pad(((w.slipAngle * 180) / Math.PI).toFixed(1), 5)}°  ` +
          `T ${pad(w.command.driveTorque.toFixed(0), 5)}  slip ${w.combinedSlip.toFixed(2)}`
        );
      })
      .join('\n');

    this.root.textContent =
      `${this.label}\n` +
      `FPS        ${fps.toFixed(0)} (${frameMs.toFixed(1)} ms)  phys steps/frame ${physicsSteps}\n` +
      `${this.perf}\n` +
      `speed      ${t.speedKmh.toFixed(1)} km/h  (fwd ${(t.forwardSpeed * 3.6).toFixed(1)})\n` +
      `gear / rpm ${t.gear} / ${t.rpm.toFixed(0)}\n` +
      `position   ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}\n` +
      `velocity   ${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)}\n` +
      `grounded   ${t.groundedWheels}/4 ${t.groundedWheels > 0 ? 'yes' : 'NO (airborne)'}\n` +
      `drift angle ${t.bodySlipDeg.toFixed(1)}°  rear LSD transfer ${vehicle.rearDiff.transfer.toFixed(0)} Nm\n` +
      `throttle ${t.throttle.toFixed(2)} brake ${t.brake.toFixed(2)} handbrake ${t.handbrake.toFixed(2)} steer ${((t.steerAngle * 180) / Math.PI).toFixed(1)}°\n` +
      `${wheels}\n` +
      `F3 panel · F4 colliders ${physicsDebug ? 'ON' : 'off'}`;
  }

  dispose(): void {
    this.root.remove();
  }
}

function pad(s: string, n: number): string {
  return s.padStart(n, ' ');
}
