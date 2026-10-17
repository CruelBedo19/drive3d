import * as THREE from 'three';
import { GAME_CONFIG } from '../config/gameConfig';
import type { GraphicsSettings, RenderDistance, ShadowQuality } from '../settings/Settings';

const SHADOW_MAP: Record<Exclude<ShadowQuality, 'off'>, { size: number; range: number }> = {
  low: { size: 512, range: 28 },
  medium: { size: 1024, range: 34 },
  high: { size: GAME_CONFIG.render.shadowMapSize, range: GAME_CONFIG.render.shadowRange },
};
const RENDER_DISTANCE: Record<RenderDistance, number> = { short: 0.6, medium: 1, far: 1.6 };

/**
 * WebGL renderer, scene, base lighting and resize handling. The sun's shadow
 * camera follows a focus point (the player car) so one shadow map covers the
 * area that matters, independent of world size.
 */
export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly fog: THREE.Fog;

  private readonly container: HTMLElement;
  private readonly sunOffset = new THREE.Vector3(-40, 70, -30);
  private readonly resizeObserver: ResizeObserver;
  private resolutionScale = 1;
  /** Fog set by the world, scaled by the view-distance setting and the weather. */
  private fogBase = { near: 150, far: 650 };
  private fogDistanceScale = 1;
  private fogWeatherScale = 1;

  /** `antialias` can only be chosen here (WebGL limitation): changing it needs a reload. */
  constructor(container: HTMLElement, antialias = true) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, GAME_CONFIG.render.maxPixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.05, 1500);

    this.scene.background = new THREE.Color(0x9fb8cf);
    this.fog = new THREE.Fog(0x9fb8cf, 150, 650);
    this.scene.fog = this.fog;

    this.hemi = new THREE.HemisphereLight(0xdfeeff, 0x3a3328, 1.1);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
    this.sun.castShadow = true;
    const size = GAME_CONFIG.render.shadowMapSize;
    this.sun.shadow.mapSize.set(size, size);
    const r = GAME_CONFIG.render.shadowRange;
    const sc = this.sun.shadow.camera;
    sc.left = -r;
    sc.right = r;
    sc.top = r;
    sc.bottom = -r;
    sc.near = 1;
    sc.far = 260;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  /** The world's fog distances (before view-distance and weather scaling). */
  setFog(near: number, far: number): void {
    this.fogBase = { near, far };
    this.updateFog();
  }

  /** Weather visibility: < 1 pulls the fog in (fog, rain), 1 = clear. */
  setWeatherFogScale(scale: number): void {
    this.fogWeatherScale = scale;
    this.updateFog();
  }

  /** Applies the graphics settings that can change at runtime (not antialias). */
  applyGraphics(g: GraphicsSettings): void {
    this.resolutionScale = g.resolutionScale;
    this.resize();
    if (g.shadows === 'off') {
      this.sun.castShadow = false;
    } else {
      const q = SHADOW_MAP[g.shadows];
      this.sun.castShadow = true;
      if (this.sun.shadow.mapSize.x !== q.size) {
        this.sun.shadow.mapSize.set(q.size, q.size);
        // The shadow map is reallocated at the new size on the next render.
        this.sun.shadow.map?.dispose();
        this.sun.shadow.map = null;
      }
      const sc = this.sun.shadow.camera;
      sc.left = -q.range;
      sc.right = q.range;
      sc.top = q.range;
      sc.bottom = -q.range;
      sc.updateProjectionMatrix();
    }
    this.fogDistanceScale = RENDER_DISTANCE[g.renderDistance];
    this.updateFog();
  }

  private updateFog(): void {
    const k = this.fogDistanceScale * this.fogWeatherScale;
    this.fog.near = this.fogBase.near * k;
    this.fog.far = this.fogBase.far * k;
    // Nothing beyond the fog is visible: no need to draw it.
    this.camera.far = Math.max(400, this.fogBase.far * this.fogDistanceScale * 1.2);
    this.camera.updateProjectionMatrix();
  }

  /** Direction and distance of the sun from the focus point (weather / time of day). */
  setSunOffset(offset: THREE.Vector3): void {
    this.sunOffset.copy(offset);
  }

  /** Moves the sun and its shadow frustum along with `focus`. */
  setShadowFocus(focus: THREE.Vector3): void {
    this.sun.position.copy(focus).add(this.sunOffset);
    this.sun.target.position.copy(focus);
  }

  /** Draws the driving scene, or another scene (garage) with its own camera. */
  render(scene: THREE.Scene = this.scene, camera: THREE.Camera = this.camera): void {
    this.renderer.render(scene, camera);
  }

  /** Size of the drawing area in CSS pixels. */
  get size(): { width: number; height: number } {
    return { width: Math.max(1, this.container.clientWidth), height: Math.max(1, this.container.clientHeight) };
  }

  resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, GAME_CONFIG.render.maxPixelRatio) * this.resolutionScale);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
