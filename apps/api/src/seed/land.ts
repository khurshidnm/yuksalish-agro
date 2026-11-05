import { addDays, todayIso } from '@yap/shared';
import { and, eq } from 'drizzle-orm';
import { ctx, tx } from '../core/context';
import { computeAreaHa } from '../core/geo';
import { schema } from '../db/client';
import { createDocument } from '../modules/farm/documents.service';
import { createFacility } from '../modules/farm/facilities.service';
import { createField } from '../modules/farm/fields.service';
import { createIrrigation } from '../modules/farm/irrigation.service';
import { updatePassport } from '../modules/farm/passport.service';
import { createSoil } from '../modules/farm/soil.service';
import { refreshWeather } from '../modules/farm/weather.service';
import { findFacility, findField } from './lookup';
import { SEED } from './names';
import type { SeedContext } from './types';

/**
 * Layout of the 210 ha in metres, x east and y north, measured from the farm's point on the map.
 * Traced on satellite imagery around that point: the fields around it and the yard follow what is on
 * the ground, the northern fields lie between the two canals, and the pasture is the open steppe
 * beyond the canal. Not surveyed, so they are compared with the cadastre and corrected on the map.
 */
const ORIGIN = { lng: 64.794201, lat: 39.743439, x: 0, y: 0 };

/** Metres per degree at latitude 39.74 on the WGS84 spheroid. */
const M_PER_DEG_LNG = 85_705;
const M_PER_DEG_LAT = 111_030;

type Corner = [x: number, y: number];

function toRing(corners: Corner[]): [number, number][] {
  const points = corners.map(([x, y]): [number, number] => [
    Number((ORIGIN.lng + (x - ORIGIN.x) / M_PER_DEG_LNG).toFixed(9)),
    Number((ORIGIN.lat + (y - ORIGIN.y) / M_PER_DEG_LAT).toFixed(9)),
  ]);
  return [...points, points[0]];
}

const polygon = (corners: Corner[]) => ({ type: 'Polygon' as const, coordinates: [toRing(corners)] });

function pointOf([x, y]: Corner) {
  return { lng: ORIGIN.lng + (x - ORIGIN.x) / M_PER_DEG_LNG, lat: ORIGIN.lat + (y - ORIGIN.y) / M_PER_DEG_LAT };
}

/** Scale a contour about its centre until PostGIS measures exactly the target area. */
async function fitToArea(corners: Corner[], targetHa: number) {
  const cx = corners.reduce((sum, [x]) => sum + x, 0) / corners.length;
  const cy = corners.reduce((sum, [, y]) => sum + y, 0) / corners.length;
  let scale = 1;
  let shape = polygon(corners);
  for (let i = 0; i < 4; i++) {
    const measured = await computeAreaHa(shape);
    if (Math.abs(measured - targetHa) < 0.00004) break;
    scale *= Math.sqrt(targetHa / measured);
    shape = polygon(corners.map(([x, y]) => [cx + (x - cx) * scale, cy + (y - cy) * scale]));
  }
  return shape;
}

const TRACED = "Sun'iy yo'ldosh suratidan chizilgan, kadastr ma'lumoti bilan solishtiriladi.";

