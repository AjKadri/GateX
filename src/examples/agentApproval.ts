export const AGENT_APPROVAL_SOURCE = `
machine AgentApproval {
  states IDLE, REQUESTED, APPROVED, USED;
  initial IDLE;
  inputs request, approve, execute, cancel, human_ok, scope_ok;
  outputs permit;
  terminal USED;
  reset_on cancel;

  IDLE -> REQUESTED when request;
  REQUESTED -> APPROVED when approve && human_ok && scope_ok;
  APPROVED -> USED when execute && human_ok && scope_ok emit permit;
}
`;
