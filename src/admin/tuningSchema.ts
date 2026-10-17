/** Every value the admin panel exposes, grouped. Paths point into VehicleConfig. */

export type TuningParam =
  | { kind: 'number'; path: string; label: string; min: number; max: number; step: number; unit?: string; hint?: string }
  | { kind: 'select'; path: string; label: string; options: readonly string[]; hint?: string }
  | { kind: 'list'; path: string; label: string; hint?: string };

export interface TuningGroup {
  id: string;
  title: string;
  params: TuningParam[];
}

const n = (path: string, label: string, min: number, max: number, step: number, unit?: string, hint?: string): TuningParam => ({
  kind: 'number',
  path,
  label,
  min,
  max,
  step,
  unit,
  hint,
});

export const TUNING_GROUPS: TuningGroup[] = [
  {
    id: 'general',
    title: 'Genel',
    params: [
      n('chassis.mass', 'Kütle', 600, 3000, 10, 'kg'),
      { kind: 'select', path: 'drivetrain', label: 'Çekiş', options: ['RWD', 'FWD', 'AWD'] },
      n('awdFrontSplit', 'AWD ön tork payı', 0, 1, 0.01, '', 'Sadece AWD'),
      n('maxSpeedKmh', 'Maks. hız', 60, 400, 1, 'km/h'),
      n('maxReverseKmh', 'Maks. geri hız', 5, 80, 1, 'km/h'),
    ],
  },
  {
    id: 'engine',
    title: 'Motor',
    params: [
      n('engine.maxPowerKw', 'Güç', 40, 900, 1, 'kW'),
      n('engine.peakTorqueNm', 'Maks. tork', 80, 1400, 5, 'Nm'),
      n('engine.redlineRpm', 'Redline', 4000, 10000, 50, 'rpm'),
      n('engine.idleRpm', 'Rölanti', 500, 1500, 10, 'rpm'),
      n('engine.engineBrakingNm', 'Motor freni', 0, 300, 5, 'Nm'),
      n('engine.inertia', 'Motor ataleti', 0.05, 0.6, 0.01, 'kg·m²', 'Düşük = devir hızlı çıkar, patinaj kolay'),
      n('engine.launchRpm', 'Kalkış devri', 0, 4000, 50, 'rpm', 'Rölanti üstü debriyaj kaydırma'),
    ],
  },
  {
    id: 'gearbox',
    title: 'Şanzıman',
    params: [
      { kind: 'list', path: 'gearbox.ratios', label: 'Vites oranları', hint: '1. vitesten 6. vitese, virgülle' },
      n('gearbox.finalDrive', 'Son oran', 2, 6, 0.01),
      n('gearbox.reverseRatio', 'Geri oran', 2, 5, 0.01),
      n('gearbox.shiftUpRpm', 'Vites yükseltme', 3000, 10000, 50, 'rpm'),
      n('gearbox.shiftDownRpm', 'Vites düşürme', 1000, 6000, 50, 'rpm'),
      n('gearbox.shiftTime', 'Vites süresi', 0, 1, 0.01, 's'),
      n('gearbox.efficiency', 'Verim', 0.5, 1, 0.01),
    ],
  },
  {
    id: 'diff',
    title: 'Diferansiyel',
    params: [
      { kind: 'select', path: 'differential.type', label: 'Tip', options: ['OPEN', 'LSD'] },
      n('differential.powerLock', 'Gazda kilit', 0, 1, 0.01, '', 'LSD: tork oranı'),
      n('differential.coastLock', 'Gazsız kilit', 0, 1, 0.01),
      n('differential.preload', 'Ön yük', 0, 600, 5, 'Nm'),
    ],
  },
  {
    id: 'tires',
    title: 'Lastik / Grip',
    params: [
      n('tires.friction', 'Sürtünme (µ)', 0.3, 2, 0.01),
      n('front.grip', 'Ön grip', 0.5, 1.5, 0.01),
      n('rear.grip', 'Arka grip', 0.5, 1.5, 0.01),
      n('tires.longitudinalGrip', 'Boyuna grip', 0.5, 1.5, 0.01),
      n('tires.peakSlipAngle', 'Tepe kayma açısı', 0.04, 0.4, 0.005, 'rad'),
      n('tires.peakSlipRatio', 'Tepe kayma oranı', 0.03, 0.3, 0.005),
      n('tires.curveShape', 'Tepe sonrası düşüş', 1, 1.9, 0.01, '', '1 = düşüş yok, 1.6+ = sert'),
      n('tires.rollInfluence', 'Yalpa etkisi', 0, 1, 0.01, '', '0 = hiç yalpa, 1 = tam fiziksel'),
    ],
  },
  {
    id: 'steering',
    title: 'Direksiyon',
    params: [
      n('steering.maxAngleDeg', 'Maks. açı', 10, 70, 0.5, '°'),
      n('steering.highSpeedAngleDeg', 'Yüksek hız açısı', 2, 40, 0.5, '°'),
      n('steering.highSpeedKmh', 'Yüksek hız eşiği', 40, 300, 5, 'km/h'),
      n('steering.steerSpeed', 'Çevirme hızı', 0.5, 10, 0.1, '/s'),
      n('steering.returnSpeed', 'Toplama hızı', 0.5, 12, 0.1, '/s'),
      n('steering.highSpeedRateScale', 'Hızda çevirme oranı', 0.1, 1, 0.01),
      n('steering.gripLimitFactor', 'Grip limiti', 0, 6, 0.05, '', '0 = kapalı'),
      n('steering.countersteerAssist', 'Karşı direksiyon yardımı', 0, 1, 0.01, '', 'Kayınca tekerlekleri gidiş yönüne çevirir'),
      n('steering.keyboardRamp', 'Klavye rampası', 0, 1, 0.01, 's', 'Kısa dokunuş = küçük açı; 0 = doğrusal'),
      n('steering.inputExpo', 'Direksiyon eğrisi (expo)', 1, 3, 0.05, '', '>1 = merkezde daha hassas'),
      n('steering.counterSteerLimitDeg', 'Aşırı karşı direksiyon sınırı', 0, 40, 1, '°', '0 = kapalı'),
    ],
  },
  {
    id: 'brakes',
    title: 'Fren',
    params: [
      n('brakes.maxForce', 'Fren kuvveti', 2000, 40000, 100, 'N'),
      n('brakes.frontBias', 'Ön fren dağılımı', 0.3, 0.9, 0.01),
      n('brakes.handbrakeForce', 'El freni kuvveti', 0, 20000, 100, 'N'),
      n('brakes.handbrakeRearGrip', 'El freninde arka grip', 0.2, 1, 0.01),
    ],
  },
  {
    id: 'assists',
    title: 'Asistler',
    params: [
      n('assists.tractionControl', 'Çekiş kontrolü (TC)', 0, 1, 0.01, '', '0 = kapalı'),
      n('assists.abs', 'ABS', 0, 1, 0.01, '', '0 = kapalı'),
      n('assists.stability', 'Spin sınırlayıcı', 0, 1, 0.01, '', '0 = kapalı (saf fizik)'),
      n('assists.maxSlipDeg', 'İzin verilen kayma açısı', 3, 90, 1, '°', 'Eşik modu (kademeli eğri yoksa)'),
      n('assists.countersteerRelief', 'Karşı direksiyonda geri çekilme', 0, 1, 0.01, '', 'Kademeli mod: oyuncu kontrol ederken yardım azalır'),
      n('assists.wheelspinLimit', 'Patinaj sınırı (drift TC)', 0, 3, 0.01, 'κ', '0 = kapalı'),
      n('assists.recovery', 'Kayma toparlama', 0, 1, 0.01, '', 'Direksiyon bırakınca kademeli düzeltme'),
    ],
  },
  {
    id: 'suspension',
    title: 'Süspansiyon',
    params: [
      n('suspension.stiffness', 'Yay sertliği', 10000, 120000, 500, 'N/m'),
      n('suspension.compressionDamping', 'Sıkışma sönümü', 500, 12000, 50, 'N·s/m'),
      n('suspension.reboundDamping', 'Geri dönüş sönümü', 500, 12000, 50, 'N·s/m'),
      n('suspension.restLength', 'Yay boyu', 0.15, 0.6, 0.01, 'm'),
      n('front.antiRoll', 'Ön viraj demiri', 0, 60000, 500, 'N/m'),
      n('rear.antiRoll', 'Arka viraj demiri', 0, 60000, 500, 'N/m'),
    ],
  },
  {
    id: 'chassis',
    title: 'Şasi / Aero',
    params: [
      n('chassis.centerOfMass.y', 'Ağırlık merkezi yükseklik', -0.4, 0.3, 0.01, 'm'),
      n('chassis.centerOfMass.z', 'Ağırlık merkezi ön/arka', -0.8, 0.8, 0.01, 'm', '+ = öne'),
      n('chassis.angularDamping', 'Açısal sönüm', 0, 3, 0.05),
      n('chassis.dragCoefficient', 'Hava direnci', 0, 1.5, 0.01),
      n('chassis.downforce', 'Downforce', 0, 3, 0.01),
      n('wheel.inertia', 'Tekerlek ataleti', 0.3, 4, 0.05, 'kg·m²'),
    ],
  },
];
