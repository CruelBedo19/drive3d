import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import type { WeatherSnapshot } from './WeatherState';

/**
 * Procedural sky: three.js' Preetham `Sky` add-on (MIT, ships animated fbm
 * clouds), with weather on top, injected into its fragment shader:
 *  - overcast greys and darkens it towards the fog colour,
 *  - a night gradient replaces the black Preetham night sky,
 *  - the horizon blends into the scene fog colour, so distant terrain fades
 *    into the sky without a seam.
 * Plus a star field. Both sit at the far plane, follow the camera and cost a
 * couple of draw calls; nothing is created per frame.
 */
const STARS = 1400;
/** The Preetham output is tuned for exposure ~0.5; the scene runs at ~1. */
const SKY_GAIN = 0.55;
const NIGHT_ZENITH = new THREE.Color(0x02050d);
const NIGHT_HORIZON = new THREE.Color(0x0c1730);

export class SkyDome {
  readonly sky: Sky;
  readonly stars: THREE.Points;
  private readonly skyUniforms: Record<string, THREE.IUniform>;
  private readonly extra = {
    uSkyGain: { value: SKY_GAIN },
    uOvercast: { value: 0 },
    uNight: { value: 0 },
    uFogColor: { value: new THREE.Color() },
    uHorizonFog: { value: 0.5 },
    uNightZenith: { value: NIGHT_ZENITH },
    uNightHorizon: { value: NIGHT_HORIZON },
  };
  private readonly starMaterial: THREE.PointsMaterial;
  private time = 0;

  constructor() {
    this.sky = new Sky();
    this.sky.scale.setScalar(100);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    const material = this.sky.material as THREE.ShaderMaterial;
    this.skyUniforms = material.uniforms;
    this.skyUniforms.cloudScale.value = 0.00025;
    this.skyUniforms.cloudSpeed.value = 0.00003;
    this.skyUniforms.cloudElevation.value = 0.55;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.extra);
      shader.fragmentShader =
        `uniform float uSkyGain; uniform float uOvercast; uniform float uNight; uniform vec3 uFogColor; uniform float uHorizonFog; uniform vec3 uNightZenith; uniform vec3 uNightHorizon;\n` +
        shader.fragmentShader.replace(
          'gl_FragColor = vec4( texColor, 1.0 );',
          `vec3 col = texColor * uSkyGain;
          // Weather: grey and darker towards the fog colour.
          col = mix( col, uFogColor * 1.08, uOvercast );
          // Night: the Preetham sky goes black after sunset; give it a deep blue gradient.
          vec3 nightSky = mix( uNightHorizon, uNightZenith, smoothstep( 0.0, 0.45, direction.y ) );
          col = mix( col, max( col, nightSky ), uNight );
          // Horizon (and below) melts into the fog so terrain fades into the sky without a seam.
          float horizon = 1.0 - smoothstep( -0.02, 0.18, direction.y );
          col = mix( col, uFogColor, clamp( horizon * ( 0.35 + uHorizonFog ), 0.0, 1.0 ) );
          gl_FragColor = vec4( col, 1.0 );`,
        );
    };

    // Stars: a sphere of points pushed to the far plane (behind everything, in front of the sky).
    const pos = new Float32Array(STARS * 3);
    const col = new Float32Array(STARS * 3);
    let seed = 0x2545f491;
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < STARS; i++) {
      const y = Math.pow(rand(), 0.6);
      const r = Math.sqrt(1 - y * y);
      const a = rand() * Math.PI * 2;
      pos.set([Math.cos(a) * r * 40, y * 40, Math.sin(a) * r * 40], i * 3);
      const m = 0.35 + Math.pow(rand(), 2.5) * 0.65;
      col.set([m, m, m * (0.92 + rand() * 0.08)], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.starMaterial = new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, fog: false });
    this.starMaterial.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace('#include <fog_vertex>', '#include <fog_vertex>\n\tgl_Position.z = gl_Position.w;');
    };
    this.stars = new THREE.Points(g, this.starMaterial);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -9;
  }

  /** Low weather quality turns the clouds off (the cloud fbm is the sky's main cost). */
  setCloudsEnabled(enabled: boolean): void {
    this.cloudsEnabled = enabled;
  }

  private cloudsEnabled = true;

  update(dt: number, camera: THREE.Vector3, s: WeatherSnapshot): void {
    this.time += dt;
    this.sky.position.copy(camera);
    this.stars.position.copy(camera);
    const u = this.skyUniforms;
    (u.sunPosition.value as THREE.Vector3).set(s.sun.x, s.sun.y, s.sun.z);
    u.turbidity.value = s.turbidity;
    u.rayleigh.value = s.rayleigh;
    u.mieCoefficient.value = s.mie;
    u.mieDirectionalG.value = s.mieG;
    u.cloudCoverage.value = this.cloudsEnabled ? s.cloudCoverage : 0;
    u.cloudDensity.value = s.cloudDensity;
    u.time.value = this.time * 1000;
    this.extra.uOvercast.value = s.overcast * 0.85;
    this.extra.uNight.value = s.night;
    this.extra.uFogColor.value.setHex(s.fogColor);
    this.extra.uHorizonFog.value = 1 - Math.min(1, s.visibility);
    this.starMaterial.opacity = s.stars * 0.9;
    this.stars.visible = s.stars > 0.02;
  }

  dispose(): void {
    this.sky.geometry.dispose();
    (this.sky.material as THREE.Material).dispose();
    this.stars.geometry.dispose();
    this.starMaterial.dispose();
    this.sky.removeFromParent();
    this.stars.removeFromParent();
  }
}
