export const TINY_APPROVAL_SOURCE = `
machine TinyApproval {
  state LOCKED;
  state READY;
  state USED terminal;

  initial LOCKED;
  reset reset;

  input authorize;
  input execute;
  input reset;

  output authorized;

  transition LOCKED -> READY when authorize && !execute && !reset;
  transition LOCKED -> LOCKED when !authorize || execute || reset;

  transition READY -> LOCKED when reset;
  transition READY -> USED when execute && !reset;
  transition READY -> READY when !execute && !reset;

  transition USED -> LOCKED when reset;
  transition USED -> USED when !reset;

  emit authorized = state == READY && execute && !reset;
}
`;

