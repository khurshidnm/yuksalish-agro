/**
 * What the model can do with farm records: prepare a draft, or cancel one. There is no confirm tool.
 * Each draft tool is offered only to a person who holds what the owning module's own screen asks for
 * (`FARM_RULES`), in a module that is switched on.
 */
import { z } from 'zod';
import type { AiTool, ToolEnv, ToolOutcome } from '../tools';
import { cancelFarmDraft, saveFarmDraft, type FarmDraftOutcome } from './farm-service';
import type { FarmInput } from './farm-types';
import { FARM_RULES, type FarmRecordKind } from './routing';
import type { DraftEnv } from './types';

const date = z.string().optional().describe('YYYY-MM-DD. Leave out for today. Work out kecha, вчера and the like from the date in the context.');
const tag = z.string().optional().describe("The animal's tag number exactly as the person said it. Never a head count, never a guess.");
const proposalId = z.uuid().optional().describe('Only to correct an open farm card of this conversation: that card\'s id.');

function outcome(result: FarmDraftOutcome): ToolOutcome {
  if (result.status === 'needs_info') {
    const [first] = result.questions;
    return {
      data: { status: 'needs_info', ask: first.hint, field: first.field, code: first.code, options: first.options, stillMissing: result.questions.length },
      tables: ['ai_proposals'],
      attachments: [{ type: 'question', question: first }],
    };
  }
  return {
    data: { status: 'ready', proposalId: result.proposal.id, note: 'A card with Confirm and Cancel buttons is now shown. Do not list its fields. Say in one short sentence that it needs their confirmation.' },
    tables: ['ai_proposals'],
    attachments: [{ type: 'farm_proposal', proposal: result.proposal }],
  };
}

function draftTool(name: string, description: string, kind: FarmRecordKind, input: z.ZodObject): AiTool {
  return {
    name,
    description,
    input: input.extend({ proposalId }),
    anyOf: FARM_RULES[kind].create,
    allOf: FARM_RULES[kind].create,
    money: false,
    writes: true,
    run: (async ({ proposalId: card, ...data }: FarmInput & { proposalId?: string }, env: ToolEnv): Promise<ToolOutcome> =>
      outcome(await saveFarmDraft(kind, data, env.draft as DraftEnv, card))) as never,
  };
}

const DRAFTS: Record<FarmRecordKind, AiTool> = {
  weight: draftTool(
    'draft_weight',
    'Draft the weighing of one animal: "1234-qo\'y 46 kilo chiqdi". One call per animal.',
    'weight',
    z.object({
      tag,
      weightKg: z.number().optional().describe('The weight in kilograms as they said it. Omit it if unstated: code reads it from their words.'),
      date,
    }),
  ),
  death: draftTool(
    'draft_death',
    'Draft the death of one animal: "bugun 0567 raqamli qo\'y o\'ldi, ichi ketgan". One call per animal. Only when they say it died: a sick or missing animal is not a death.',
    'death',
    z.object({
      tag,
      cause: z.string().optional().describe('What they said it died of, in their own words, copied exactly. Omit it if they gave no cause. Never a summary or a diagnosis of your own.'),
      date,
    }),
  ),
  treatment: draftTool(
    'draft_treatment',
    'Draft a treatment, vaccination or deworming that was given: "0567 ga 5 ml ivermektin qildim", "1-otarni emladik, 300 doza ketdi". One call per animal, or one for a whole herd. Not for an animal that is only sick: nothing was given yet.',
    'treatment',
    z.object({
      tag,
      herd: z.string().optional().describe('Only when a whole herd was treated: the herd as they named it. Leave out when one animal was treated.'),
      drug: z.string().optional().describe('The drug or vaccine as they named it, copied exactly. Never one you think it was.'),
      qty: z.number().optional().describe('How much was used, as they said it. Omit it if unstated. Never convert ml into vials or doses.'),
      unit: z.string().optional().describe('The unit they said with that quantity: ml, doza, flakon.'),
      cause: z.string().optional().describe('What it was for, in their own words, copied exactly. Omit it if they did not say.'),
      date,
    }),
  ),
  herd_log: draftTool(
    'draft_herd_log',
    'Draft what a herd was fed on one day: "bugun 1-otarga 300 kilo beda berdim". One call per herd and day, with every feed they named in it: it becomes that herd\'s record for the day. Only feed that was given, not feed bought or planned.',
    'herd_log',
    z.object({
      herd: z.string().optional().describe('The herd as they named it. Omit it if they named none: never choose one yourself.'),
      feeds: z
        .array(
          z.object({
            feed: z.string().describe('The feed as they named it, copied exactly.'),
            qty: z.number().optional().describe('How much of this feed, as they said it. Omit it if unstated.'),
            unit: z.string().optional().describe('The unit they said with it: kilo, tonna, toy.'),
          }),
        )
        .min(1)
        .max(10)
        .describe('Each feed that was given, with its own amount.'),
      date,
    }),
  ),
};

export const FARM_DRAFT_TOOLS = new Set(Object.values(DRAFTS).map((tool) => tool.name));
export const CANCEL_FARM_DRAFT = 'cancel_farm_draft';

export const FARM_TOOLS: AiTool[] = [
  ...Object.values(DRAFTS),
  {
    name: CANCEL_FARM_DRAFT,
    description: 'Cancel a pending farm-record draft when the person says to.',
    input: z.object({ proposalId: z.uuid() }),
    // Whoever may draft one kind may cancel their own card.
    anyOf: [...new Set(Object.values(FARM_RULES).flatMap((rule) => rule.create))],
    money: false,
    writes: true,
    run: (async ({ proposalId: id }: { proposalId: string }, env: ToolEnv): Promise<ToolOutcome> => {
      const draft = env.draft as DraftEnv;
      const kind = await cancelFarmDraft(id, draft.conversationId, (draft.own ?? draft).userTexts.at(-1) ?? '');
      if (!kind) return { data: { status: 'not_cancelled', note: 'They did not ask to cancel this. It stays open.' }, tables: ['ai_proposals'] };
      return {
        data: { status: 'cancelled' },
        tables: ['ai_proposals'],
        events: [{ type: 'ai_proposal.rejected', entityType: 'ai_proposal', entityId: id, data: { kind, by: 'chat' } }],
      };
    }) as never,
  },
];
