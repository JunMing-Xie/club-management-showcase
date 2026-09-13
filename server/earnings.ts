/** Ledger amounts stay immutable; every current earning is derived from its deltas. */
export type EarningSource = { actualEarningCents: number; earningAdjustments?: ReadonlyArray<{ earningDeltaCents: number }> }

export const currentActualEarning = (assignment: EarningSource) =>
  assignment.actualEarningCents + (assignment.earningAdjustments ?? []).reduce((sum, item) => sum + item.earningDeltaCents, 0)

export const currentStaffEarningTotal = (assignments: ReadonlyArray<EarningSource>) =>
  assignments.reduce((sum, assignment) => sum + currentActualEarning(assignment), 0)

export const settlementBalance = (earnedCents: number, settledCents: number) => ({
  pendingSettlementCents: Math.max(earnedCents - settledCents, 0),
  overSettledCents: Math.max(settledCents - earnedCents, 0),
})

/** Display-only FIFO allocation. SettlementRecord has no order/assignment foreign key. */
export const allocateSettlements = <T extends EarningSource>(assignments: T[], settledCents: number) => {
  let remaining = settledCents
  return assignments.map((assignment) => {
    const currentActualEarningCents = currentActualEarning(assignment)
    const allocatedSettlementCents = Math.min(Math.max(currentActualEarningCents, 0), Math.max(remaining, 0))
    remaining -= allocatedSettlementCents
    return { ...assignment, currentActualEarningCents, allocatedSettlementCents, ...settlementBalance(currentActualEarningCents, allocatedSettlementCents) }
  })
}
