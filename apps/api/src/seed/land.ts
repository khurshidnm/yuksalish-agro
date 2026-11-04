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
 * Layout of the 210 ha in metres, x east and y north, measured from the south-west corner.
 * The real contours do not exist yet (spec 6.2 and 25.4 leave them open), so this plan only has
 * to be plausible and add up. It sits on the irrigated land south of Qorovulbozor town, so that
 * the demo does not draw fields over houses. Replace it by drawing on the map.
 */
const ORIGIN = { lng: 64.79, lat: 39.4815, x: 1060, y: 525 };

/** Metres per degree at latitude 39.5 on the WGS84 spheroid. */
const M_PER_DEG_LNG = 86_013;
const M_PER_DEG_LAT = 111_025;

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

const OPEN_QUESTION = "Ochiq savol (6.2-band): chegara va maydon taxminiy, aniqlashtiriladi.";

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
    name: 'Shimoliy dala',
    landUse: 'arable',
    areaHa: 20,
    corners: [[0, 640], [500, 640], [505, 1040], [5, 1040]],
    soilType: "O'tloqi-bo'z",
    salinityLevel: 'low',
    irrigationSource: 'Magistral kanal',
  },
  {
    number: SEED.field.wheat2,
    name: "O'rta dala",
    landUse: 'arable',
    areaHa: 15,
    corners: [[0, 330], [500, 330], [500, 630], [0, 630]],
    soilType: "O'tloqi-bo'z",
    salinityLevel: 'low',
    irrigationSource: 'Magistral kanal',
  },
  {
    number: SEED.field.barley,
    name: 'Janubiy dala',
    landUse: 'arable',
    areaHa: 15,
    corners: [[0, 20], [495, 20], [500, 320], [0, 320]],
    soilType: "Bo'z tuproq",
    salinityLevel: 'medium',
    irrigationSource: 'Ariq №1',
  },
  {
    number: SEED.field.alfalfa,
    name: 'Beda dalasi',
    landUse: 'arable',
    areaHa: 12,
    corners: [[510, 730], [910, 730], [905, 1040], [515, 1040]],
    soilType: "O'tloqi",
    salinityLevel: 'low',
    irrigationSource: 'Ariq №1',
  },
  {
    number: SEED.field.rice,
    name: 'Sholipoya',
    landUse: 'arable',
    areaHa: 8,
    corners: [[510, 520], [910, 520], [910, 720], [510, 720]],
    soilType: "O'tloqi-botqoq",
    salinityLevel: 'low',
    irrigationSource: 'Magistral kanal',
  },
  {
    number: SEED.field.yard,
    name: 'Molxona va hovli',
    landUse: 'yard',
    areaHa: 6,
    corners: [[510, 300], [810, 300], [810, 500], [510, 500]],
    notes: OPEN_QUESTION,
  },
  {
    number: SEED.field.infrastructure,
    name: "Yo'llar, suv, elektr",
    landUse: 'infrastructure',
    areaHa: 4,
    corners: [[510, 90], [710, 90], [710, 290], [510, 290]],
    notes: OPEN_QUESTION,
  },
  {
    number: SEED.field.reserve,
    name: 'Zaxira hududi',
    landUse: 'reserve',
    areaHa: 20,
    corners: [[720, 10], [1200, 10], [1200, 510], [820, 510], [820, 290], [720, 290]],
    notes: OPEN_QUESTION,
  },
  {
    number: SEED.field.pasture,
    name: 'Yaylov',
    landUse: 'pasture',
    areaHa: 110,
    corners: [[920, 520], [1210, 520], [1210, 0], [2120, 0], [2120, 1050], [920, 1050]],
    notes: OPEN_QUESTION,
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
        notes: `${OPEN_QUESTION} 140 ga qoldiq maydonning taqsimoti (yaylov, qurilish, zaxira) hali tasdiqlanmagan.`,
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
      boundary: polygon([[540, 400], [720, 400], [720, 460], [540, 460]]),
      notes: "Yopiq turdagi molxona, 1 000 boshgacha.",
    });
    for (const [name, capacity] of [["A bo'lim", 500], ["B bo'lim", 300], ["Karantin bo'limi", 100], ["Qo'zilash bo'limi", 100]] as const) {
      await createFacility({ type: 'barn', name: `${SEED.facility.barn} — ${name}`, capacity, capacityUnit: 'bosh', parentId: barn.id });
    }
    await createFacility({
      type: 'feed_storage',
      name: SEED.facility.feedStore,
      capacity: 500,
      capacityUnit: 't',
      boundary: polygon([[540, 320], [640, 320], [640, 380], [540, 380]]),
    });
    await createFacility({
      type: 'warehouse',
      name: SEED.facility.mainStore,
      boundary: polygon([[660, 320], [720, 320], [720, 370], [660, 370]]),
    });
    await createFacility({ type: 'well', name: SEED.facility.well, ...pointOf([760, 420]), notes: 'Chuqurligi aniqlashtiriladi.' });
    await createFacility({ type: 'other', name: SEED.facility.gate, ...pointOf([515, 300]) });
    await createFacility({ type: 'guardhouse', name: 'Qorovulxona', ...pointOf([530, 310]) });
    await createFacility({ type: 'pump', name: 'Nasos stansiyasi', ...pointOf([505, 700]) });
    await createFacility({ type: 'power', name: 'Transformator', ...pointOf([600, 290]) });
    await createFacility({
      type: 'road',
      name: "Ichki yo'l",
      boundary: {
        type: 'LineString',
        coordinates: ([[0, 635], [505, 635], [505, 300], [810, 300]] as Corner[]).map((corner): [number, number] => {
          const p = pointOf(corner);
          return [p.lng, p.lat];
        }),
      },
    });

    const wheat1 = await findField(SEED.field.wheat1);
    const wheat2 = await findField(SEED.field.wheat2);
    const barley = await findField(SEED.field.barley);
    const alfalfa = await findField(SEED.field.alfalfa);
    const rice = await findField(SEED.field.rice);

    await createIrrigation({
      type: 'canal',
      name: 'Magistral kanal',
      capacityM3h: 400,
      limitM3: 180_000,
      fieldIds: [wheat1.id, wheat2.id, rice.id],
      notes: 'Mavsumiy suv limiti taxminiy, aniqlashtiriladi.',
    });
    await createIrrigation({
      type: 'ditch',
      name: 'Ariq №1',
      capacityM3h: 120,
      limitM3: 90_000,
      fieldIds: [barley.id, alfalfa.id],
    });
    await createIrrigation({ type: 'pump', name: 'Nasos stansiyasi', capacityM3h: 150, fieldIds: [rice.id] });

    const soil: [string, string, number, number, number, number, number, number][] = [
      [wheat1.id, '2024-09-12', 18, 24, 215, 7.9, 1.05, 0.62],
      [wheat1.id, '2026-09-10', 21, 27, 230, 7.7, 1.18, 0.48],
      [wheat2.id, '2024-09-12', 16, 22, 205, 8.0, 0.98, 0.7],
      [wheat2.id, '2026-09-10', 19, 25, 222, 7.8, 1.1, 0.55],
      [barley.id, '2024-09-13', 14, 19, 190, 8.1, 0.86, 1.12],
      [barley.id, '2026-09-11', 15, 21, 198, 8.0, 0.92, 0.98],
      [alfalfa.id, '2024-09-13', 24, 28, 240, 7.6, 1.32, 0.44],
      [alfalfa.id, '2026-09-11', 27, 30, 248, 7.5, 1.45, 0.4],
      [rice.id, '2026-09-11', 20, 23, 210, 7.4, 1.22, 0.58],
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
      notes: '210 ga. Maydon taqsimoti aniqlashtiriladi.',
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
      issueDate: '2025-10-20',
      expiryDate: addDays(now, -6),
      entityType: 'facility',
      entityId: barnFacility.id,
    });

    // Best effort: offline seeds simply start with no weather until the job runs.
    await refreshWeather();
  });
}