const CONTOURS: {
  number: string;
  name: string;
  landUse: 'arable' | 'pasture' | 'reserve' | 'yard' | 'infrastructure';
  areaHa: number;
  corners: Corner[];
  soilType?: string;
  salinityLevel?: string;
  irrigationSource?: string;
  notes?: string;
}[] = [
  {
    number: SEED.field.wheat1,
    name: "G'arbiy massiv",
    landUse: 'arable',
    areaHa: 10,
    corners: [[-193, 112], [-62, 152], [-110, -368], [-244, -375], [-322, -292], [-336, -127]],
    soilType: "O'tloqi-bo'z",
    salinityLevel: 'low',
    irrigationSource: 'Magistral kanal',
  },
  {
    number: SEED.field.wheat2,
    name: 'Sharqiy massiv',
    landUse: 'arable',
    areaHa: 9,
    corners: [[-62, 152], [108, 228], [211, 180], [86, -7], [64, -136], [13, -255], [-24, -356], [-110, -368]],
    soilType: "O'tloqi-bo'z",
    salinityLevel: 'low',
    irrigationSource: 'Magistral kanal',
  },
  {
    number: SEED.field.wheat3,
    name: 'Shimoli-g\'arbiy dala',
    landUse: 'arable',
    areaHa: 18,
    corners: [[-640, 505], [-430, 520], [-120, 625], [-105, 900], [-600, 905]],
    soilType: "O'tloqi-bo'z",
    salinityLevel: 'low',
    irrigationSource: 'Ariq №1',
  },
  {
    number: SEED.field.barley,
    name: 'Arpa dalasi',
    landUse: 'arable',
    areaHa: 15,
    corners: [[-110, 250], [300, 232], [330, 585], [-110, 622]],
    soilType: "Bo'z tuproq",
    salinityLevel: 'medium',
    irrigationSource: 'Ariq №1',
  },
  {
    number: SEED.field.alfalfa,
    name: 'Beda dalasi',
    landUse: 'arable',
    areaHa: 28,
    corners: [[-100, 630], [330, 592], [655, 598], [695, 640], [640, 790], [520, 930], [300, 1000], [100, 1055], [-60, 1000], [-95, 880]],
    soilType: "O'tloqi",
    salinityLevel: 'low',
    irrigationSource: 'Magistral kanal',
  },
  {
    number: SEED.field.corn,
    name: 'Silos dalasi',
    landUse: 'arable',
    areaHa: 10,
    corners: [[300, 232], [515, 215], [625, 430], [640, 590], [330, 585]],
    soilType: "O'tloqi",
    salinityLevel: 'low',
    irrigationSource: 'Magistral kanal',
  },
  {
    number: SEED.field.yard,
    name: 'Molxona va hovli',
    landUse: 'yard',
    areaHa: 5,
    corners: [[95, -30], [335, -180], [345, -300], [30, -300], [72, -140]],
    notes: TRACED,
  },
  {
    number: SEED.field.infrastructure,
    name: "Yo'llar, suv, elektr",
    landUse: 'infrastructure',
    areaHa: 3,
    corners: [[395, -110], [575, 195], [668, 420], [728, 640], [706, 640], [632, 430], [535, 205], [360, -100]],
    notes: TRACED,
  },
  {
    number: SEED.field.reserve,
    name: 'Zaxira hududi',
    landUse: 'reserve',
    areaHa: 8,
    corners: [[215, 178], [510, 190], [375, -60], [335, -150], [110, -30]],
    notes: TRACED,
  },
  {
    number: SEED.field.pasture,
    name: 'Yaylov',
    landUse: 'pasture',
    areaHa: 104,
    corners: [[-640, 1890], [420, 1210], [660, 1330], [660, 2000], [0, 2330], [-640, 2330]],
    notes: TRACED,
  },
];

