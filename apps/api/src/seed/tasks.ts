import { addDays, todayIso } from '@yap/shared';
import { evaluateRules } from '../modules/alerts/rules';
import { sendDailySummary } from '../modules/notifications/jobs';
import { createEvent } from '../modules/tasks/calendar.service';
import { complete, create, start, type TaskInput } from '../modules/tasks/tasks.service';
import { findField, findHerd } from './lookup';
import { SEED } from './names';
import type { SeedContext } from './types';

const task = (i: Partial<TaskInput> & { title: string }): TaskInput => ({
  priority: 'normal',
  recurrence: 'none',
  requiresPhoto: false,
  ...i,
});

export async function seedTasks(s: SeedContext): Promise<void> {
  const today = todayIso();

  await s.run(async () => {
    const herd = await findHerd(SEED.herd.pregnant);
    const wheat = await findField(SEED.field.wheat1);

    // Recurring work (spec 17.2). Creating a series also creates today's task.
    await create(
      task({
        title: 'Ertalabki ozuqa berish',
        description: "Ratsion bo'yicha ozuqa bering va kunlik qaydni kiriting.",
        recurrence: 'daily',
        dueDate: addDays(today, -14),
        assigneeUserId: s.users.shepherd,
        priority: 'high',
        division: 'livestock',
        entityType: 'herd',
        entityId: herd.id,
      }),
    );
    await create(
      task({
        title: 'Molxonani tozalash',
        description: "Oxur va suv idishlarini ham tozalang. Tugagach foto yuboring.",
        recurrence: 'weekly',
        dueDate: addDays(today, -7),
        assigneeUserId: s.users.shepherd,
        division: 'livestock',
        entityType: 'herd',
        entityId: herd.id,
        requiresPhoto: true,
      }),
    );

    // Closes only with a health record (spec 17.2).
    await create(
      task({
        title: 'Enterotoksemiyaga qarshi emlash',
        description: 'Podani emlang va veterinariya jurnaliga yozing. Vazifa shu qayd bilan yopiladi.',
        dueDate: addDays(today, 5),
        assigneeUserId: s.users.veterinarian,
        priority: 'high',
        division: 'livestock',
        entityType: 'herd',
        entityId: herd.id,
        requiresRecord: 'health_record',
      }),
    );

    // Overdue, so that the board, the alert and the calendar all have something real to show.
    await create(
      task({
        title: "Molxona darvozasini ta'mirlash",
        description: "Sharnir bo'shagan, darvoza to'liq yopilmayapti.",
        dueDate: addDays(today, -3),
        assigneeUserId: s.users.mechanic,
        division: 'machinery',
      }),
    );

    const irrigation = await create(
      task({
        title: "Bug'doy dalasini sug'orish",
        dueDate: addDays(today, 1),
        assigneeUserId: s.users.agronomist,
        division: 'crops',
        entityType: 'field',
        entityId: wheat.id,
      }),
    );
    await start(irrigation.id);

    await create(
      task({
        title: 'Ozuqa omborida inventarizatsiya',
        dueDate: addDays(today, 10),
        assigneeUserId: s.users.storekeeper,
        division: 'admin',
      }),
    );
    await create(
      task({
        title: "Sovliqlarni karantin qaydi bo'yicha tekshirish",
        dueDate: today,
        assigneeUserId: s.users.zootechnician,
        division: 'livestock',
        priority: 'high',
      }),
    );

    const done = await create(
      task({
        title: "Kunjara yetkazib beruvchi bilan narxni kelishish",
        dueDate: addDays(today, -1),
        assigneeUserId: s.users.director,
        division: 'admin',
      }),
    );
    await complete(done.id, { note: 'Narx kelishildi' });

    await createEvent({
      title: 'Kunjara yetkazib berish',
      kind: 'delivery',
      date: addDays(today, 3),
      division: 'livestock',
      responsibleUserId: s.users.storekeeper,
      notes: '10 tonna, Buxoro Yem Savdo',
    });
    await createEvent({
      title: 'Tuman veterinariya bo\'limi tekshiruvi',
      kind: 'inspection',
      date: addDays(today, 9),
      division: 'livestock',
      responsibleUserId: s.users.veterinarian,
    });
    await createEvent({
      title: 'Investorlar bilan oylik uchrashuv',
      kind: 'meeting',
      date: addDays(today, 14),
      division: 'admin',
      responsibleUserId: s.users.owner,
    });
    await createEvent({
      title: "Qo'zilashga tayyorgarlik yig'ilishi",
      kind: 'meeting',
      date: addDays(today, 21),
      endDate: addDays(today, 22),
      division: 'livestock',
      responsibleUserId: s.users.zootechnician,
    });
  }, 'director');

  // Last, so that the demo opens with alerts drawn from everything seeded so far.
  await s.run(async () => {
    const result = await evaluateRules();
    await sendDailySummary();
    const failed = result.failedRules.length > 0 ? `, failed rules: ${result.failedRules.join(', ')}` : '';
    console.log(`  alerts raised: ${result.raised}${failed}`);
  });
}
