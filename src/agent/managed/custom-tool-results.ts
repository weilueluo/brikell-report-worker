export type ManagedCustomToolUseEvent = {
  id: string;
  name?: string;
  input?: unknown;
};

export type RequiredCustomToolUseSelection = {
  requiredIds: string[];
  selected: ManagedCustomToolUseEvent[];
  missingIds: string[];
};

type RequiresActionEventLike = {
  stop_reason?: {
    type?: string;
    event_ids?: unknown;
  };
};

export function requiredCustomToolUseIds(event: unknown): string[] {
  const stopReason = (event as RequiresActionEventLike | null | undefined)?.stop_reason;
  if (stopReason?.type !== "requires_action" || !Array.isArray(stopReason.event_ids)) return [];
  return stopReason.event_ids.filter((id): id is string => typeof id === "string" && id.length > 0);
}

export function selectRequiredCustomToolUses(
  event: unknown,
  pendingCustomToolUses: ReadonlyMap<string, ManagedCustomToolUseEvent>,
): ManagedCustomToolUseEvent[] {
  return selectRequiredCustomToolUseEvents(event, pendingCustomToolUses).selected;
}

export function selectRequiredCustomToolUseEvents(
  event: unknown,
  pendingCustomToolUses: ReadonlyMap<string, ManagedCustomToolUseEvent>,
): RequiredCustomToolUseSelection {
  const stopReason = (event as RequiresActionEventLike | null | undefined)?.stop_reason;
  if (stopReason?.type !== "requires_action") return { requiredIds: [], selected: [], missingIds: [] };
  const requiredIds = requiredCustomToolUseIds(event);
  const idsToSend = requiredIds.length > 0 ? requiredIds : [...pendingCustomToolUses.keys()];
  const selected: ManagedCustomToolUseEvent[] = [];
  const missingIds: string[] = [];
  for (const id of idsToSend) {
    const customToolUse = pendingCustomToolUses.get(id);
    if (customToolUse === undefined) {
      missingIds.push(id);
      continue;
    }
    selected.push(customToolUse);
  }
  return { requiredIds: idsToSend, selected, missingIds };
}