export async function seedLand(s: SeedContext): Promise<void> {
  await s.run(async () => {
    const now = todayIso();

    await updatePassport({
      lat: ORIGIN.lat,
      lng: ORIGIN.lng,
      cadastreNumber: '06:11:02:01:0147',
      passport: {
        landRightType: 'Uzoq muddatli ijara',
        leaseContractNo: 'IJ-2021/118',
        leaseContractDate: '2021-03-15',
        leaseValidUntil: '2070-03-15',
        responsiblePersons: [
          { role: 'Ferma rahbari', fullName: 'Bahodir Rahimov', phone: '+998900000002' },
          { role: 'Agronom', fullName: 'Sardor Toshev', phone: '+998900000004' },
          { role: 'Zootexnik', fullName: 'Jasur Ergashev', phone: '+998900000005' },
        ],
      },
    });

    for (const contour of CONTOURS) {
      const { corners, areaHa, ...values } = contour;
      await createField({ ...values, boundary: await fitToArea(corners, areaHa) });
    }

    // Rounding after the fit can leave a hair's difference; the plan's hectares are the agreed figures.
    for (const contour of CONTOURS) {
      await tx()
        .update(schema.fields)
        .set({ areaHa: contour.areaHa })
        .where(and(eq(schema.fields.farmId, ctx().farmId), eq(schema.fields.number, contour.number)));
    }

    const barn = await createFacility({
      type: 'barn',
      name: SEED.facility.barn,
      capacity: 1000,
      capacityUnit: 'bosh',
      boundary: polygon([[130, -130], [250, -130], [250, -185], [130, -185]]),
      notes: "Yopiq turdagi molxona, 1 000 boshgacha.",
    });
    for (const [name, capacity] of [["A bo'lim", 450], ["B bo'lim", 350], ["Karantin bo'limi", 100], ["Qo'zilash bo'limi", 100]] as const) {
      await createFacility({ type: 'barn', name: `${SEED.facility.barn} — ${name}`, capacity, capacityUnit: 'bosh', parentId: barn.id });
    }
    await createFacility({
      type: 'barn',
      name: 'Molxona №2',
      capacity: 800,
      capacityUnit: 'bosh',
      boundary: polygon([[130, -200], [250, -200], [250, -255], [130, -255]]),
      notes: "Qo'zilash va qo'zilarni boqish uchun.",
    });
    await createFacility({
      type: 'feed_storage',
      name: SEED.facility.feedStore,
      capacity: 500,
      capacityUnit: 't',
      boundary: polygon([[265, -200], [330, -200], [330, -255], [265, -255]]),
    });
    await createFacility({
      type: 'warehouse',
      name: SEED.facility.mainStore,
      boundary: polygon([[265, -262], [330, -262], [330, -292], [265, -292]]),
    });
    await createFacility({ type: 'well', name: SEED.facility.well, ...pointOf([300, -180]), notes: 'Chuqurligi 48 m.' });
    await createFacility({ type: 'other', name: SEED.facility.gate, ...pointOf([100, -45]) });
    await createFacility({ type: 'guardhouse', name: 'Qorovulxona', ...pointOf([112, -55]) });
    await createFacility({ type: 'pump', name: 'Nasos stansiyasi', ...pointOf([545, 215]) });
    await createFacility({ type: 'power', name: 'Transformator', ...pointOf([110, -105]) });
    await createFacility({
      type: 'road',
      name: "Ichki yo'l",
      boundary: {
        type: 'LineString',
        coordinates: ([[-62, 152], [0, 0], [335, -173]] as Corner[]).map((corner): [number, number] => {
          const p = pointOf(corner);
          return [p.lng, p.lat];
        }),
      },
    });

    const wheat1 = await findField(SEED.field.wheat1);
    const wheat2 = await findField(SEED.field.wheat2);
    const barley = await findField(SEED.field.barley);
    const alfalfa = await findField(SEED.field.alfalfa);
    const corn = await findField(SEED.field.corn);
    const wheat3 = await findField(SEED.field.wheat3);

    await createIrrigation({
      type: 'canal',
      name: 'Magistral kanal',
      capacityM3h: 400,
      limitM3: 420_000,
      fieldIds: [wheat1.id, wheat2.id, alfalfa.id, corn.id],
      notes: 'Mavsumiy suv limiti taxminiy, aniqlashtiriladi.',
    });
    await createIrrigation({
      type: 'ditch',
      name: 'Ariq №1',
      capacityM3h: 120,
      limitM3: 160_000,
      fieldIds: [barley.id, wheat3.id],
    });
    await createIrrigation({ type: 'pump', name: 'Nasos stansiyasi', capacityM3h: 150, fieldIds: [corn.id] });

    const soil: [string, string, number, number, number, number, number, number][] = [
      [wheat1.id, '2024-09-12', 18, 24, 215, 7.9, 1.05, 0.62],
      [wheat1.id, '2026-09-10', 21, 27, 230, 7.7, 1.18, 0.48],
      [wheat2.id, '2024-09-12', 16, 22, 205, 8.0, 0.98, 0.7],
      [wheat2.id, '2026-09-10', 19, 25, 222, 7.8, 1.1, 0.55],
      [barley.id, '2024-09-13', 14, 19, 190, 8.1, 0.86, 1.12],
      [barley.id, '2026-09-11', 15, 21, 198, 8.0, 0.92, 0.98],
      [alfalfa.id, '2024-09-13', 24, 28, 240, 7.6, 1.32, 0.44],
      [alfalfa.id, '2026-09-11', 27, 30, 248, 7.5, 1.45, 0.4],
      [corn.id, '2026-09-11', 20, 23, 210, 7.4, 1.22, 0.58],
      [wheat3.id, '2024-09-13', 17, 23, 208, 7.9, 1.0, 0.66],
      [wheat3.id, '2026-09-10', 20, 26, 226, 7.8, 1.14, 0.52],
    ];
    for (const [fieldId, date, n, p, k, ph, humus, salinity] of soil) {
      await createSoil(fieldId, { date, n, p, k, ph, humus, salinity, lab: 'Buxoro viloyat agrokimyo laboratoriyasi' });
    }

    const barnFacility = await findFacility(SEED.facility.barn);
    await createDocument({
      type: 'land',
      title: 'Yer ijarasi shartnomasi',
      number: 'IJ-2021/118',
      issueDate: '2021-03-15',
      expiryDate: '2070-03-15',
      notes: '210 ga, shundan 90 ga haydaladigan yer.',
    });
    await createDocument({ type: 'land', title: 'Kadastr ko\'chirmasi', number: '06:11:02:01:0147', issueDate: '2021-04-02' });
    await createDocument({
      type: 'construction',
      title: 'Molxona qurilishiga ruxsatnoma',
      number: 'R-2025/44',
      issueDate: '2025-02-10',
      entityType: 'facility',
      entityId: barnFacility.id,
    });
    await createDocument({
      type: 'permit',
      title: 'Suvdan foydalanish ruxsatnomasi',
      number: 'SV-2024/19',
      issueDate: '2024-12-01',
      expiryDate: addDays(now, 21),
      notes: 'Muddati tugashidan oldin uzaytirish kerak.',
    });
    await createDocument({
      type: 'permit',
      title: 'Veterinariya-sanitariya xulosasi',
      number: 'VS-2025/07',
      issueDate: '2026-10-05',
      expiryDate: addDays(now, 330),
      entityType: 'facility',
      entityId: barnFacility.id,
    });
    await createDocument({
      type: 'permit',
      title: "Import veterinariya sertifikati: 700 bosh qo'y (Tatariston)",
      number: 'VS-RT-2026/312',
      issueDate: '2026-10-12',
      notes: "Rossiya Federatsiyasi, Tatariston Respublikasi veterinariya xizmati.",
    });

    // Best effort: offline seeds simply start with no weather until the job runs.
    await refreshWeather();
  });
}
