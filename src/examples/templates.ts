// Starting points for the workspace. None of these is on chain: they are ordinary sources written in the GateX language.
// Each one stays within 8 inputs, 8 states and 4 outputs, and each is checked in tests/exhaustive.test.ts.

export const TWO_PERSON_APPROVAL_SOURCE = `
machine TwoPersonApproval {
  states IDLE, REQUESTED, SIGNED_A, SIGNED_B, APPROVED, EXECUTED;
  initial IDLE;
  inputs request, approve_a, approve_b, execute, cancel;
  outputs run;
  terminal EXECUTED;
  reset_on cancel;

  IDLE -> REQUESTED when request;
  REQUESTED -> SIGNED_A when approve_a && !approve_b;
  REQUESTED -> SIGNED_B when approve_b && !approve_a;
  REQUESTED -> APPROVED when approve_a && approve_b;
  SIGNED_A -> APPROVED when approve_b;
  SIGNED_B -> APPROVED when approve_a;
  APPROVED -> EXECUTED when execute emit run;
}
`;

export const SPENDING_LIMIT_SOURCE = `
machine SpendingLimit {
  states IDLE, SMALL, LARGE, OWNER_SIGNED, APPROVED, PAID;
  initial IDLE;
  inputs request, over_limit, owner_ok, admin_ok, execute, cancel;
  outputs pay;
  terminal PAID;
  reset_on cancel;

  IDLE -> SMALL when request && !over_limit;
  IDLE -> LARGE when request && over_limit;
  SMALL -> APPROVED when owner_ok;
  LARGE -> APPROVED when owner_ok && admin_ok;
  LARGE -> OWNER_SIGNED when owner_ok && !admin_ok;
  OWNER_SIGNED -> APPROVED when admin_ok;
  APPROVED -> PAID when execute emit pay;
}
`;

export const ESCROW_RELEASE_SOURCE = `
machine EscrowRelease {
  states OPEN, FUNDED, DELIVERED, DISPUTED, RELEASED, REFUNDED;
  initial OPEN;
  inputs fund, deliver, buyer_ok, dispute, arbiter_refund, cancel;
  outputs release, refund;
  terminal RELEASED, REFUNDED;
  reset_on cancel;

  OPEN -> FUNDED when fund;
  FUNDED -> DELIVERED when deliver && !dispute;
  FUNDED -> DISPUTED when dispute;
  DELIVERED -> RELEASED when buyer_ok && !dispute emit release;
  DELIVERED -> DISPUTED when dispute;
  DISPUTED -> REFUNDED when arbiter_refund emit refund;
}
`;

export const TIMEBOXED_PERMIT_SOURCE = `
machine TimeboxedPermit {
  states IDLE, GRANTED, USED, EXPIRED;
  initial IDLE;
  inputs grant, use, expired, cancel;
  outputs permit;
  terminal USED, EXPIRED;
  reset_on cancel;

  IDLE -> GRANTED when grant;
  GRANTED -> USED when use && !expired emit permit;
  GRANTED -> EXPIRED when expired;
}
`;

export interface TemplateDefinition {
  key: "two-person" | "spending-limit" | "escrow" | "permit";
  name: string;
  blurb: string;
  source: string;
}

export const TEMPLATES: readonly TemplateDefinition[] = [
  { key: "two-person", name: "TwoPersonApproval", blurb: "Two different approvers before it can run", source: TWO_PERSON_APPROVAL_SOURCE.trim() },
  { key: "spending-limit", name: "SpendingLimit", blurb: "Owner under the limit, owner and admin over it", source: SPENDING_LIMIT_SOURCE.trim() },
  { key: "escrow", name: "EscrowRelease", blurb: "Fund, deliver, release, or dispute and refund by the arbiter", source: ESCROW_RELEASE_SOURCE.trim() },
  { key: "permit", name: "TimeboxedPermit", blurb: "Use a permit once, or it expires", source: TIMEBOXED_PERMIT_SOURCE.trim() }
];
