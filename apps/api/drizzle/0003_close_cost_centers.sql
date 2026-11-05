-- Archiving a herd and writing off a machine used to leave their cost centers active, so closed
-- records could still be chosen. The services do this now; this closes the ones already there.
UPDATE cost_centers cc SET active = false
FROM herds h
WHERE cc.type = 'herd' AND cc.ref_id = h.id AND h.status = 'archived' AND cc.active;
--> statement-breakpoint
UPDATE cost_centers cc SET active = false
FROM assets a
WHERE cc.type = 'asset' AND cc.ref_id = a.id AND a.status = 'written_off' AND cc.active;
