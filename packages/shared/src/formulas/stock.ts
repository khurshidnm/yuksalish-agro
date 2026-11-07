import { round, type BatchConsumption, type BatchLike, type ConsumptionResult } from './index';

/**
 * Average costing. `qty` leaves every batch in proportion to what it holds, each part at its
 * batch's own cost. The mix in stock stays the same, so the average does too, and what stays is
 * worth exactly what it was worth less what left. Parts keep three decimals, like the quantity
 * columns, so a batch too small to give up 0.001 sits this one out.
 */
export function consumeInProportion(batches: BatchLike[], qty: number): ConsumptionResult {
  const wanted = round(qty, 3);
  const held = round(batches.reduce((sum, b) => sum + b.qtyRemaining, 0), 3);
  const lines: BatchConsumption[] = [];
  let toPlace = Math.min(wanted, held);
  let stillHeld = held;
  let totalCost = 0;

  for (const batch of batches) {
    if (batch.qtyRemaining <= 0) continue;
    // Worked out from what is still to place, so rounding can never leave any of it behind.
    const take = round((toPlace * batch.qtyRemaining) / stillHeld, 3);
    toPlace = round(toPlace - take, 3);
    stillHeld = round(stillHeld - batch.qtyRemaining, 3);
    if (take <= 0) continue;
    lines.push({ batchId: batch.id, qty: take, unitCost: batch.unitCost });
    totalCost += take * batch.unitCost;
  }
  return { lines, totalCost: round(totalCost, 2), shortage: Math.max(round(wanted - held, 3), 0) };
}
